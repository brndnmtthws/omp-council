/**
 * Shared contracts for the multi-model Council.
 *
 * A deterministic engine drives N persistent member sessions (each on a
 * user-chosen model) through independent analysis, round-robin debate, and
 * independent verification. Members act only through structured ledger actions
 * (PROPOSE / REVISE / CHALLENGE / RESPOND / RESOLVE / WITHDRAW / ACCEPT /
 * VERIFY); the ledger, not any model, decides when every member has accepted
 * the exact same proposal version.
 */
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import type { CustomTool, ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";
import type { LocalProtocolOptions } from "@oh-my-pi/pi-coding-agent/internal-urls/local-protocol";

// ═══════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════

/** Normalized participant request, before model resolution. */
export interface CouncilParticipantSpec {
	/** Display name; derived from the model id when omitted. */
	name?: string;
	/** Model selector (`provider/id`, role alias, optional `:thinking` suffix). */
	model: string;
	/** Optional perspective appended to the member's system prompt. */
	persona?: string;
}

/** Optional safeguards. Absent or `0` means unlimited. */
export interface CouncilBudgets {
	maxRounds?: number;
	maxDurationMs?: number;
	/** Input + output + cache-write tokens across all sessions (cache reads excluded). */
	maxTokens?: number;
	maxCostUsd?: number;
}

/** A council member as the engine and UI see it. */
export interface CouncilMemberInfo {
	/** Ledger identity: unique lower-case slug (e.g. `claude`). */
	id: string;
	/** Unique display name (e.g. `Claude`). */
	name: string;
	/** Resolved model (`provider/id`). */
	model: string;
	/** Thinking level carried by the selector, if any. */
	thinking?: ConfiguredThinkingLevel;
	persona?: string;
	/** Agent-registry id of the member session; its transcript is `history://<agentId>`. */
	agentId: string;
}

/** Member plus the resolved model the session runtime instantiates. */
export interface ResolvedCouncilMember extends CouncilMemberInfo {
	modelRef: Model<Api>;
}

// ═══════════════════════════════════════════════════════════════════════════
// Ledger
// ═══════════════════════════════════════════════════════════════════════════

/** Every proposal version carries all of these sections. */
export const COUNCIL_PROPOSAL_FIELDS = [
	"title",
	"summary",
	"solution",
	"evidence",
	"tradeoffs",
	"implementation",
] as const;

export type CouncilProposalField = (typeof COUNCIL_PROPOSAL_FIELDS)[number];

export type CouncilProposalContent = Record<CouncilProposalField, string>;

export interface CouncilProposalVersion extends CouncilProposalContent {
	version: number;
	/** Member who wrote this version (the original author or a reviser). */
	author: string;
	round: number;
	createdAt: number;
	/** What changed relative to the previous version (revisions only). */
	changeSummary?: string;
	/** Challenge ids this version claims to address. */
	addresses: string[];
}

export type CouncilProposalStatus = "open" | "withdrawn";

export interface CouncilProposal {
	/** `P1`, `P2`, … */
	id: string;
	/** Member who opened the proposal; only they may withdraw it. */
	author: string;
	status: CouncilProposalStatus;
	withdrawal?: { reason: string; round: number };
	/** All versions, oldest first; the last entry is current. */
	versions: CouncilProposalVersion[];
}

/**
 * `open`: objection stands. `addressed`: a revision claims to address it, the
 * challenger has not confirmed. `resolved`: closed (see `resolution.kind`).
 */
export type CouncilChallengeStatus = "open" | "addressed" | "resolved";

export interface CouncilChallengeResponse {
	author: string;
	text: string;
	round: number;
	createdAt: number;
}

export interface CouncilChallenge {
	/** `C1`, `C2`, … */
	id: string;
	proposalId: string;
	/** Proposal version that was current when the challenge was raised. */
	proposalVersion: number;
	author: string;
	objection: string;
	evidence?: string;
	status: CouncilChallengeStatus;
	round: number;
	createdAt: number;
	responses: CouncilChallengeResponse[];
	/** Latest revision claiming to address this challenge. */
	addressedBy?: { version: number; author: string };
	/**
	 * `author`: the challenger resolved it. `verified`: confirmed addressed by a
	 * passed verification. `moot`: its proposal was withdrawn.
	 */
	resolution?: { kind: "author" | "verified" | "moot"; note: string; round: number };
	/** Verification attempt whose rejection raised this challenge. */
	fromVerification?: number;
}

/** A member's single current endorsement. */
export interface CouncilAcceptance {
	member: string;
	proposalId: string;
	version: number;
	rationale: string;
	round: number;
	createdAt: number;
}

export type CouncilVerdict = "confirm" | "reject";

export interface CouncilObjectionAssessment {
	challengeId: string;
	assessment: "addressed" | "unaddressed";
	note: string;
}

export interface CouncilVerification {
	member: string;
	proposalId: string;
	version: number;
	attempt: number;
	verdict: CouncilVerdict;
	rationale: string;
	assessments: CouncilObjectionAssessment[];
	risks?: string;
	round: number;
	createdAt: number;
}

export interface CouncilVerificationOutcome {
	proposalId: string;
	version: number;
	attempt: number;
	confirmed: boolean;
	/** Members that rejected. */
	rejectedBy: string[];
	/** Members that recorded no verdict (their acceptance is withdrawn). */
	missing: string[];
	/** Challenges raised from the rejections. */
	challengeIds: string[];
}

export type CouncilActionResult = { ok: true; message: string; ref?: string } | { ok: false; error: string };

export interface CouncilReviseInput extends Partial<CouncilProposalContent> {
	proposalId: string;
	/** Must equal the current version (optimistic concurrency). */
	baseVersion: number;
	changeSummary: string;
	addresses?: string[];
}

export interface CouncilChallengeInput {
	proposalId: string;
	objection: string;
	evidence?: string;
}

export interface CouncilRespondInput {
	challengeId: string;
	response: string;
}

export interface CouncilResolveInput {
	challengeId: string;
	note: string;
}

export interface CouncilWithdrawInput {
	proposalId: string;
	reason: string;
}

export interface CouncilAcceptInput {
	proposalId: string;
	version: number;
	rationale: string;
}

export interface CouncilVerifyInput {
	proposalId: string;
	version: number;
	verdict: CouncilVerdict;
	rationale: string;
	assessments?: CouncilObjectionAssessment[];
	risks?: string;
}

/**
 * Council actions bound to one member. The engine injects identity, round,
 * and phase gating; the council tools are thin wrappers over this surface.
 */
export interface CouncilActionApi {
	propose(input: CouncilProposalContent): CouncilActionResult;
	revise(input: CouncilReviseInput): CouncilActionResult;
	challenge(input: CouncilChallengeInput): CouncilActionResult;
	respond(input: CouncilRespondInput): CouncilActionResult;
	resolve(input: CouncilResolveInput): CouncilActionResult;
	withdraw(input: CouncilWithdrawInput): CouncilActionResult;
	accept(input: CouncilAcceptInput): CouncilActionResult;
	verify(input: CouncilVerifyInput): CouncilActionResult;
	/** Render council state (no ref / `state`), a proposal (`P1`, `P1@2`), or a challenge (`C3`). */
	view(ref?: string): string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Transcript events
// ═══════════════════════════════════════════════════════════════════════════

export type CouncilPhase = "setup" | "independent" | "debate" | "verification" | "done";

/** One tool call a member made during a turn (evidence trail). */
export interface CouncilToolCallSummary {
	tool: string;
	/** Primary argument, single line, bounded. */
	args: string;
	error?: boolean;
}

export type CouncilStatementKind = "analysis" | "turn" | "verification";

export type CouncilOutcome = "consensus" | "cancelled" | "budget" | "round-limit" | "failed";

export type CouncilEventBody =
	| { type: "phase"; phase: CouncilPhase }
	| { type: "statement"; member: string; kind: CouncilStatementKind; text: string; tools: CouncilToolCallSummary[] }
	| { type: "propose"; member: string; proposalId: string; version: CouncilProposalVersion }
	| { type: "revise"; member: string; proposalId: string; version: CouncilProposalVersion; invalidated: string[] }
	| { type: "challenge"; member: string; challenge: CouncilChallenge; retracted: boolean }
	| { type: "respond"; member: string; challengeId: string; text: string }
	| { type: "resolve"; member: string; challengeId: string; note: string }
	| { type: "withdraw"; member: string; proposalId: string; reason: string; invalidated: string[]; mooted: string[] }
	| {
			type: "accept";
			member: string;
			proposalId: string;
			version: number;
			rationale: string;
			replaced?: { proposalId: string; version: number };
	  }
	| { type: "verification_start"; proposalId: string; version: number; attempt: number }
	| { type: "verdict"; member: string; verification: CouncilVerification }
	| { type: "verification_end"; outcome: CouncilVerificationOutcome }
	| { type: "turn_error"; member: string; error: string }
	| { type: "notice"; text: string }
	| { type: "finished"; outcome: CouncilOutcome; reason: string };

export type CouncilEventType = CouncilEventBody["type"];

/** A transcript entry: ordered, timestamped, tagged with the round it happened in. */
export type CouncilEvent = CouncilEventBody & { seq: number; round: number; at: number };

// ═══════════════════════════════════════════════════════════════════════════
// Runtime seam (implemented by the AgentSession adapter and by test fakes)
// ═══════════════════════════════════════════════════════════════════════════

export interface CouncilUsage {
	/** Input + output + cache-write tokens (cache reads excluded). */
	tokens: number;
	/** USD; 0 when the provider reports no pricing. */
	cost: number;
}

export interface CouncilActivity {
	state: "idle" | "thinking" | "tool" | "retrying" | "compacting" | "failed";
	/** Tool currently running (state `tool`). */
	tool?: string;
	/** Short single-line detail: the running tool's primary argument, the provider error being retried, or the failure. */
	detail?: string;
	/** Tool calls made so far by this session. */
	toolCount: number;
	/** When this activity was reported (epoch ms); the board shows how long it has lasted. */
	since: number;
}

export interface CouncilTurnResult {
	/** Final assistant text of the turn (may be empty). */
	text: string;
	tools: CouncilToolCallSummary[];
	/** Provider/runtime failure that ended the turn. */
	error?: string;
	/** The turn was aborted (cancellation or budget stop). */
	aborted?: boolean;
}

export interface CouncilRuntimeHooks {
	onActivity(activity: CouncilActivity): void;
	/** Cumulative usage of this session; called after every model response. */
	onUsage(usage: CouncilUsage): void;
	/** A line worth keeping in the transcript, such as a member recovering from provider errors. */
	onNotice(text: string): void;
}

/** A persistent, multi-turn session that keeps its own reasoning context. */
export interface CouncilMemberRuntime {
	/** Send one prompt and resolve once the session is idle. Never throws for provider failures. */
	runTurn(prompt: string): Promise<CouncilTurnResult>;
	/** Abort the in-flight turn, if any. */
	abort(): Promise<void>;
	/** Release the session. Idempotent. */
	dispose(): Promise<void>;
}

export interface CouncilRuntimeFactory {
	createMember(
		member: CouncilMemberInfo,
		actions: CouncilActionApi,
		hooks: CouncilRuntimeHooks,
	): Promise<CouncilMemberRuntime>;
}

/** Inputs for the AgentSession-backed {@link CouncilRuntimeFactory}. */
export interface CouncilSessionRuntimeOptions {
	/** Project directory the council deliberates about; members work here. */
	cwd: string;
	settings: Settings;
	modelRegistry: ModelRegistry;
	members: ResolvedCouncilMember[];
	/** Builds the council tools bound to one member's ledger actions. */
	memberTools(actions: CouncilActionApi): CustomTool[];
	/** Directory receiving each member session as `<agentId>.jsonl`. */
	sessionDir: string;
	/** Shares the invoking session's `local://` root with members. */
	localProtocolOptions?: LocalProtocolOptions;
	/** Registry id of the invoking agent; members are registered beneath it. */
	parentAgentId?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Live view and results
// ═══════════════════════════════════════════════════════════════════════════

export interface CouncilMemberSnapshot extends CouncilMemberInfo {
	activity: CouncilActivity;
	usage: CouncilUsage;
	/** Whether this member's turn is in flight. */
	active: boolean;
	acceptance?: { proposalId: string; version: number };
	/** Unresolved challenges this member raised. */
	challenges: string[];
	/** Verdict in the running verification, if one is running. */
	verdict?: CouncilVerdict | "pending";
}

export interface CouncilProposalSnapshot {
	id: string;
	version: number;
	title: string;
	status: CouncilProposalStatus;
	/** Members accepting the current version. */
	acceptedBy: string[];
}

export interface CouncilSnapshot {
	phase: CouncilPhase;
	round: number;
	elapsedMs: number;
	members: CouncilMemberSnapshot[];
	proposals: CouncilProposalSnapshot[];
	/** Number of unresolved challenges. */
	openChallenges: number;
	verification?: { proposalId: string; version: number; attempt: number };
	usage: CouncilUsage;
	budgets: CouncilBudgets;
	/** Set once the run has stopped. */
	outcome?: CouncilOutcome;
}

export interface CouncilConsensus {
	proposal: CouncilProposal;
	version: CouncilProposalVersion;
	verifications: CouncilVerification[];
}

export interface CouncilResult {
	outcome: CouncilOutcome;
	/** Human-readable reason the run ended. */
	reason: string;
	problem: string;
	members: CouncilMemberInfo[];
	consensus?: CouncilConsensus;
	proposals: CouncilProposal[];
	challenges: CouncilChallenge[];
	acceptances: CouncilAcceptance[];
	/** Debate rounds started. */
	rounds: number;
	durationMs: number;
	usage: CouncilUsage;
	/** Usage per member id. */
	usageBySession: Record<string, CouncilUsage>;
	/** Markdown report: the agreed solution, or the progress at interruption. */
	report: string;
	/** Directory holding transcript.md and report.md. */
	outputDir?: string;
	transcriptPath?: string;
	reportPath?: string;
}

/** Inputs for {@link runCouncilEngine} (`council/engine.ts`). */
export interface CouncilEngineOptions {
	problem: string;
	/** Excerpt of the invoking conversation, handed to members with the problem. */
	context?: string;
	/** At least two members. */
	members: CouncilMemberInfo[];
	budgets: CouncilBudgets;
	factory: CouncilRuntimeFactory;
	/** Directory for transcript.md and report.md; omit to keep everything in memory. */
	outputDir?: string;
	signal?: AbortSignal;
	/** Every transcript event, with the snapshot after it applied. */
	onEvent?(event: CouncilEvent, snapshot: CouncilSnapshot): void;
	/** Activity/usage refresh (high frequency; repaint on your own cadence). */
	onUpdate?(snapshot: CouncilSnapshot): void;
	/** Clock override for tests. */
	now?(): number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Service seam
// ═══════════════════════════════════════════════════════════════════════════

export interface CouncilRequest {
	problem: string;
	/** Excerpt of the invoking conversation. */
	context?: string;
	/** At least two members. */
	participants: CouncilParticipantSpec[];
	budgets: CouncilBudgets;
}

export interface CouncilEnvironment {
	cwd: string;
	settings: Settings;
	modelRegistry: ModelRegistry;
	/** Builds the council tools bound to one member's ledger actions. */
	memberTools(actions: CouncilActionApi): CustomTool[];
	/**
	 * Artifacts root of the owning session. Member sessions are written here as
	 * `<agentId>.jsonl`; the transcript and report go to
	 * `<artifactsDir>/local/council/<runId>/` (readable as `local://council/<runId>/…`).
	 */
	artifactsDir: string;
	localProtocolOptions?: LocalProtocolOptions;
	/** Registry id of the invoking agent. */
	parentAgentId?: string;
}

/** Rendering seam the `/council` widget satisfies. */
export interface CouncilRunUi {
	/** Permanent informational line (setup steps). */
	log(text: string): void;
	onEvent(event: CouncilEvent, snapshot: CouncilSnapshot): void;
	onUpdate(snapshot: CouncilSnapshot): void;
}
