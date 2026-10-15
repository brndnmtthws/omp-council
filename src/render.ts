/**
 * Text views of council state: the compact state and deltas members receive
 * each turn, `council_view` answers, transcript markdown, and the final report.
 *
 * Renderers present ledger data only; instructions live in the prompt
 * templates that embed them.
 */
import { formatDuration, formatNumber, prompt, truncate } from "@oh-my-pi/pi-utils";
import {
	type CouncilLedger,
	closeOpenFences,
	currentVersion,
	normalizeCouncilRef,
	parseCouncilProposalRef,
} from "./ledger";
import reportTemplate from "./prompts/report.md" with { type: "text" };
import type {
	CouncilBudgets,
	CouncilChallenge,
	CouncilEvent,
	CouncilMemberInfo,
	CouncilOutcome,
	CouncilPhase,
	CouncilProposal,
	CouncilProposalVersion,
	CouncilResult,
	CouncilVerification,
} from "./types";

/** Resolves a member id to its display name. */
export type CouncilNameResolver = (memberId: string) => string;

/** Per-field cap for model-written text embedded in turn deltas. */
const DELTA_TEXT_LIMIT = 8_000;

export const COUNCIL_OUTCOME_LABELS: Record<CouncilOutcome, string> = {
	consensus: "Unanimous consensus",
	cancelled: "Cancelled",
	budget: "Budget exhausted",
	"round-limit": "Round limit reached",
	failed: "Failed",
};

const PHASE_TITLES: Record<CouncilPhase, string> = {
	setup: "Setup",
	independent: "Independent analysis",
	debate: "Debate",
	verification: "Verification",
	done: "Done",
};

export function formatCouncilCost(cost: number): string {
	return `$${cost >= 0.095 ? cost.toFixed(2) : cost.toFixed(3)}`;
}

/** Name resolver over a member list; unknown ids render as-is. */
export function councilNameResolver(members: readonly CouncilMemberInfo[]): CouncilNameResolver {
	const names = new Map(members.map(member => [member.id, member.name]));
	return id => names.get(id) ?? id;
}

/** `independent analysis` for round 0, `round N` otherwise. */
export function councilRoundLabel(round: number): string {
	return round === 0 ? "independent analysis" : `round ${round}`;
}

/** Budgets as one line (`none` when unlimited). */
export function formatCouncilBudgets(budgets: CouncilBudgets): string {
	const parts: string[] = [];
	if (budgets.maxRounds) parts.push(`${budgets.maxRounds} round${budgets.maxRounds === 1 ? "" : "s"}`);
	if (budgets.maxDurationMs) parts.push(formatDuration(budgets.maxDurationMs));
	if (budgets.maxTokens) parts.push(`${formatNumber(budgets.maxTokens)} tokens`);
	if (budgets.maxCostUsd) parts.push(formatCouncilCost(budgets.maxCostUsd));
	return parts.length > 0 ? parts.join(", ") : "none";
}

/** Bound model-written text for a turn delta; a cut inside a code block gets its fence closed. */
function cap(text: string, limit: number | undefined, pointer: string): string {
	if (limit === undefined || text.length <= limit) return text;
	return closeOpenFences(truncate(text, limit, `… [truncated; ${pointer}]`));
}

function names(ids: readonly string[], name: CouncilNameResolver): string {
	return ids.length > 0 ? ids.map(name).join(", ") : "nobody";
}

function authorship(proposal: CouncilProposal, version: CouncilProposalVersion, name: CouncilNameResolver): string {
	return version.author === proposal.author
		? `by ${name(proposal.author)}`
		: `opened by ${name(proposal.author)}, v${version.version} by ${name(version.author)}`;
}

function sections(version: CouncilProposalVersion, proposalId: string, limit?: number): string {
	const pointer = `council_view ${proposalId}@${version.version} shows the full text`;
	return [
		`**Summary:** ${cap(version.summary, limit, pointer)}`,
		"",
		"**Solution:**",
		cap(version.solution, limit, pointer),
		"",
		"**Evidence:**",
		cap(version.evidence, limit, pointer),
		"",
		"**Tradeoffs:**",
		cap(version.tradeoffs, limit, pointer),
		"",
		"**Implementation:**",
		cap(version.implementation, limit, pointer),
	].join("\n");
}

