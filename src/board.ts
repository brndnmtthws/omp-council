/**
 * The `/council` widget: transcript events become styled permanent lines,
 * snapshots become live rows (status head, one row per member, open
 * proposals), repainted on the host's render loop.
 */
import type { Theme } from "@oh-my-pi/pi-coding-agent";
import { type Component, Container, Text, type TUI } from "@oh-my-pi/pi-tui";
import { formatDuration, formatNumber, sanitizeText } from "@oh-my-pi/pi-utils";
import {
	COUNCIL_OUTCOME_LABELS,
	type CouncilNameResolver,
	councilNameResolver,
	councilRoundLabel,
	formatCouncilCost,
} from "./render";
import type {
	CouncilEvent,
	CouncilMemberSnapshot,
	CouncilOutcome,
	CouncilPhase,
	CouncilRunUi,
	CouncilSnapshot,
} from "./types";

const TEXT_WIDTH = 160;
const TITLE_WIDTH = 48;
const DETAIL_WIDTH = 60;
const MAX_LOG_LINES = 14;

const PHASE_LABELS: Record<CouncilPhase, string> = {
	setup: "Setting up",
	independent: "Independent analysis",
	debate: "Debate",
	verification: "Verification",
	done: "Done",
};

/** One styled permanent line for a transcript event; undefined when the event is not worth a line. */
export function formatCouncilEventLine(
	event: CouncilEvent,
	name: CouncilNameResolver,
	theme: Theme,
): string | undefined {
	switch (event.type) {
		case "phase":
			if (event.phase === "setup" || event.phase === "done") return undefined;
			return theme.fg(
				"accent",
				`▸ ${PHASE_LABELS[event.phase]}${event.phase === "debate" ? ` · ${councilRoundLabel(event.round)}` : ""}`,
			);
		case "statement": {
			const preview = firstLine(event.text);
			return preview ? theme.fg("muted", `${name(event.member)}: ${preview}`) : undefined;
		}
		case "propose":
			return theme.fg(
				"success",
				`+ ${name(event.member)} proposed ${event.proposalId} "${oneLine(event.version.title, TITLE_WIDTH)}"`,
			);
		case "revise": {
			const change = firstLine(event.version.changeSummary ?? "");
			const cleared = event.invalidated.length;
			return theme.fg(
				"warning",
				`~ ${name(event.member)} revised ${event.proposalId} v${event.version.version}${change ? `: ${change}` : ""}${cleared > 0 ? ` · cleared ${cleared} acceptance${cleared === 1 ? "" : "s"}` : ""}`,
			);
		}
		case "challenge":
			return theme.fg(
				"error",
				`! ${name(event.member)} challenged ${event.challenge.proposalId} v${event.challenge.proposalVersion} (${event.challenge.id}): ${firstLine(event.challenge.objection)}`,
			);
		case "respond":
			return undefined;
		case "resolve":
			return theme.fg("success", `✓ ${name(event.member)} resolved ${event.challengeId}`);
		case "withdraw":
			return theme.fg("muted", `− ${name(event.member)} withdrew ${event.proposalId}: ${firstLine(event.reason)}`);
		case "accept":
			return theme.fg("success", `✓ ${name(event.member)} accepted ${event.proposalId} v${event.version}`);
		case "verification_start":
			return theme.fg(
				"accent",
				`◆ Verifying ${event.proposalId} v${event.version}${event.attempt > 1 ? ` (attempt ${event.attempt})` : ""}`,
			);
		case "verdict": {
			const { verdict, proposalId, version, rationale } = event.verification;
			return verdict === "confirm"
				? theme.fg("success", `✓ ${name(event.member)} confirms ${proposalId} v${version}: ${firstLine(rationale)}`)
				: theme.fg("error", `✗ ${name(event.member)} rejects ${proposalId} v${version}: ${firstLine(rationale)}`);
		}
		case "verification_end": {
			const { outcome } = event;
			if (outcome.confirmed) {
				return theme.fg("success", `✓ Consensus verified on ${outcome.proposalId} v${outcome.version}`);
			}
			const parts: string[] = [];
			if (outcome.rejectedBy.length > 0) parts.push(`rejected by ${outcome.rejectedBy.map(name).join(", ")}`);
			if (outcome.missing.length > 0) parts.push(`no verdict from ${outcome.missing.map(name).join(", ")}`);
			return theme.fg(
				"warning",
				`✗ Verification of ${outcome.proposalId} v${outcome.version} failed${parts.length > 0 ? `: ${parts.join("; ")}` : ""}`,
			);
		}
		case "turn_error":
			return theme.fg("error", `✗ ${name(event.member)}: ${oneLine(event.error, TEXT_WIDTH)}`);
		case "notice":
			return theme.fg("muted", `· ${oneLine(event.text, TEXT_WIDTH)}`);
		case "finished":
			return councilStatusLine(event.outcome, theme, event.reason);
	}
}

