/**
 * Council engine: drives persistent member sessions through independent
 * analysis, round-robin debate, and independent verification.
 *
 * The engine facilitates and enforces the protocol; it never judges the
 * problem. Consensus is decided by the ledger alone: every member accepts the
 * exact same proposal version, then every member independently confirms it.
 * There is no round limit unless the caller sets one; budgets and the abort
 * signal stop the run, and an interrupted run still returns the proposals,
 * unresolved disagreements, and progress made so far.
 */
import { formatDuration, formatNumber, logger, prompt } from "@oh-my-pi/pi-utils";
import { CouncilLedger, closeOpenFences, currentVersion } from "./ledger";
import independentPrompt from "./prompts/independent.md" with { type: "text" };
import nudgeProposalPrompt from "./prompts/nudge-proposal.md" with { type: "text" };
import nudgeVerdictPrompt from "./prompts/nudge-verdict.md" with { type: "text" };
import turnPrompt from "./prompts/turn.md" with { type: "text" };
import verifyPrompt from "./prompts/verify.md" with { type: "text" };
import {
	type CouncilNameResolver,
	councilNameResolver,
	formatCouncilCost,
	renderCouncilDelta,
	renderCouncilEvent,
	renderCouncilObjections,
	renderCouncilReport,
	renderCouncilState,
	renderCouncilTranscriptHeader,
	renderCouncilView,
	renderProposalVersion,
} from "./render";
import { CouncilTranscript } from "./transcript";
import type {
	CouncilActionApi,
	CouncilActionResult,
	CouncilActivity,
	CouncilConsensus,
	CouncilEngineOptions,
	CouncilEvent,
	CouncilEventBody,
	CouncilMemberInfo,
	CouncilMemberRuntime,
	CouncilOutcome,
	CouncilPhase,
	CouncilResult,
	CouncilSnapshot,
	CouncilStatementKind,
	CouncilTurnResult,
	CouncilUsage,
} from "./types";

/** Extra prompts a member gets when verification would end without its verdict. */
const VERDICT_NUDGES = 2;

/** Consecutive failed turns after which a member is considered unavailable. */
const MAX_CONSECUTIVE_FAILURES = 2;

/** Thrown to unwind the phase loops once the run must stop. */
class CouncilStop extends Error {
	constructor(
		readonly outcome: Exclude<CouncilOutcome, "consensus">,
		reason: string,
	) {
		super(reason);
		this.name = "CouncilStop";
	}
}

interface MemberState {
	info: CouncilMemberInfo;
	runtime?: CouncilMemberRuntime;
	activity: CouncilActivity;
	usage: CouncilUsage;
	/** A turn is in flight. */
	active: boolean;
	/** Sequence number of the newest transcript event already delivered. */
	lastSeen: number;
	/** Consecutive turns that ended in a provider/runtime error. */
	failures: number;
}

/** Run one council to completion, interruption, or failure. Never throws for model failures. */
export async function runCouncilEngine(options: CouncilEngineOptions): Promise<CouncilResult> {
	return new CouncilEngine(options).run();
}

class CouncilEngine {
	readonly #options: CouncilEngineOptions;
	readonly #now: () => number;
	readonly #startedAt: number;
	readonly #name: CouncilNameResolver;
	readonly #members: MemberState[];
	readonly #transcript: CouncilTranscript;
	readonly #ledger: CouncilLedger;
	#phase: CouncilPhase = "setup";
	#round = 0;
	#stop: CouncilStop | undefined;
	#outcome: CouncilOutcome | undefined;

