import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runCouncilEngine } from "../src/engine";
import type {
	CouncilActionApi,
	CouncilActionResult,
	CouncilBudgets,
	CouncilEngineOptions,
	CouncilMemberInfo,
	CouncilProposalContent,
	CouncilRuntimeFactory,
	CouncilTurnResult,
} from "../src/types";

const RATIONALE = "Checked against src/cache.ts and the benchmark output; the approach holds.";

interface ScriptContext {
	prompt: string;
	/** Zero-based turn index for this session. */
	turn: number;
	actions: CouncilActionApi;
	/** Resolves once the engine aborts this session's turn. */
	aborted: Promise<void>;
}

type Script = (ctx: ScriptContext) => string | CouncilTurnResult | Promise<string | CouncilTurnResult>;

interface FakeCouncil {
	factory: CouncilRuntimeFactory;
	prompts: Record<string, string[]>;
	disposed: string[];
	aborts: string[];
}

/** Scripted stand-ins for member sessions: each turn runs the script against the real ledger actions. */
function fakeCouncil(scripts: Record<string, Script>, options: { tokensPerTurn?: number } = {}): FakeCouncil {
	const prompts: Record<string, string[]> = {};
	const disposed: string[] = [];
	const aborts: string[] = [];
	const createRuntime = (id: string, actions: CouncilActionApi, onUsage: (tokens: number) => void) => {
		let turn = 0;
		let tokens = 0;
		let abortTurn: (() => void) | undefined;
		return {
			async runTurn(prompt: string): Promise<CouncilTurnResult> {
				prompts[id] ??= [];
				prompts[id].push(prompt);
				const { promise: aborted, resolve } = Promise.withResolvers<void>();
				abortTurn = resolve;
				const script = scripts[id];
				const output = script ? await script({ prompt, turn: turn++, actions, aborted }) : "";
				abortTurn = undefined;
				if (options.tokensPerTurn) {
					tokens += options.tokensPerTurn;
					onUsage(tokens);
				}
				return typeof output === "string" ? { text: output, tools: [] } : output;
			},
			async abort() {
				aborts.push(id);
				abortTurn?.();
			},
			async dispose() {
				disposed.push(id);
			},
		};
	};
	const factory: CouncilRuntimeFactory = {
		async createMember(member, actions, hooks) {
			return createRuntime(member.id, actions, tokens => hooks.onUsage({ tokens, cost: 0 }));
		},
	};
	return { factory, prompts, disposed, aborts };
}

function member(id: string): CouncilMemberInfo {
	const name = id.toUpperCase();
	return { id, name, model: `test/${id}`, agentId: `Council${name}` };
}

function content(title: string): CouncilProposalContent {
	return {
		title,
		summary: `${title} in brief`,
		solution: `Implement ${title}`,
		evidence: "src/cache.ts:42 shows the stale read",
		tradeoffs: "Adds one lock per write",
		implementation: "Change the writer and add a regression test",
	};
}

function isVerification(prompt: string): boolean {
	return prompt.startsWith("# Verification");
}

