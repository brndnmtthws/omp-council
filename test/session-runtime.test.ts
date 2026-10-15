import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, AssistantMessage, Context, Model, ModelSpec, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { clearCustomApis, registerCustomApi } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type } from "@oh-my-pi/omptype";
import { createSessionRuntimeFactory } from "../src/session-runtime";
import { COUNCIL_MEMBER_TOOL_NAMES, councilMemberToolkit } from "../src/tools";
import type {
	CouncilActionApi,
	CouncilActivity,
	CouncilMemberInfo,
	CouncilRuntimeHooks,
	CouncilUsage,
	ResolvedCouncilMember,
} from "../src/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const API = "test-council-session-runtime";
// ast_grep is opt-in (`astGrep.enabled` defaults off); enable it to assert the full inspection set.
const BASE_SETTINGS = { "compaction.enabled": false, "astGrep.enabled": true } as const;

type Reply = (context: Context, options: SimpleStreamOptions | undefined) => AssistantMessage | "hang";

let replies: Reply[] = [];
const contexts: Context[] = [];

function reply(message: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: API,
		provider: "managed-primary",
		model: "council-fake",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...message,
	};
}

function recordingHooks(): CouncilRuntimeHooks & { activity: CouncilActivity[]; usage: CouncilUsage[] } {
	const activity: CouncilActivity[] = [];
	const usage: CouncilUsage[] = [];
	return {
		activity,
		usage,
		onActivity: entry => activity.push(entry),
		onUsage: entry => usage.push(entry),
	};
}

function recordingActions(): CouncilActionApi & { calls: string[] } {
	const calls: string[] = [];
	const ok = (name: string) => {
		calls.push(name);
		return { ok: true as const, message: `${name} ok`, ref: "P1" };
	};
	return {
		calls,
		propose: () => ok("propose"),
		revise: () => ok("revise"),
		challenge: () => ok("challenge"),
		respond: () => ok("respond"),
		resolve: () => ok("resolve"),
		withdraw: () => ok("withdraw"),
		accept: () => ({ ok: false, error: "Version 1 is stale; current is v2." }),
		verify: () => ok("verify"),
		view: ref => `state ${ref ?? ""}`.trim(),
	};
}