	constructor(options: CouncilEngineOptions) {
		if (options.members.length < 2) throw new Error("A council needs at least two members");
		this.#options = options;
		this.#now = options.now ?? Date.now;
		this.#startedAt = this.#now();
		this.#name = councilNameResolver(options.members);
		this.#members = options.members.map(info => ({
			info,
			activity: { state: "idle", toolCount: 0, since: this.#now() },
			usage: { tokens: 0, cost: 0 },
			active: false,
			lastSeen: 0,
			failures: 0,
		}));
		this.#transcript = new CouncilTranscript({
			outputDir: options.outputDir,
			now: this.#now,
			header: renderCouncilTranscriptHeader({
				problem: options.problem,
				members: options.members,
				budgets: options.budgets,
				startedAt: this.#startedAt,
			}),
			formatMarkdown: event => renderCouncilEvent(event, this.#name),
		});
		this.#transcript.subscribe(event => this.#options.onEvent?.(event, this.#snapshot()));
		this.#ledger = new CouncilLedger({
			members: options.members.map(member => member.id),
			emit: body => this.#append(body),
			now: this.#now,
		});
	}

	async run(): Promise<CouncilResult> {
		const { signal, budgets } = this.#options;
		const onAbort = () => this.#halt("cancelled", "Cancelled by the user.");
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
		const deadline = budgets.maxDurationMs
			? setTimeout(
					() => this.#halt("budget", `Time budget of ${formatDuration(budgets.maxDurationMs ?? 0)} exhausted.`),
					budgets.maxDurationMs,
				)
			: undefined;
		deadline?.unref?.();

		let consensus: CouncilConsensus | undefined;
		try {
			await this.#setup();
			await this.#independentAnalysis();
			consensus = await this.#debate();
		} catch (error) {
			if (!(error instanceof CouncilStop)) {
				logger.error("Council engine failed", { error: error instanceof Error ? error.stack : String(error) });
				this.#halt("failed", error instanceof Error ? error.message : String(error));
			}
		} finally {
			signal?.removeEventListener("abort", onAbort);
			clearTimeout(deadline);
		}
		return this.#finish(consensus);
	}

	// ─── Phases ─────────────────────────────────────────────────────────────

	async #setup(): Promise<void> {
		this.#setPhase("setup");
		const { factory } = this.#options;
		const results = await Promise.allSettled(
			this.#members.map(async member => {
				member.runtime = await factory.createMember(member.info, this.#actionsFor(member.info.id), {
					onActivity: activity => {
						member.activity = activity;
						this.#update();
					},
					onUsage: usage => {
						member.usage = usage;
						this.#checkBudgets();
						this.#update();
					},
					onNotice: text => {
						this.#append({ type: "notice", text });
					},
				});
			}),
		);
		const failures = results.flatMap((result, index) =>
			result.status === "rejected" ? [`${this.#members[index]?.info.name}: ${errorMessage(result.reason)}`] : [],
		);
		if (failures.length > 0) this.#halt("failed", `Could not start ${failures.join("; ")}`);
		this.#checkStop();
	}

	async #independentAnalysis(): Promise<void> {
		this.#setPhase("independent");
		const startSeq = this.#transcript.lastSeq;
		await Promise.all(
			this.#members.map(async member => {
				member.lastSeen = startSeq;
				let result = await this.#runTurn(
					member,
					prompt.render(independentPrompt, { problem: this.#options.problem, context: this.#options.context }),
				);
				const proposed = this.#ledger.proposals().some(proposal => proposal.author === member.info.id);
				if (!this.#stop && !result.error && !result.aborted && !proposed) {
					result = mergeTurns(result, await this.#runTurn(member, prompt.render(nudgeProposalPrompt)));
				}
				this.#recordTurn(member, "analysis", result);
			}),
		);
		this.#checkStop();
	}

	/** Round-robin debate until a verified consensus or a stop. */
	async #debate(): Promise<CouncilConsensus> {
		const { maxRounds } = this.#options.budgets;
		for (let round = 1; ; round++) {
			if (maxRounds && round > maxRounds) {
				this.#halt("round-limit", `Reached the ${maxRounds}-round limit without consensus.`);
			}
			this.#checkStop();
			this.#round = round;
			this.#transcript.round = round;
			this.#setPhase("debate");
			// Rotate the speaking order so no member always speaks first or last.
			const offset = (round - 1) % this.#members.length;
			const order = [...this.#members.slice(offset), ...this.#members.slice(0, offset)];
			for (const member of order) {
				await this.#debateTurn(member, round);
				this.#checkStop();
				const consensus = await this.#verifyCandidate();
				if (consensus) return consensus;
			}
		}
	}

	async #debateTurn(member: MemberState, round: number): Promise<void> {
		const events = this.#transcript.since(member.lastSeen);
		member.lastSeen = this.#transcript.lastSeq;
		const turn = prompt.render(turnPrompt, {
			round,
			delta: renderCouncilDelta(events, this.#name, member.info.id),
			state: renderCouncilState(this.#viewContext(member.info.id)),
			transcriptPath: this.#transcript.markdownPath,
			members: this.#members.map(entry => ({
				name: entry.info.name,
				agentId: entry.info.agentId,
				self: entry === member,
			})),
		});
		this.#recordTurn(member, "turn", await this.#runTurn(member, turn));
	}

	/** Verify the consensus candidate, if one exists; returns the consensus once every member confirms. */
	async #verifyCandidate(): Promise<CouncilConsensus | undefined> {
		const candidate = this.#ledger.consensusCandidate();
		if (!candidate) return undefined;
		const proposal = this.#ledger.getProposal(candidate.proposalId);
		if (!proposal) return undefined;
		this.#setPhase("verification");
		const attempt = this.#ledger.beginVerification(candidate.proposalId, candidate.version);
		const version = currentVersion(proposal);
		const pendingCount = this.#ledger.unresolvedChallengesFor(proposal.id).length;
		const turns = await Promise.all(
			this.#members.map(async member => {
				const events = this.#transcript.since(member.lastSeen);
				member.lastSeen = this.#transcript.lastSeq;
				let result = await this.#runTurn(
					member,
					prompt.render(verifyPrompt, {
						proposalId: proposal.id,
						version: version.version,
						delta: events.length > 0 ? renderCouncilDelta(events, this.#name, member.info.id) : undefined,
						proposal: renderProposalVersion(proposal, version, this.#name),
						objections: renderCouncilObjections(this.#ledger, proposal.id, this.#name),
						pendingCount,
					}),
				);
				for (
					let nudge = 0;
					nudge < VERDICT_NUDGES &&
					!this.#stop &&
					!result.error &&
					!result.aborted &&
					!this.#ledger.activeVerification()?.verdicts.has(member.info.id);
					nudge++
				) {
					const retry = await this.#runTurn(
						member,
						prompt.render(nudgeVerdictPrompt, { proposalId: proposal.id, version: version.version }),
					);
					result = mergeTurns(result, retry);
				}
				return { member, result };
			}),
		);
		this.#checkStop();
		// Verification notes are published together, after every verdict is in,
		// so no member's reasoning leaks to another mid-verification.
		for (const { member, result } of turns) this.#recordTurn(member, "verification", result);
		this.#checkStop();
		const outcome = this.#ledger.concludeVerification(this.#round);
		if (!outcome.confirmed) {
			this.#setPhase("debate");
			return undefined;
		}
		return {
			proposal,
			version,
			verifications: this.#ledger.verifications().filter(entry => entry.attempt === attempt),
		};
	}

	async #finish(consensus: CouncilConsensus | undefined): Promise<CouncilResult> {
		const outcome: CouncilOutcome = consensus ? "consensus" : (this.#stop?.outcome ?? "failed");
		const reason = consensus
			? `Every member accepted and independently verified ${consensus.proposal.id} v${consensus.version.version}.`
			: (this.#stop?.message ?? "The council stopped unexpectedly.");
		this.#outcome = outcome;
		this.#append({ type: "finished", outcome, reason });
		this.#setPhase("done");
		const disposal = Promise.allSettled(this.#members.map(member => member.runtime?.dispose()));

		const usageBySession: Record<string, CouncilUsage> = {};
		for (const member of this.#members) usageBySession[member.info.id] = member.usage;
		const partial: Omit<CouncilResult, "report" | "reportPath"> = {
			outcome,
			reason,
			problem: this.#options.problem,
			members: this.#options.members,
			consensus,
			proposals: this.#ledger.proposals(),
			challenges: this.#ledger.challenges(),
			acceptances: this.#ledger.acceptances(),
			rounds: this.#round,
			durationMs: this.#now() - this.#startedAt,
			usage: this.#totalUsage(),
			usageBySession,
			outputDir: this.#options.outputDir,
			transcriptPath: this.#transcript.markdownPath,
		};
		const report = renderCouncilReport(partial);
		const [reportPath] = await Promise.all([this.#transcript.writeFile("report.md", report), disposal]);
		await this.#transcript.flush();
		return { ...partial, report, reportPath };
	}

	// ─── Turns ──────────────────────────────────────────────────────────────

	async #runTurn(member: MemberState, text: string): Promise<CouncilTurnResult> {
		const runtime = member.runtime;
		if (!runtime) return { text: "", tools: [], error: "Session is not running." };
		if (this.#stop) return { text: "", tools: [], aborted: true };
		member.active = true;
		this.#update();
		try {
			return await runtime.runTurn(text);
		} catch (error) {
			// Runtimes report provider failures in-band; anything thrown is still a failed turn, not a crash.
			return { text: "", tools: [], error: errorMessage(error) };
		} finally {
			member.active = false;
			this.#update();
		}
	}

	/** Publish a member turn and track consecutive failures. */
	#recordTurn(member: MemberState, kind: CouncilStatementKind, result: CouncilTurnResult): void {
		const text = closeOpenFences(result.text.trim());
		if (text || result.tools.length > 0) {
			this.#append({ type: "statement", member: member.info.id, kind, text, tools: result.tools });
		}
		if (result.aborted) return;
		if (!result.error) {
			member.failures = 0;
			return;
		}
		member.failures++;
		this.#append({ type: "turn_error", member: member.info.id, error: result.error });
		if (member.failures >= MAX_CONSECUTIVE_FAILURES) {
			this.#halt(
				"failed",
				`${member.info.name} failed ${member.failures} consecutive turns (last error: ${result.error}).`,
			);
		}
	}

	// ─── Member-bound actions ───────────────────────────────────────────────

	#actionsFor(memberId: string): CouncilActionApi {
		const ledger = this.#ledger;
		const gate = (
			tool: string,
			phases: readonly CouncilPhase[],
			run: (round: number) => CouncilActionResult,
		): CouncilActionResult => {
			if (this.#stop) return { ok: false, error: "The council has stopped; no further actions are recorded." };
			if (!phases.includes(this.#phase)) return { ok: false, error: phaseError(tool, this.#phase) };
			const result = run(this.#round);
			this.#update();
			return result;
		};
		const debate = ["debate"] as const;
		return {
			propose: input =>
				gate("council_propose", ["independent", "debate"], round =>
					this.#phase === "independent" && ledger.proposals().some(proposal => proposal.author === memberId)
						? {
								ok: false,
								error: "You already recorded your independent proposal. Further proposals and revisions open in the debate.",
							}
						: ledger.propose(memberId, round, input),
				),
			revise: input => gate("council_revise", debate, round => ledger.revise(memberId, round, input)),
			challenge: input => gate("council_challenge", debate, round => ledger.challenge(memberId, round, input)),
			respond: input => gate("council_respond", debate, round => ledger.respond(memberId, round, input)),
			resolve: input => gate("council_resolve", debate, round => ledger.resolve(memberId, round, input)),
			withdraw: input => gate("council_withdraw", debate, round => ledger.withdraw(memberId, round, input)),
			accept: input => gate("council_accept", debate, round => ledger.accept(memberId, round, input)),
			verify: input => gate("council_verify", ["verification"], round => ledger.verify(memberId, round, input)),
			view: ref => renderCouncilView(this.#viewContext(memberId), ref),
		};
	}

	// ─── Stop handling ──────────────────────────────────────────────────────

	/** Record the first stop reason and abort every in-flight turn. */
	#halt(outcome: Exclude<CouncilOutcome, "consensus">, reason: string): void {
		if (this.#stop) return;
		this.#stop = new CouncilStop(outcome, reason);
		for (const member of this.#members) {
			if (!member.active || !member.runtime) continue;
			member.runtime.abort().catch(error => {
				logger.warn("Council session abort failed", { error: errorMessage(error) });
			});
		}
		this.#update();
	}

	#checkStop(): void {
		if (this.#stop) throw this.#stop;
	}

	#checkBudgets(): void {
		const { maxTokens, maxCostUsd } = this.#options.budgets;
		const usage = this.#totalUsage();
		if (maxTokens && usage.tokens >= maxTokens) {
			this.#halt(
				"budget",
				`Token budget of ${formatNumber(maxTokens)} exhausted (${formatNumber(usage.tokens)} used).`,
			);
		} else if (maxCostUsd && usage.cost >= maxCostUsd) {
			this.#halt(
				"budget",
				`Cost budget of ${formatCouncilCost(maxCostUsd)} exhausted (${formatCouncilCost(usage.cost)} spent).`,
			);
		}
	}

	// ─── State ──────────────────────────────────────────────────────────────

	#totalUsage(): CouncilUsage {
		let tokens = 0;
		let cost = 0;
		for (const member of this.#members) {
			tokens += member.usage.tokens;
			cost += member.usage.cost;
		}
		return { tokens, cost };
	}

	#viewContext(viewer: string) {
		return { ledger: this.#ledger, phase: this.#phase, name: this.#name, viewer };
	}

	#setPhase(phase: CouncilPhase): void {
		this.#phase = phase;
		this.#append({ type: "phase", phase });
	}

	#append(body: CouncilEventBody): CouncilEvent {
		return this.#transcript.append(body);
	}

	#update(): void {
		this.#options.onUpdate?.(this.#snapshot());
	}

	#snapshot(): CouncilSnapshot {
		const ledger = this.#ledger;
		const active = ledger.activeVerification();
		const unresolved = ledger.challenges().filter(challenge => challenge.status !== "resolved");
		return {
			phase: this.#phase,
			round: this.#round,
			elapsedMs: this.#now() - this.#startedAt,
			members: this.#members.map(member => {
				const acceptance = ledger.acceptanceOf(member.info.id);
				return {
					...member.info,
					activity: member.activity,
					usage: member.usage,
					active: member.active,
					acceptance: acceptance && { proposalId: acceptance.proposalId, version: acceptance.version },
					challenges: unresolved
						.filter(challenge => challenge.author === member.info.id)
						.map(challenge => challenge.id),
					verdict: active ? (active.verdicts.get(member.info.id)?.verdict ?? "pending") : undefined,
				};
			}),
			proposals: ledger.proposals().map(proposal => {
				const version = currentVersion(proposal);
				return {
					id: proposal.id,
					version: version.version,
					title: version.title,
					status: proposal.status,
					acceptedBy: ledger.acceptersOf(proposal.id, version.version),
				};
			}),
			openChallenges: unresolved.length,
			verification: active && { proposalId: active.proposalId, version: active.version, attempt: active.attempt },
			usage: this.#totalUsage(),
			budgets: this.#options.budgets,
			outcome: this.#outcome,
		};
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Combine a turn with its follow-up nudge: the latest text wins, the evidence trail accumulates. */
function mergeTurns(first: CouncilTurnResult, second: CouncilTurnResult): CouncilTurnResult {
	return {
		text: second.text.trim() ? second.text : first.text,
		tools: [...first.tools, ...second.tools],
		error: second.error,
		aborted: second.aborted,
	};
}

function phaseError(tool: string, phase: CouncilPhase): string {
	switch (phase) {
		case "independent":
			return `${tool} is unavailable during independent analysis: record your own solution with council_propose. You will see and answer the other members once the debate starts.`;
		case "debate":
			return `${tool} is only available once every member accepts the same version and verification starts.`;
		case "verification":
			return `${tool} is unavailable during verification: record your verdict with council_verify.`;
		default:
			return `The council is not accepting actions during ${phase}.`;
	}
}