/** Styled one-line outcome, optionally followed by the reason. */
export function councilStatusLine(outcome: CouncilOutcome, theme: Theme, reason?: string): string {
	const label = `${COUNCIL_OUTCOME_LABELS[outcome]}${reason ? ` — ${oneLine(reason, TEXT_WIDTH)}` : ""}`;
	if (outcome === "consensus") return theme.fg("success", `✓ ${label}`);
	return outcome === "failed" ? theme.fg("error", `✗ ${label}`) : theme.fg("warning", `● ${label}`);
}

/** Live rows: a status head, one row per member, and the open proposals. */
export function renderCouncilLive(snapshot: CouncilSnapshot, spinner: string, theme: Theme): string[] {
	if (snapshot.outcome) return [];
	const { budgets, usage } = snapshot;
	const head = [PHASE_LABELS[snapshot.phase]];
	if (snapshot.round > 0) head.push(`round ${snapshot.round}${budgets.maxRounds ? `/${budgets.maxRounds}` : ""}`);
	head.push(
		`${formatDuration(snapshot.elapsedMs)}${budgets.maxDurationMs ? `/${formatDuration(budgets.maxDurationMs)}` : ""}`,
	);
	if (usage.tokens > 0 || budgets.maxTokens) {
		head.push(`${formatNumber(usage.tokens)}${budgets.maxTokens ? `/${formatNumber(budgets.maxTokens)}` : ""} tok`);
	}
	if (usage.cost > 0 || budgets.maxCostUsd) {
		head.push(
			`${formatCouncilCost(usage.cost)}${budgets.maxCostUsd ? `/${formatCouncilCost(budgets.maxCostUsd)}` : ""}`,
		);
	}
	const lines = [`${theme.fg("accent", spinner)} ${theme.fg("dim", head.join(" · "))}`];
	for (const member of snapshot.members) lines.push(memberRow(member, spinner, theme));
	const open = snapshot.proposals.filter(proposal => proposal.status === "open");
	if (open.length > 0) {
		const proposals = open.map(
			proposal =>
				`${proposal.id} v${proposal.version} "${oneLine(proposal.title, 40)}" ${proposal.acceptedBy.length}/${snapshot.members.length}`,
		);
		const challenges =
			snapshot.openChallenges > 0
				? ` · ${snapshot.openChallenges} open challenge${snapshot.openChallenges === 1 ? "" : "s"}`
				: "";
		lines.push(theme.fg("dim", `  Proposals: ${proposals.join(" · ")}${challenges}`));
	}
	return lines;
}

function memberRow(member: CouncilMemberSnapshot, spinner: string, theme: Theme): string {
	const { activity } = member;
	const stance: string[] = [];
	if (member.acceptance) {
		stance.push(theme.fg("success", `✓ ${member.acceptance.proposalId} v${member.acceptance.version}`));
	}
	if (member.challenges.length > 0) stance.push(theme.fg("warning", `! ${member.challenges.join(", ")}`));
	if (member.verdict === "pending") stance.push(theme.fg("dim", "verdict pending"));
	else if (member.verdict) stance.push(theme.fg(member.verdict === "confirm" ? "success" : "error", member.verdict));
	let doing: string;
	if (activity.state === "failed") doing = theme.fg("error", oneLine(activity.detail ?? "failed", DETAIL_WIDTH));
	else if (!member.active) doing = theme.fg("dim", "waiting");
	else if (activity.state === "tool" && activity.tool) {
		doing = `${activity.tool}${activity.detail ? ` ${oneLine(activity.detail, DETAIL_WIDTH)}` : ""}`;
	} else doing = "thinking";
	const meta: string[] = [];
	if (activity.toolCount > 0) meta.push(`${activity.toolCount} tools`);
	if (member.usage.tokens > 0) meta.push(`${formatNumber(member.usage.tokens)} tok`);
	return [
		member.active ? theme.fg("accent", spinner) : " ",
		member.name,
		theme.fg("dim", member.model),
		...stance,
		theme.fg("dim", "·"),
		doing,
		meta.length > 0 ? theme.fg("dim", `· ${meta.join(" · ")}`) : "",
	]
		.filter(Boolean)
		.join(" ");
}

