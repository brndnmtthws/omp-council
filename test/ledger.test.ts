import { describe, expect, test } from "bun:test";
import { CouncilLedger } from "../src/ledger";
import type { CouncilEventBody, CouncilProposalContent } from "../src/types";

const RATIONALE = "Matches the cache invalidation path in src/cache.ts and the benchmark numbers.";

function content(title: string): CouncilProposalContent {
	return {
		title,
		summary: `${title} in brief`,
		solution: `Implement ${title}`,
		evidence: "src/cache.ts:42 shows the stale read",
		tradeoffs: "Adds one lock per write",
		implementation: "Change the writer, add a regression test",
	};
}

function ledgerFor(members: string[]) {
	const events: CouncilEventBody[] = [];
	const ledger = new CouncilLedger({ members, emit: event => events.push(event), now: () => 0 });
	return { ledger, events };
}

describe("council ledger consensus", () => {
	test("consensus needs every member on the same current version", () => {
		const { ledger } = ledgerFor(["a", "b", "c"]);
		ledger.propose("a", 0, content("Write-through"));
		ledger.propose("b", 0, content("Invalidate on read"));
		expect(ledger.accept("a", 1, { proposalId: "P1", version: 1, rationale: RATIONALE }).ok).toBe(true);
		expect(ledger.accept("b", 1, { proposalId: "p1", version: 1, rationale: RATIONALE }).ok).toBe(true);
		expect(ledger.accept("c", 1, { proposalId: "2", version: 1, rationale: RATIONALE }).ok).toBe(true);
		expect(ledger.consensusCandidate()).toBeUndefined();

		// Accepting another proposal replaces the member's single endorsement.
		expect(ledger.accept("c", 1, { proposalId: "P1", version: 1, rationale: RATIONALE }).ok).toBe(true);
		expect(ledger.acceptersOf("P2", 1)).toEqual([]);
		expect(ledger.consensusCandidate()).toEqual({ proposalId: "P1", version: 1 });
	});

	test("a revision clears every acceptance and stale versions are refused", () => {
		const { ledger, events } = ledgerFor(["a", "b", "c"]);
		ledger.propose("a", 0, content("Write-through"));
		ledger.accept("a", 1, { proposalId: "P1", version: 1, rationale: RATIONALE });
		ledger.accept("b", 1, { proposalId: "P1", version: 1, rationale: RATIONALE });

		const revised = ledger.revise("c", 1, {
			proposalId: "P1",
			baseVersion: 1,
			changeSummary: "Batch the writes",
			solution: "Implement write-through with batching",
		});
		expect(revised).toMatchObject({ ok: true, ref: "P1 v2" });
		expect(ledger.acceptances()).toEqual([]);
		expect(events.at(-1)).toMatchObject({ type: "revise", invalidated: ["a", "b"] });
		// Unchanged sections carry over; the reviser authors the new version.
		expect(ledger.getProposal("P1")?.versions[1]).toMatchObject({
			version: 2,
			author: "c",
			title: "Write-through",
			solution: "Implement write-through with batching",
		});

		const stale = ledger.accept("a", 1, { proposalId: "P1", version: 1, rationale: RATIONALE });
		expect(stale.ok).toBe(false);
		expect(!stale.ok && stale.error).toContain("v2");
		const staleRevision = ledger.revise("b", 1, {
			proposalId: "P1",
			baseVersion: 1,
			changeSummary: "Another take",
			summary: "Different",
		});
		expect(!staleRevision.ok && staleRevision.error).toContain("Stale base_version");

		for (const member of ["a", "b", "c"]) {
			ledger.accept(member, 1, { proposalId: "P1", version: 2, rationale: RATIONALE });
		}
		expect(ledger.consensusCandidate()).toEqual({ proposalId: "P1", version: 2 });
	});

	test("a challenge withdraws its author's acceptance and blocks it until addressed or resolved", () => {
		const { ledger } = ledgerFor(["a", "b"]);
		ledger.propose("a", 0, content("Write-through"));
		ledger.accept("b", 1, { proposalId: "P1", version: 1, rationale: RATIONALE });

		expect(ledger.challenge("b", 1, { proposalId: "P1", objection: "Lock contention under load" }).ok).toBe(true);
		expect(ledger.acceptanceOf("b")).toBeUndefined();
		const blocked = ledger.accept("b", 1, { proposalId: "P1", version: 1, rationale: RATIONALE });
		expect(!blocked.ok && blocked.error).toContain("C1");

		// A revision that addresses the challenge lifts the block without resolving it.
		ledger.revise("a", 2, {
			proposalId: "P1",
			baseVersion: 1,
			changeSummary: "Shard the lock",
			addresses: ["c1"],
			solution: "Write-through with sharded locks",
		});
		expect(ledger.getChallenge("C1")?.status).toBe("addressed");
		expect(ledger.accept("b", 2, { proposalId: "P1", version: 2, rationale: RATIONALE }).ok).toBe(true);
	});

	test("only the challenger resolves and only the author withdraws", () => {
		const { ledger } = ledgerFor(["a", "b"]);
		ledger.propose("a", 0, content("Write-through"));
		ledger.challenge("b", 1, { proposalId: "P1", objection: "Missing failure handling" });
		ledger.accept("a", 1, { proposalId: "P1", version: 1, rationale: RATIONALE });

		expect(ledger.resolve("a", 1, { challengeId: "C1", note: "Not my call" }).ok).toBe(false);
		expect(ledger.withdraw("b", 1, { proposalId: "P1", reason: "Not mine" }).ok).toBe(false);

		expect(ledger.withdraw("a", 1, { proposalId: "P1", reason: "Superseded" }).ok).toBe(true);
		expect(ledger.acceptances()).toEqual([]);
		expect(ledger.getChallenge("C1")).toMatchObject({ status: "resolved", resolution: { kind: "moot" } });
		expect(ledger.accept("a", 1, { proposalId: "P1", version: 1, rationale: RATIONALE }).ok).toBe(false);
	});

	test("proposals need every section and accepts need a substantive rationale", () => {
		const { ledger } = ledgerFor(["a", "b"]);
		const missing = ledger.propose("a", 0, { ...content("Write-through"), evidence: "  ", tradeoffs: "" });
		expect(!missing.ok && missing.error).toContain("evidence, tradeoffs");
		ledger.propose("a", 0, content("Write-through"));
		expect(ledger.accept("b", 1, { proposalId: "P1", version: 1, rationale: "LGTM" }).ok).toBe(false);
	});

	test("a code fence a model leaves open is closed so it cannot swallow later report sections", () => {
		const { ledger } = ledgerFor(["a", "b"]);
		const balanced = "Use this:\n```ts\nconst start = (page - 1) * size;\n```\nThen test it.";
		ledger.propose("a", 0, {
			...content("Write-through"),
			solution: "Replace the body:\n```typescript\nconst start = (page - 1) * size;",
			implementation: balanced,
		});
		const stored = ledger.getProposal("P1")?.versions[0];
		expect(stored?.solution).toBe("Replace the body:\n```typescript\nconst start = (page - 1) * size;\n```");
		expect(stored?.implementation).toBe(balanced);
	});
});