/** Full markdown of one proposal version. */
export function renderProposalVersion(
	proposal: CouncilProposal,
	version: CouncilProposalVersion,
	name: CouncilNameResolver,
): string {
	const lines = [
		`### ${proposal.id} v${version.version} — ${version.title}`,
		`_${authorship(proposal, version, name)}, ${councilRoundLabel(version.round)}${proposal.status === "withdrawn" ? " · withdrawn" : ""}_`,
	];
	if (version.changeSummary) {
		const addresses = version.addresses.length > 0 ? ` (addresses ${version.addresses.join(", ")})` : "";
		lines.push("", `**Changes from v${version.version - 1}:** ${version.changeSummary}${addresses}`);
	}
	lines.push("", sections(version, proposal.id));
	return lines.join("\n");
}

function challengeStatus(challenge: CouncilChallenge, name: CouncilNameResolver): string {
	switch (challenge.status) {
		case "open":
			return challenge.fromVerification ? `open (from verification attempt ${challenge.fromVerification})` : "open";
		case "addressed":
			return challenge.addressedBy
				? `addressed by v${challenge.addressedBy.version} (${name(challenge.addressedBy.author)}), awaiting confirmation`
				: "addressed, awaiting confirmation";
		case "resolved":
			switch (challenge.resolution?.kind) {
				case "verified":
					return "resolved: confirmed addressed in verification";
				case "moot":
					return "resolved: moot (proposal withdrawn)";
				default:
					return `resolved by ${name(challenge.author)}: ${challenge.resolution?.note ?? ""}`;
			}
	}
}

/** Full markdown of one challenge with its responses. */
export function renderChallenge(challenge: CouncilChallenge, name: CouncilNameResolver): string {
	const lines = [
		`**${challenge.id}** — ${name(challenge.author)} on ${challenge.proposalId} v${challenge.proposalVersion} (${councilRoundLabel(challenge.round)}) · ${challengeStatus(challenge, name)}`,
		`Objection: ${challenge.objection}`,
	];
	if (challenge.evidence) lines.push(`Evidence: ${challenge.evidence}`);
	for (const response of challenge.responses) {
		lines.push(`- ${name(response.author)} responded (${councilRoundLabel(response.round)}): ${response.text}`);
	}
	return lines.join("\n");
}

/** What one member (or the UI, with no viewer) may see. */
export interface CouncilViewContext {
	ledger: CouncilLedger;
	phase: CouncilPhase;
	name: CouncilNameResolver;
	/** Member whose perspective is rendered; omit for the full view. */
	viewer?: string;
}

/** Compact ledger state: proposals, acceptance tallies, unresolved challenges. */
export function renderCouncilState(ctx: CouncilViewContext): string {
	const { ledger, name, viewer } = ctx;
	// During independent analysis a member sees only its own work.
	const hidden = ctx.phase === "independent" && viewer !== undefined;
	const members = ledger.members;
	const lines = [
		`Members: ${members.map(name).join(", ")} — consensus needs all ${members.length} to accept the same version, followed by independent verification.`,
	];
	const proposals = ledger.proposals().filter(proposal => !hidden || proposal.author === viewer);
	if (proposals.length === 0) {
		lines.push("Proposals: none yet.");
	} else {
		lines.push("Proposals:");
		for (const proposal of proposals) {
			const version = currentVersion(proposal);
			if (proposal.status === "withdrawn") {
				lines.push(
					`- ${proposal.id} v${version.version} "${version.title}" — withdrawn by ${name(proposal.author)}: ${proposal.withdrawal?.reason ?? ""}`,
				);
				continue;
			}
			const accepters = ledger.acceptersOf(proposal.id, version.version);
			const parts = [
				`- ${proposal.id} v${version.version} "${version.title}" (${authorship(proposal, version, name)})`,
				`accepted by ${names(accepters, name)} (${accepters.length}/${members.length})`,
			];
			const unresolved = ledger.unresolvedChallengesFor(proposal.id);
			if (unresolved.length > 0) {
				parts.push(
					`unresolved: ${unresolved.map(challenge => `${challenge.id} (${challenge.status}, ${name(challenge.author)})`).join(", ")}`,
				);
			}
			lines.push(parts.join(" — "));
		}
	}
	if (hidden) lines.push("Other members' work stays hidden until the debate starts.");
	if (viewer) {
		const acceptance = ledger.acceptanceOf(viewer);
		lines.push(`Your acceptance: ${acceptance ? `${acceptance.proposalId} v${acceptance.version}` : "none"}`);
		const own = ledger
			.challenges()
			.filter(challenge => challenge.author === viewer && challenge.status !== "resolved")
			.map(challenge => `${challenge.id} on ${challenge.proposalId} (${challenge.status})`);
		if (own.length > 0) lines.push(`Your unresolved challenges: ${own.join(", ")}`);
	}
	const active = ledger.activeVerification();
	if (active)
		lines.push(`Verification of ${active.proposalId} v${active.version} is running (attempt ${active.attempt}).`);
	return lines.join("\n");
}

