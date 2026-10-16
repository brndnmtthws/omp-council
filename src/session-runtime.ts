/**
 * AgentSession-backed {@link CouncilRuntimeFactory}: every council member is a
 * persistent, persisted agent session in the project directory with inspection
 * tools, `bash` for diagnostics, and the council ledger tools. Members get no
 * edit or write tools; their system prompt forbids changing the project.
 */
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	createSubagentSettings,
	SessionManager,
} from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { formatToolCallPrimaryArg } from "@oh-my-pi/pi-coding-agent/session/session-history-format";
import memberSystemPrompt from "./prompts/member-system.md" with { type: "text" };
import { COUNCIL_MEMBER_TOOL_NAMES } from "./tools";
import type {
	CouncilActivity,
	CouncilRuntimeFactory,
	CouncilSessionRuntimeOptions,
	CouncilToolCallSummary,
	CouncilTurnResult,
} from "./types";

/** Built-in tools every member gets alongside the council tools. */
const MEMBER_TOOL_NAMES = ["read", "grep", "glob", "ast_grep", "web_search", "bash"] as const;

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function assistantText(message: AssistantMessage | undefined): string {
	if (!message) return "";
	return message.content
		.filter(content => content.type === "text")
		.map(content => content.text)
		.join("")
		.trim();
}

/** A provider error as one bounded line for board rows and notices. */
function errorLine(text: string): string {
	return text.replace(/\s+/g, " ").trim().slice(0, 160);
}