function engineOptions(
	council: FakeCouncil,
	ids: string[],
	overrides: Partial<CouncilEngineOptions> & { budgets?: CouncilBudgets } = {},
): CouncilEngineOptions {
	return {
		problem: "Fix the stale cache reads",
		members: ids.map(member),
		budgets: {},
		factory: council.factory,
		...overrides,
	};
}

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("council engine", () => {
	test("declares consensus only after unanimous acceptance and independent verification", async () => {
		const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-council-test-"));
		tempDirs.push(outputDir);
		const gated: CouncilActionResult[] = [];
		const debater =
			(own: string): Script =>
			({ prompt, turn, actions }) => {
				if (turn === 0) {
					gated.push(actions.accept({ proposalId: "P1", version: 1, rationale: RATIONALE }));
					actions.propose(content(own));
					return `${own} analysis`;
				}
				if (isVerification(prompt)) {
					actions.verify({ proposalId: "P1", version: 1, verdict: "confirm", rationale: RATIONALE });
					return "Re-ran the benchmark; confirmed.";
				}
				const mine = actions.view("state").match(new RegExp(`(P\\d) v1 "${own}"`))?.[1];
				if (mine && mine !== "P1") actions.withdraw({ proposalId: mine, reason: "P1 is stronger" });
				actions.accept({ proposalId: "P1", version: 1, rationale: RATIONALE });
				return "P1 holds up; I accept it.";
			};
		const council = fakeCouncil({
			a: debater("Write-through"),
			b: debater("Invalidate on read"),
			c: debater("TTL eviction"),
		});

		const result = await runCouncilEngine(engineOptions(council, ["a", "b", "c"], { outputDir }));

		expect(result.outcome).toBe("consensus");
		expect(result.consensus?.proposal.id).toBe("P1");
		expect(result.consensus?.version.version).toBe(1);
		expect(result.consensus?.verifications.map(entry => entry.member)).toEqual(["a", "b", "c"]);
		expect(result.rounds).toBe(1);
		// Independent analysis admits only proposals; acceptance waits for the debate.
		expect(gated.every(entry => !entry.ok && entry.error.includes("independent analysis"))).toBe(true);
		// Members analyze the bare problem alone; the debate delivers other members' proposals.
		expect(council.prompts.b?.[0]).toContain("Fix the stale cache reads");
		expect(council.prompts.b?.[0]).not.toContain("Write-through");
		expect(council.prompts.b?.[1]).toContain("A proposed P1 v1 — Write-through");
		expect(council.disposed.sort()).toEqual(["a", "b", "c"]);

		expect(result.report).toContain("## Agreed solution — P1 v1: Write-through");
		expect(await Bun.file(path.join(outputDir, "report.md")).text()).toBe(result.report);
		const events = (await Bun.file(path.join(outputDir, "transcript.jsonl")).text())
			.trim()
			.split("\n")
			.map(line => JSON.parse(line) as { type: string });
		const types = events.map(event => event.type);
		expect(types.indexOf("verification_start")).toBeLessThan(types.indexOf("verdict"));
		expect(types.at(-2)).toBe("finished");
	});

	test("a verification rejection reopens debate until the revised version is confirmed", async () => {
		const verifyAttempts: CouncilActionResult[] = [];
		const council = fakeCouncil({
			a: ({ prompt, turn, actions }) => {
				if (turn === 0) {
					actions.propose(content("Write-through"));
					return "analysis";
				}
				if (isVerification(prompt)) {
					const version = prompt.startsWith("# Verification — P1 v2") ? 2 : 1;
					const assessments =
						version === 2
							? [{ challengeId: "C1", assessment: "addressed" as const, note: "Retries cover the failure" }]
							: undefined;
					actions.verify({ proposalId: "P1", version, verdict: "confirm", rationale: RATIONALE, assessments });
					return "confirmed";
				}
				const version = prompt.includes("revised P1 → v2") ? 2 : 1;
				actions.accept({ proposalId: "P1", version, rationale: RATIONALE });
				return "accepting";
			},
			b: ({ prompt, turn, actions }) => {
				if (turn === 0) {
					actions.propose(content("Invalidate on read"));
					return "analysis";
				}
				if (prompt.startsWith("# Verification — P1 v1")) {
					actions.verify({
						proposalId: "P1",
						version: 1,
						verdict: "reject",
						rationale: "Writer failures leave the cache stale; the proposal needs retries.",
					});
					return "rejected";
				}
				if (isVerification(prompt)) {
					verifyAttempts.push(
						actions.verify({ proposalId: "P1", version: 2, verdict: "confirm", rationale: RATIONALE }),
					);
					verifyAttempts.push(
						actions.verify({
							proposalId: "P1",
							version: 2,
							verdict: "confirm",
							rationale: RATIONALE,
							assessments: [{ challengeId: "C1", assessment: "addressed", note: "v2 retries failed writes" }],
						}),
					);
					return "confirmed";
				}
				if (turn === 1) {
					actions.withdraw({ proposalId: "P2", reason: "P1 is stronger" });
					actions.accept({ proposalId: "P1", version: 1, rationale: RATIONALE });
					return "accepting P1";
				}
				actions.revise({
					proposalId: "P1",
					baseVersion: 1,
					changeSummary: "Retry failed writes",
					addresses: ["C1"],
					solution: "Write-through with retries",
				});
				actions.accept({ proposalId: "P1", version: 2, rationale: RATIONALE });
				return "revised";
			},
		});

		const result = await runCouncilEngine(engineOptions(council, ["a", "b"]));

		expect(result.outcome).toBe("consensus");
		expect(result.consensus?.version.version).toBe(2);
		expect(result.consensus?.verifications.every(entry => entry.attempt === 2)).toBe(true);
		expect(result.rounds).toBe(2);
		expect(result.challenges).toHaveLength(1);
		expect(result.challenges[0]).toMatchObject({
			author: "b",
			fromVerification: 1,
			status: "resolved",
			resolution: { kind: "verified" },
		});
		// The objection awaiting confirmation must be assessed before a confirmation counts.
		expect(verifyAttempts[0]?.ok).toBe(false);
		expect(verifyAttempts[1]?.ok).toBe(true);
	});

	test("budget exhaustion returns proposals, disagreements, and progress", async () => {
		const council = fakeCouncil(
			{
				a: ({ turn, actions }) => {
					if (turn === 0) actions.propose(content("Write-through"));
					else actions.challenge({ proposalId: "P2", objection: "Reads still race the invalidation" });
					return "position A";
				},
				b: ({ turn, actions }) => {
					if (turn === 0) actions.propose(content("Invalidate on read"));
					return "position B";
				},
			},
			{ tokensPerTurn: 600 },
		);

		const result = await runCouncilEngine(engineOptions(council, ["a", "b"], { budgets: { maxTokens: 1500 } }));

		expect(result.outcome).toBe("budget");
		expect(result.reason).toContain("Token budget");
		expect(result.usage.tokens).toBe(1800);
		expect(result.consensus).toBeUndefined();
		expect(result.proposals.map(proposal => proposal.id)).toEqual(["P1", "P2"]);
		expect(result.challenges.map(challenge => [challenge.id, challenge.status])).toEqual([["C1", "open"]]);
		expect(result.report).toContain("Council stopped without consensus");
		expect(result.report).toContain("Reads still race the invalidation");
		expect(council.prompts.b).toHaveLength(1);
	});

	test("cancellation aborts the in-flight turn and still releases every session", async () => {
		const controller = new AbortController();
		const council = fakeCouncil({
			a: async ({ turn, actions, aborted }) => {
				if (turn === 0) {
					actions.propose(content("Write-through"));
					return "analysis";
				}
				controller.abort();
				await aborted;
				return { text: "partial thoughts", tools: [], aborted: true };
			},
			b: ({ actions }) => {
				actions.propose(content("Invalidate on read"));
				return "analysis";
			},
		});

		const result = await runCouncilEngine(engineOptions(council, ["a", "b"], { signal: controller.signal }));

		expect(result.outcome).toBe("cancelled");
		expect(council.aborts).toEqual(["a"]);
		expect(council.disposed.sort()).toEqual(["a", "b"]);
		expect(result.proposals).toHaveLength(2);
	});

	test("an optional round limit stops a council that never converges", async () => {
		const council = fakeCouncil({
			a: ({ turn, actions }) => {
				if (turn === 0) actions.propose(content("Write-through"));
				return "still prefer P1";
			},
			b: ({ turn, actions }) => {
				if (turn === 0) actions.propose(content("Invalidate on read"));
				return "still prefer P2";
			},
		});

		const result = await runCouncilEngine(engineOptions(council, ["a", "b"], { budgets: { maxRounds: 2 } }));

		expect(result.outcome).toBe("round-limit");
		expect(result.rounds).toBe(2);
		expect(council.prompts.a).toHaveLength(3);
		expect(council.prompts.b).toHaveLength(3);
	});
});