/** Answer a `council_view` request: state, a proposal (optionally at a version), or a challenge. */
export function renderCouncilView(ctx: CouncilViewContext, ref?: string): string {
	const { ledger, name, viewer } = ctx;
	const hidden = ctx.phase === "independent" && viewer !== undefined;
	const trimmed = ref?.trim() ?? "";
	if (!trimmed || trimmed.toLowerCase() === "state") {
		const lines = [renderCouncilState(ctx)];
		const unresolved = hidden ? [] : ledger.challenges().filter(challenge => challenge.status !== "resolved");
		if (unresolved.length > 0) {
			lines.push("", "Unresolved challenges:", ...unresolved.map(challenge => renderChallenge(challenge, name)));
		}
		return lines.join("\n");
	}
	const proposalRef = parseCouncilProposalRef(trimmed);
	if (proposalRef) {
		const proposal = ledger.getProposal(proposalRef.proposalId);
		if (!proposal) return `Unknown proposal ${proposalRef.proposalId}.`;
		if (hidden && proposal.author !== viewer) {
			return `${proposal.id} belongs to another member and stays hidden until the debate starts.`;
		}
		const current = currentVersion(proposal);
		const version =
			proposalRef.version === undefined
				? current
				: proposal.versions.find(entry => entry.version === proposalRef.version);
		if (!version) return `${proposal.id} has versions v1–v${current.version}.`;
		const lines = [renderProposalVersion(proposal, version, name)];
		if (version !== current) lines.push("", `(Older version; ${proposal.id} is at v${current.version}.)`);
		lines.push(
			"",
			`Versions: ${proposal.versions.map(entry => `v${entry.version} (${name(entry.author)}, ${councilRoundLabel(entry.round)})`).join(", ")}`,
			`Current version v${current.version} accepted by: ${names(ledger.acceptersOf(proposal.id, current.version), name)}`,
		);
		const challenges = ledger.challengesFor(proposal.id);
		if (challenges.length > 0) {
			lines.push("", "Challenges:", ...challenges.map(challenge => renderChallenge(challenge, name)));
		}
		return lines.join("\n");
	}
	const challenge = normalizeCouncilRef(trimmed, "C") ? ledger.getChallenge(trimmed) : undefined;
	if (challenge && !hidden) return renderChallenge(challenge, name);
	return `Unknown reference "${trimmed}". Use state, P<n>, P<n>@<version>, or C<n>.`;
}

function verdictLines(verification: CouncilVerification): string[] {
	const lines: string[] = [];
	if (verification.assessments.length > 0) {
		lines.push(
			`Assessments: ${verification.assessments.map(entry => `${entry.challengeId} ${entry.assessment} — ${entry.note}`).join("; ")}`,
		);
	}
	if (verification.risks) lines.push(`Residual risks: ${verification.risks}`);
	return lines;
}

/**
 * Markdown for one transcript event. `limit` caps model-written text (turn
 * deltas); the persisted transcript renders everything in full.
 */