/** Lines rebuilt on every paint, so spinner ticks and snapshots need only a render request. */
class CouncilWidget extends Container {
	constructor(readonly lines: () => readonly string[]) {
		super();
	}

	override render(width: number): readonly string[] {
		this.clear();
		for (const line of this.lines()) this.addChild(new Text(line, 1, 0));
		return super.render(width);
	}
}

/** Live view of one run: drives a widget and implements {@link CouncilRunUi}. */
export class CouncilBoard implements CouncilRunUi {
	readonly #theme: Theme;
	readonly #title: string;
	readonly #log: string[] = [];
	#snapshot: CouncilSnapshot | undefined;
	#name: CouncilNameResolver | undefined;
	#frame = 0;
	#tui: TUI | undefined;

	constructor(problem: string, theme: Theme) {
		this.#theme = theme;
		this.#title = `${theme.fg("accent", "◆ Council")} ${oneLine(problem, TEXT_WIDTH)}`;
	}

	/** Factory for `ctx.ui.setWidget`. */
	readonly widget = (tui: TUI): Component => {
		this.#tui = tui;
		return new CouncilWidget(() => this.#lines());
	};

	/** Advance the spinner. */
	tick(): void {
		this.#frame += 1;
		this.#tui?.requestRender();
	}

	log(text: string): void {
		this.#push(this.#theme.fg("muted", oneLine(text, TEXT_WIDTH * 2)));
	}

	onEvent(event: CouncilEvent, snapshot: CouncilSnapshot): void {
		this.#snapshot = snapshot;
		this.#name ??= councilNameResolver(snapshot.members);
		const line = formatCouncilEventLine(event, this.#name, this.#theme);
		if (line) this.#push(line);
		else this.#tui?.requestRender();
	}

	onUpdate(snapshot: CouncilSnapshot): void {
		this.#snapshot = snapshot;
	}

	#push(line: string): void {
		this.#log.push(line);
		if (this.#log.length > MAX_LOG_LINES) this.#log.splice(0, this.#log.length - MAX_LOG_LINES);
		this.#tui?.requestRender();
	}

	#lines(): string[] {
		const frames = this.#theme.getSpinnerFrames("activity");
		const spinner = frames[this.#frame % frames.length] ?? "·";
		const live = this.#snapshot ? renderCouncilLive(this.#snapshot, spinner, this.#theme) : [];
		return [this.#title, ...this.#log, ...live, this.#theme.fg("dim", "/council stop cancels")];
	}
}

/**
 * First substantive line of model-written markdown for a one-line preview:
 * heading/emphasis markers are dropped and bare labels ("**Problem**",
 * "Round 1 summary:") are skipped in favor of the first line with content.
 */
function firstLine(text: string): string {
	const lines = sanitizeText(text)
		.split("\n")
		.map(line =>
			line
				.replace(/^\s*(?:#+|[-*>]|\d+\.)\s+/, "")
				.replace(/\*\*|__/g, "")
				.trim(),
		)
		.filter(Boolean);
	const line = lines.find(candidate => !candidate.endsWith(":") && candidate.split(/\s+/).length >= 3) ?? lines[0];
	return line ? oneLine(line, TEXT_WIDTH) : "";
}

function oneLine(text: string, width: number): string {
	const flat = sanitizeText(text).replace(/\s+/g, " ").trim();
	return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat;
}