describe("council ledger verification", () => {
	function readyForVerification() {
		const harness = ledgerFor(["a", "b"]);
		const { ledger } = harness;
		ledger.propose("a", 0, content("Write-through"));
		ledger.challenge("b", 1, { proposalId: "P1", objection: "Lock contention under load" });
		ledger.revise("a", 1, {
			proposalId: "P1",
			baseVersion: 1,
			changeSummary: "Shard the lock",
			addresses: ["C1"],
			solution: "Write-through with sharded locks",
		});
		ledger.accept("a", 1, { proposalId: "P1", version: 2, rationale: RATIONALE });
		ledger.accept("b", 1, { proposalId: "P1", version: 2, rationale: RATIONALE });
		expect(ledger.beginVerification("P1", 2)).toBe(1);
		return harness;
	}

	test("unanimous confirmation requires assessing every pending objection and verifies it", () => {
		const { ledger, events } = readyForVerification();
		const unassessed = ledger.verify("a", 1, {
			proposalId: "P1",
			version: 2,
			verdict: "confirm",
			rationale: RATIONALE,
		});
		expect(!unassessed.ok && unassessed.error).toContain("missing: C1");
		const contradictory = ledger.verify("a", 1, {
			proposalId: "P1",
			version: 2,
			verdict: "confirm",
			rationale: RATIONALE,
			assessments: [{ challengeId: "C1", assessment: "unaddressed", note: "Still one hot shard" }],
		});
		expect(contradictory.ok).toBe(false);
		const wrongTarget = ledger.verify("b", 1, {
			proposalId: "P1",
			version: 1,
			verdict: "confirm",
			rationale: RATIONALE,
		});
		expect(wrongTarget.ok).toBe(false);

		for (const member of ["a", "b"]) {
			const verdict = ledger.verify(member, 1, {
				proposalId: "P1",
				version: 2,
				verdict: "confirm",
				rationale: RATIONALE,
				assessments: [{ challengeId: "C1", assessment: "addressed", note: "Sharding removes the hot lock" }],
			});
			expect(verdict.ok).toBe(true);
		}
		// Verdicts stay out of the event stream until verification concludes.
		expect(events.some(event => event.type === "verdict")).toBe(false);

		const outcome = ledger.concludeVerification(1);
		expect(outcome).toMatchObject({ confirmed: true, rejectedBy: [], missing: [], challengeIds: [] });
		expect(events.filter(event => event.type === "verdict")).toHaveLength(2);
		expect(ledger.getChallenge("C1")).toMatchObject({ status: "resolved", resolution: { kind: "verified" } });
	});

	test("a rejection becomes a challenge and a missing verdict withdraws the acceptance", () => {
		const harness = ledgerFor(["a", "b", "c"]);
		const { ledger } = harness;
		ledger.propose("a", 0, content("Write-through"));
		for (const member of ["a", "b", "c"]) {
			ledger.accept(member, 1, { proposalId: "P1", version: 1, rationale: RATIONALE });
		}
		ledger.beginVerification("P1", 1);
		ledger.verify("a", 1, { proposalId: "P1", version: 1, verdict: "confirm", rationale: RATIONALE });
		ledger.verify("b", 1, {
			proposalId: "P1",
			version: 1,
			verdict: "reject",
			rationale: "The benchmark in bench/cache.ts regresses 30% under contention.",
		});

		const outcome = ledger.concludeVerification(1);
		expect(outcome).toMatchObject({ confirmed: false, rejectedBy: ["b"], missing: ["c"], challengeIds: ["C1"] });
		expect(ledger.getChallenge("C1")).toMatchObject({
			author: "b",
			status: "open",
			proposalVersion: 1,
			fromVerification: 1,
		});
		expect(ledger.acceptances().map(acceptance => acceptance.member)).toEqual(["a"]);
		expect(ledger.consensusCandidate()).toBeUndefined();
		expect(ledger.activeVerification()).toBeUndefined();
	});
});