export function renderCouncilEvent(event: CouncilEvent, name: CouncilNameResolver, limit?: number): string {
	const transcriptPointer = "the full text is in the council transcript";
	switch (event.type) {
		case "phase":
			// Setup and done frame the run without content of their own; notices and the finish line speak for them.
			if (event.phase === "setup" || event.phase === "done") return "";
			return `## ${PHASE_TITLES[event.phase]}${event.phase === "debate" && event.round > 0 ? ` — round ${event.round}` : ""}`;
		case "statement": {
			const heading =
				event.kind === "analysis"
					? "independent analysis"
					: event.kind === "verification"
						? "verification notes"
						: councilRoundLabel(event.round);
			const tools =
				event.tools.length > 0
					? `\n\n_Investigation: ${event.tools.map(call => `${call.tool}${call.args ? ` ${call.args}` : ""}${call.error ? " (failed)" : ""}`).join("; ")}_`
					: "";
			return `### ${name(event.member)} — ${heading}\n\n${cap(event.text || "(no message)", limit, transcriptPointer)}${tools}`;
		}
		case "propose":
			return `**${name(event.member)} proposed ${event.proposalId} v1 — ${event.version.title}**\n\n${sections(event.version, event.proposalId, limit)}`;
		case "revise": {
			const addresses =
				event.version.addresses.length > 0 ? ` (addresses ${event.version.addresses.join(", ")})` : "";
			const cleared = event.invalidated.length > 0 ? `\nAcceptances cleared: ${names(event.invalidated, name)}` : "";
			return `**${name(event.member)} revised ${event.proposalId} → v${event.version.version} — ${event.version.title}**\nChanges: ${event.version.changeSummary ?? ""}${addresses}${cleared}\n\n${sections(event.version, event.proposalId, limit)}`;
		}
		case "challenge": {
			const { challenge } = event;
			const origin = challenge.fromVerification ? " (rejected in verification)" : "";
			const retracted = event.retracted ? ` — ${name(event.member)}'s acceptance withdrawn` : "";
			const evidence = challenge.evidence ? `\nEvidence: ${cap(challenge.evidence, limit, transcriptPointer)}` : "";
			return `**${name(event.member)} challenged ${challenge.proposalId} v${challenge.proposalVersion} (${challenge.id})${origin}${retracted}**\nObjection: ${cap(challenge.objection, limit, transcriptPointer)}${evidence}`;
		}
		case "respond":
			return `**${name(event.member)} responded to ${event.challengeId}:** ${cap(event.text, limit, transcriptPointer)}`;
		case "resolve":
			return `**${name(event.member)} resolved ${event.challengeId}:** ${event.note}`;
		case "withdraw": {
			const cleared = event.invalidated.length > 0 ? `\nAcceptances cleared: ${names(event.invalidated, name)}` : "";
			const mooted = event.mooted.length > 0 ? `\nChallenges now moot: ${event.mooted.join(", ")}` : "";
			return `**${name(event.member)} withdrew ${event.proposalId}:** ${event.reason}${cleared}${mooted}`;
		}
		case "accept": {
			const replaced = event.replaced ? ` (replacing ${event.replaced.proposalId} v${event.replaced.version})` : "";
			return `**${name(event.member)} accepted ${event.proposalId} v${event.version}${replaced}:** ${event.rationale}`;
		}
		case "verification_start":
			return `**Verification of ${event.proposalId} v${event.version} started (attempt ${event.attempt}).**`;
		case "verdict": {
			const { verification } = event;
			const verb = verification.verdict === "confirm" ? "confirmed" : "rejected";
			return [
				`**${name(event.member)} ${verb} ${verification.proposalId} v${verification.version}:** ${verification.rationale}`,
				...verdictLines(verification),
			].join("\n");
		}
		case "verification_end": {
			const { outcome } = event;
			if (outcome.confirmed) {
				return `**Verification passed: every member confirmed ${outcome.proposalId} v${outcome.version}.**`;
			}
			const parts = [`**Verification of ${outcome.proposalId} v${outcome.version} failed**`];
			if (outcome.rejectedBy.length > 0) parts.push(`rejected by ${names(outcome.rejectedBy, name)}`);
			if (outcome.missing.length > 0) parts.push(`no verdict from ${names(outcome.missing, name)}`);
			if (outcome.challengeIds.length > 0) parts.push(`new challenges ${outcome.challengeIds.join(", ")}`);
			return `${parts.join(" — ")}. Debate resumes.`;
		}
		case "turn_error":
			return `_${name(event.member)}'s turn failed: ${event.error}_`;
		case "notice":
			return `_Notice: ${event.text}_`;
		case "finished":
			return `## Finished — ${COUNCIL_OUTCOME_LABELS[event.outcome]}: ${event.reason}`;
	}
}

/**
 * Events a member has not seen yet, excluding its own contributions and
 * structural markers.
 */
export function renderCouncilDelta(
	events: readonly CouncilEvent[],
	name: CouncilNameResolver,
	viewer?: string,
): string {
	const visible = events.filter(event => {
		switch (event.type) {
			case "phase":
			case "finished":
				return false;
			default:
				return !("member" in event) || event.member !== viewer;
		}
	});
	if (visible.length === 0) return "(nothing new)";
	return visible.map(event => renderCouncilEvent(event, name, DELTA_TEXT_LIMIT)).join("\n\n");
}

/** Every objection against a proposal, those awaiting confirmation first. */
export function renderCouncilObjections(ledger: CouncilLedger, proposalId: string, name: CouncilNameResolver): string {
	const challenges = ledger.challengesFor(proposalId);
	if (challenges.length === 0) return "No objections were raised against this proposal.";
	const pending = challenges.filter(challenge => challenge.status !== "resolved");
	const resolved = challenges.filter(challenge => challenge.status === "resolved");
	const lines = [
		"Awaiting confirmation (assess each):",
		...(pending.length > 0 ? pending.map(challenge => renderChallenge(challenge, name)) : ["None."]),
	];
	if (resolved.length > 0) lines.push("", "Resolved:", ...resolved.map(challenge => renderChallenge(challenge, name)));
	return lines.join("\n\n");
}