export function createSessionRuntimeFactory(options: CouncilSessionRuntimeOptions): CouncilRuntimeFactory {
	return {
		async createMember(member, actions, hooks) {
			const resolved = options.members.find(candidate => candidate.id === member.id);
			if (!resolved) throw new Error(`Council member ${member.name} has no resolved model.`);
			const rolePrompt = prompt.render(memberSystemPrompt, {
				name: member.name,
				persona: member.persona,
				memberCount: options.members.length,
				members: options.members.map(entry => ({
					name: entry.name,
					model: entry.model,
					self: entry.id === member.id,
				})),
			});
			const agentRegistry = AgentRegistry.global();
			let session: AgentSession;
			try {
				const sessionManager = await SessionManager.open(
					path.join(options.sessionDir, `${member.agentId}.jsonl`),
					undefined,
					undefined,
					{ initialCwd: options.cwd, suppressBreadcrumb: true },
				);
				const created = await createAgentSession({
					cwd: options.cwd,
					sessionManager,
					model: resolved.modelRef,
					thinkingLevel: resolved.thinking,
					modelRegistry: options.modelRegistry,
					authStorage: options.modelRegistry.authStorage,
					settings: createSubagentSettings(options.settings, {
						"async.enabled": false,
						"bash.autoBackground.enabled": false,
					}),
					toolNames: [...MEMBER_TOOL_NAMES, ...COUNCIL_MEMBER_TOOL_NAMES],
					restrictToolNames: true,
					allowRestrictedCustomTools: true,
					customTools: options.memberTools(actions),
					hasUI: false,
					enableMCP: false,
					enableIrc: false,
					enableLsp: false,
					spawns: "",
					taskDepth: 1,
					disableExtensionDiscovery: true,
					skills: [],
					promptTemplates: [],
					slashCommands: [],
					agentId: member.agentId,
					agentDisplayName: member.name,
					agentName: "council",
					parentTaskPrefix: member.agentId,
					parentAgentId: options.parentAgentId,
					agentRegistry,
					localProtocolOptions: options.localProtocolOptions,
					systemPrompt: defaultPrompt =>
						defaultPrompt.length === 0
							? [rolePrompt]
							: [...defaultPrompt.slice(0, -1), rolePrompt, defaultPrompt[defaultPrompt.length - 1]],
				});
				session = created.session;
			} catch (error) {
				throw new Error(`Failed to start council session for ${member.name}: ${errorText(error)}`, {
					cause: error,
				});
			}
			// createAgentSession registers the member as running; it runs only during its turns.
			agentRegistry.setStatus(member.agentId, "idle");

			let tokens = 0;
			let cost = 0;
			let toolCount = 0;
			let turnRunning = false;
			/** Provider errors retried since the last successful request, and the first one's message. */
			let retries = 0;
			let retryError = "";
			let abortCall: Promise<void> | undefined;
			let disposeCall: Promise<void> | undefined;
			let turnTools: CouncilToolCallSummary[] = [];
			let turnAssistant: AssistantMessage | undefined;
			const pendingTools = new Map<string, CouncilToolCallSummary>();
			// The board row, plus the Agent Hub and history:// gist (the registry ignores it outside a turn).
			const activity = (state: CouncilActivity["state"], tool?: string, detail?: string) => {
				hooks.onActivity({ state, tool, detail, toolCount, since: Date.now() });
				agentRegistry.setActivity(
					member.agentId,
					state === "tool"
						? `running ${tool}${detail ? ` ${detail}` : ""}`
						: detail
							? `${state} ${detail}`
							: state,
				);
			};

			const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
				switch (event.type) {
					case "message_start":
						if (event.message.role === "assistant") activity("thinking");
						break;
					case "message_end": {
						const message = event.message;
						if (message.role !== "assistant") break;
						turnAssistant = message;
						tokens +=
							(message.usage?.input ?? 0) + (message.usage?.output ?? 0) + (message.usage?.cacheWrite ?? 0);
						cost += message.usage?.cost?.total ?? 0;
						hooks.onUsage({ tokens, cost });
						break;
					}
					case "tool_execution_start": {
						toolCount += 1;
						const detail = formatToolCallPrimaryArg(event.toolName, event.args);
						if (!event.toolName.startsWith("council_")) {
							const summary: CouncilToolCallSummary = { tool: event.toolName, args: detail };
							turnTools.push(summary);
							pendingTools.set(event.toolCallId, summary);
						}
						activity("tool", event.toolName, detail);
						break;
					}
					case "tool_execution_end": {
						const summary = pendingTools.get(event.toolCallId);
						pendingTools.delete(event.toolCallId);
						if (summary && event.isError) summary.error = true;
						activity("thinking");
						break;
					}
					case "auto_retry_start":
						retries += 1;
						if (retries === 1) retryError = errorLine(event.errorMessage);
						activity(
							"retrying",
							undefined,
							`${event.attempt}/${event.maxAttempts}: ${errorLine(event.errorMessage)}`,
						);
						break;
					case "auto_retry_end":
						if (event.success && retries > 0) {
							hooks.onNotice(
								`${member.name} recovered after ${retries} provider error${retries === 1 ? "" : "s"}: ${retryError}`,
							);
						}
						retries = 0;
						break;
					case "auto_compaction_start":
						activity("compacting");
						break;
					case "auto_compaction_end":
						activity("thinking");
						break;
					default:
						break;
				}
			});

			const abort = async (): Promise<void> => {
				if (!turnRunning) return;
				abortCall ??= session.abort().catch(error => {
					logger.warn("Council session abort failed", { agentId: member.agentId, error: errorText(error) });
				});
				await abortCall;
			};

			return {
				async runTurn(text: string): Promise<CouncilTurnResult> {
					if (disposeCall) return { text: "", tools: [], error: "Council session already disposed" };
					turnTools = [];
					turnAssistant = undefined;
					pendingTools.clear();
					abortCall = undefined;
					turnRunning = true;
					retries = 0;
					agentRegistry.setStatus(member.agentId, "running");
					activity("thinking");
					const before = session.getLastAssistantMessage();
					let error: string | undefined;
					try {
						await session.prompt(text, { attribution: "agent", expandPromptTemplates: false });
						await session.waitForIdle();
					} catch (err) {
						error = errorText(err);
					} finally {
						turnRunning = false;
						// Disposal parks the ref; a turn unwinding afterwards must not revive it as idle.
						if (!disposeCall) agentRegistry.setStatus(member.agentId, "idle");
					}
					const latest = session.getLastAssistantMessage();
					const message = latest !== before ? latest : turnAssistant;
					const aborted = abortCall !== undefined || message?.stopReason === "aborted";
					if (!error && message?.stopReason === "error") error = message.errorMessage || "Model request failed";
					const result: CouncilTurnResult = { text: assistantText(message), tools: turnTools };
					if (aborted) {
						result.aborted = true;
						activity("idle");
					} else if (error) {
						result.error = error;
						activity("failed", undefined, errorLine(error));
					} else {
						activity("idle");
					}
					return result;
				},
				abort,
				dispose(): Promise<void> {
					disposeCall ??= (async () => {
						await abort();
						unsubscribe();
						try {
							// Park instead of unregistering so `history://<agentId>` keeps
							// resolving: flip the ref before dispose so the sdk dispose
							// wrapper skips its unregister, then detach the dead session.
							agentRegistry.setStatus(member.agentId, "parked");
							await session.dispose();
							agentRegistry.detachSession(member.agentId);
						} catch (error) {
							logger.warn("Council session dispose failed", {
								agentId: member.agentId,
								error: errorText(error),
							});
						}
					})();
					return disposeCall;
				},
			};
		},
	};
}