describe("council session runtime", () => {
	let root: string;
	let project: string;
	let model: Model<Api>;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const agentIds: string[] = [];

	beforeAll(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-council-runtime-"));
		project = path.join(root, "project");
		await Bun.write(path.join(project, "a.txt"), "alpha\n");

		model = buildModel({
			id: "council-fake",
			name: "Council fake",
			api: API,
			provider: "managed-primary",
			baseUrl: "http://127.0.0.1:9/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32_000,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
		authStorage = await AuthStorage.create(path.join(root, "auth.db"));
		authStorage.keys.setRuntime(model.provider, "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
	});

	afterEach(() => {
		clearCustomApis();
		replies = [];
		contexts.length = 0;
		for (const id of agentIds.splice(0)) AgentRegistry.global().unregister(id);
	});

	afterAll(async () => {
		authStorage.close();
		await removeWithRetries(root);
	});

	function installProvider(): void {
		registerCustomApi(API, (_model, context, options) => {
			const stream = new AssistantMessageEventStream();
			// Auxiliary requests (e.g. title generation) carry no tools; only council
			// turns consume the scripted replies.
			const scripted = (context.tools?.length ?? 0) > 0;
			if (scripted) contexts.push(context);
			const next = scripted ? replies.shift() : undefined;
			const message = next ? next(context, options) : reply({ content: [{ type: "text", text: "idle" }] });
			if (message === "hang") {
				options?.signal?.addEventListener(
					"abort",
					() => stream.push({ type: "error", reason: "aborted", error: reply({ stopReason: "aborted" }) }),
					{ once: true },
				);
				return stream;
			}
			queueMicrotask(() => {
				if (message.stopReason === "error") {
					stream.push({ type: "error", reason: "error", error: message });
					return;
				}
				stream.push({ type: "start", partial: message });
				// The agent loop only executes tool calls that completed on the wire.
				message.content.forEach((block, contentIndex) => {
					if (block.type !== "toolCall") return;
					stream.push({ type: "toolcall_start", contentIndex, partial: message });
					stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: message });
				});
				stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
			});
			return stream;
		});
	}

	function member(id: string): ResolvedCouncilMember {
		const agentId = `Council-${id}-${Bun.randomUUIDv7().slice(-8)}`;
		agentIds.push(agentId);
		return { id, name: id.toUpperCase(), model: "managed-primary/council-fake", agentId, modelRef: model };
	}

	function toolNames(context: Context | undefined): string[] {
		return (context?.tools ?? []).map(tool => tool.name).sort();
	}

	function factoryFor(members: ResolvedCouncilMember[]) {
		return createSessionRuntimeFactory({
			cwd: project,
			settings: Settings.isolated(BASE_SETTINGS),
			modelRegistry,
			members,
			memberTools: councilMemberToolkit(type),
			sessionDir: path.join(root, "sessions"),
		});
	}

	it("runs a member with the exact tool set, evidence trail, hooks, and parked disposal", async () => {
		installProvider();
		const alpha = member("alpha");
		const factory = factoryFor([alpha, member("beta")]);
		const actions = recordingActions();
		const hooks = recordingHooks();
		const runtime = await factory.createMember(alpha satisfies CouncilMemberInfo, actions, hooks);

		replies.push(() =>
			reply({
				content: [
					{ type: "toolCall", id: "call-read", name: "read", arguments: { path: "a.txt" } },
					{ type: "toolCall", id: "call-bash", name: "bash", arguments: { command: "exit 3" } },
					{
						type: "toolCall",
						id: "call-propose",
						name: "council_propose",
						arguments: {
							title: "t",
							summary: "s",
							solution: "x",
							evidence: "e",
							tradeoffs: "o",
							implementation: "i",
						},
					},
					{
						type: "toolCall",
						id: "call-accept",
						name: "council_accept",
						arguments: { proposal: "P1", version: 1, rationale: "x".repeat(40) },
					},
				],
				stopReason: "toolUse",
				usage: {
					input: 100,
					output: 20,
					cacheRead: 500,
					cacheWrite: 7,
					totalTokens: 627,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
				},
			}),
		);
		replies.push(() => reply({ content: [{ type: "text", text: "Final word." }] }));

		const result = await runtime.runTurn("Analyse the problem.");
		expect(result.error).toBeUndefined();
		expect(result.aborted).toBeUndefined();
		expect(result.text).toBe("Final word.");
		// Council actions stay out of the evidence trail; a failed command is flagged.
		expect(result.tools.map(tool => tool.tool)).toEqual(["read", "bash"]);
		expect(result.tools[0]).toEqual({ tool: "read", args: "a.txt" });
		expect(result.tools[1]?.error).toBe(true);
		expect(actions.calls).toEqual(["propose"]);

		expect(toolNames(contexts[0])).toEqual(
			["read", "grep", "glob", "ast_grep", "web_search", "bash", ...COUNCIL_MEMBER_TOOL_NAMES].sort(),
		);
		const systemPrompt = contexts[0]?.systemPrompt?.join("\n") ?? "";
		expect(systemPrompt).toContain("You are ALPHA");
		expect(systemPrompt).toContain("- BETA (managed-primary/council-fake)");

		// Tool results the model saw: ledger rejection is a tool error, success carries the ref.
		const toolResults = contexts[1]?.messages.filter(message => message.role === "toolResult") ?? [];
		const proposeResult = toolResults.find(message => message.toolCallId === "call-propose");
		const acceptResult = toolResults.find(message => message.toolCallId === "call-accept");
		expect(proposeResult?.isError).toBeFalsy();
		expect(JSON.stringify(proposeResult?.content)).toContain("propose ok (P1)");
		expect(acceptResult?.isError).toBe(true);
		expect(JSON.stringify(acceptResult?.content)).toContain("current is v2");

		// Cache reads are excluded from the token count.
		expect(hooks.usage.at(-1)).toEqual({ tokens: 127, cost: 0.25 });
		const states = hooks.activity.map(entry => entry.state);
		expect(states).toContain("thinking");
		expect(states).toContain("tool");
		expect(states.at(-1)).toBe("idle");
		expect(hooks.activity.find(entry => entry.tool === "read")?.detail).toBe("a.txt");
		expect(hooks.activity.at(-1)?.toolCount).toBe(4);

		await runtime.dispose();
		await runtime.dispose();
		// Parked, not unregistered: `history://<agentId>` keeps resolving after the run.
		const ref = AgentRegistry.global().get(alpha.agentId);
		expect(ref?.status).toBe("parked");
		expect(ref?.session).toBeNull();
		expect(await Bun.file(path.join(root, "sessions", `${alpha.agentId}.jsonl`)).exists()).toBe(true);
	});

	it("reports provider errors as a failed turn without throwing", async () => {
		installProvider();
		const gamma = member("gamma");
		const hooks = recordingHooks();
		const runtime = await factoryFor([gamma, member("delta")]).createMember(gamma, recordingActions(), hooks);
		replies.push(() => reply({ content: [], stopReason: "error", errorMessage: "provider exploded" }));
		const result = await runtime.runTurn("Go.");
		expect(result.error).toContain("provider exploded");
		expect(result.aborted).toBeUndefined();
		expect(hooks.activity.at(-1)?.state).toBe("failed");
		await runtime.dispose();
	});

	it("aborts an in-flight turn and reports it as aborted", async () => {
		installProvider();
		const epsilon = member("epsilon");
		const runtime = await factoryFor([epsilon, member("zeta")]).createMember(
			epsilon,
			recordingActions(),
			recordingHooks(),
		);
		const started = Promise.withResolvers<void>();
		replies.push(() => {
			started.resolve();
			return "hang";
		});
		const turn = runtime.runTurn("Think forever.");
		await started.promise;
		await runtime.abort();
		await runtime.abort();
		const result = await turn;
		expect(result.aborted).toBe(true);
		expect(result.error).toBeUndefined();
		await runtime.dispose();
	});
});