export interface CouncilTranscriptHeader {
	problem: string;
	members: readonly CouncilMemberInfo[];
	budgets: CouncilBudgets;
	startedAt: number;
}

/** Top of `transcript.md`. */
export function renderCouncilTranscriptHeader(header: CouncilTranscriptHeader): string {
	return [
		"# Council transcript",
		"",
		`**Problem:** ${header.problem}`,
		"",
		`**Members:** ${header.members.map(member => `${member.name} (${member.model}${member.thinking ? `:${member.thinking}` : ""}) — history://${member.agentId}`).join("; ")}`,
		`**Budgets:** ${formatCouncilBudgets(header.budgets)}`,
		`**Started:** ${new Date(header.startedAt).toISOString()}`,
	].join("\n");
}

function renderInterruptedProposals(result: Omit<CouncilResult, "report" | "reportPath">, name: CouncilNameResolver) {
	if (result.proposals.length === 0) return "No proposal was recorded.";
	const blocks: string[] = [];
	for (const proposal of result.proposals) {
		const version = currentVersion(proposal);
		if (proposal.status === "withdrawn") {
			blocks.push(
				`- ${proposal.id} v${version.version} "${version.title}" — withdrawn by ${name(proposal.author)}: ${proposal.withdrawal?.reason ?? ""}`,
			);
			continue;
		}
		const accepters = result.acceptances
			.filter(acceptance => acceptance.proposalId === proposal.id && acceptance.version === version.version)
			.map(acceptance => acceptance.member);
		blocks.push(
			[
				renderProposalVersion(proposal, version, name),
				"",
				`Accepted by ${names(accepters, name)} (${accepters.length}/${result.members.length}).`,
			].join("\n"),
		);
	}
	return blocks.join("\n\n");
}

function renderUnresolved(result: Omit<CouncilResult, "report" | "reportPath">, name: CouncilNameResolver): string {
	const positions = result.members.map(member => {
		const acceptance = result.acceptances.find(entry => entry.member === member.id);
		return `- ${member.name}: ${acceptance ? `accepts ${acceptance.proposalId} v${acceptance.version}` : "no acceptance"}`;
	});
	const open = result.challenges.filter(challenge => challenge.status !== "resolved");
	const lines = ["Positions:", ...positions];
	lines.push(
		"",
		...(open.length > 0
			? ["Unresolved challenges:", "", ...open.map(challenge => renderChallenge(challenge, name))]
			: ["No unresolved challenges."]),
	);
	return lines.join("\n");
}

/** The final report: the verified solution, or the state of play at interruption. */
export function renderCouncilReport(result: Omit<CouncilResult, "report" | "reportPath">): string {
	const name = councilNameResolver(result.members);
	const consensus = result.consensus;
	const objections = consensus
		? result.challenges.filter(challenge => challenge.proposalId === consensus.proposal.id)
		: [];
	return prompt.render(reportTemplate, {
		heading: consensus ? "Council consensus" : "Council stopped without consensus",
		problem: result.problem,
		outcomeLabel: COUNCIL_OUTCOME_LABELS[result.outcome],
		reason: result.reason,
		members: result.members.map(member => ({ name: member.name, model: member.model })),
		consensus: consensus && { id: consensus.proposal.id, ...consensus.version },
		verifications: consensus?.verifications.map(verification => ({
			name: name(verification.member),
			rationale: verification.rationale.replace(/\n/g, "\n  "),
			risks: verification.risks?.replace(/\n/g, "\n  "),
		})),
		objections:
			objections.length > 0 ? objections.map(challenge => renderChallenge(challenge, name)).join("\n\n") : undefined,
		proposals: consensus ? undefined : renderInterruptedProposals(result, name),
		unresolved: consensus ? undefined : renderUnresolved(result, name),
		progress: {
			rounds: result.rounds,
			duration: formatDuration(result.durationMs),
			tokens: formatNumber(result.usage.tokens),
			cost: formatCouncilCost(result.usage.cost),
		},
		usage: Object.entries(result.usageBySession).map(([id, usage]) => ({
			name: name(id),
			tokens: formatNumber(usage.tokens),
			cost: formatCouncilCost(usage.cost),
		})),
		transcriptPath: result.transcriptPath,
	});
}
