/**
 * Consensus ledger — the single source of truth for council proposals,
 * challenges, acceptances, and verification.
 *
 * Every rule that decides consensus lives here and is independent of any
 * model: ids and versions are assigned by the ledger, a revision clears every
 * acceptance of its proposal, acceptances must name the exact current version,
 * and consensus is only declared after every member independently confirms
 * the candidate. Actions never throw for invalid input; they return an
 * actionable error the calling model can correct.
 */
import {
	COUNCIL_PROPOSAL_FIELDS,
	type CouncilAcceptance,
	type CouncilAcceptInput,
	type CouncilActionResult,
	type CouncilChallenge,
	type CouncilChallengeInput,
	type CouncilEventBody,
	type CouncilObjectionAssessment,
	type CouncilProposal,
	type CouncilProposalContent,
	type CouncilProposalField,
	type CouncilProposalVersion,
	type CouncilResolveInput,
	type CouncilRespondInput,
	type CouncilReviseInput,
	type CouncilVerification,
	type CouncilVerificationOutcome,
	type CouncilVerifyInput,
	type CouncilWithdrawInput,
} from "./types";

/** Minimum length of an acceptance or verification rationale. */
export const COUNCIL_MIN_RATIONALE_LENGTH = 30;

/** Longest accepted proposal title (titles are rendered on one line). */
export const COUNCIL_MAX_TITLE_LENGTH = 160;

export interface CouncilLedgerOptions {
	/** Member ids; consensus requires every one of them. */
	members: readonly string[];
	/** Receives one event per state change, in order. */
	emit?: (body: CouncilEventBody) => void;
	now?: () => number;
}

/** Verification in progress, as exposed to the engine and renderers. */
export interface CouncilActiveVerification {
	proposalId: string;
	version: number;
	attempt: number;
	/** Recorded verdicts by member; hidden from the transcript until concluded. */
	verdicts: ReadonlyMap<string, CouncilVerification>;
}

interface MutableVerification extends CouncilActiveVerification {
	verdicts: Map<string, CouncilVerification>;
}

/** A proposal reference with an optional explicit version (`P2`, `p2@1`, `P2 v1`). */
export interface CouncilProposalRef {
	proposalId: string;
	version?: number;
}

/**
 * Normalize a model-supplied id (`p3`, `P-3`, `3`) to its canonical form
 * (`P3`); `undefined` when it is not an id of the requested kind.
 */
export function normalizeCouncilRef(raw: string | number, prefix: "P" | "C"): string | undefined {
	const trimmed = String(raw).trim().toUpperCase();
	if (/^\d+$/.test(trimmed)) return `${prefix}${Number(trimmed)}`;
	const match = /^([PC])\s*-?\s*(\d+)$/.exec(trimmed);
	if (!match || match[1] !== prefix) return undefined;
	return `${prefix}${Number(match[2])}`;
}

/** Parse `P2`, `P2@1`, `P2 v1`, or `P2v1` into a proposal id and optional version. */
export function parseCouncilProposalRef(raw: string): CouncilProposalRef | undefined {
	const match = /^\s*([Pp]?\s*-?\s*\d+)\s*(?:(?:@|\s+[vV]|[vV])\s*(\d+))?\s*$/.exec(raw);
	if (!match) return undefined;
	const proposalId = normalizeCouncilRef(match[1] ?? "", "P");
	if (!proposalId) return undefined;
	return match[2] === undefined ? { proposalId } : { proposalId, version: Number(match[2]) };
}

/** The current (latest) version of a proposal. */
export function currentVersion(proposal: CouncilProposal): CouncilProposalVersion {
	const version = proposal.versions[proposal.versions.length - 1];
	if (!version) throw new Error(`${proposal.id} has no versions`);
	return version;
}

/**
 * Close a fenced code block that model-written markdown left open, so it
 * cannot swallow the rest of a transcript, prompt, or report it is embedded in.
 */
export function closeOpenFences(text: string): string {
	let open: string | undefined;
	for (const line of text.split("\n")) {
		const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
		if (!fence) continue;
		if (open === undefined) open = fence;
		else if (fence[0] === open[0] && fence.length >= open.length && line.trim() === fence) open = undefined;
	}
	return open === undefined ? text : `${text}\n${open}`;
}

function fail(error: string): CouncilActionResult {
	return { ok: false, error };
}

/** Trim model-supplied text and close any fence it left open. */
function clean(value: string | undefined): string {
	return typeof value === "string" ? closeOpenFences(value.trim()) : "";
}

/**
 * Normalize proposal sections. Without `base` every section is required;
 * with `base` omitted sections carry over and `changed` lists the rest.
 */
function buildContent(
	input: Partial<CouncilProposalContent>,
	base?: CouncilProposalContent,
): { content: CouncilProposalContent; changed: CouncilProposalField[] } | { error: string } {
	const content = {} as CouncilProposalContent;
	const missing: CouncilProposalField[] = [];
	const changed: CouncilProposalField[] = [];
	for (const field of COUNCIL_PROPOSAL_FIELDS) {
		const trimmed = clean(input[field]);
		const provided = field === "title" ? trimmed.replace(/\s+/g, " ") : trimmed;
		if (provided && provided !== base?.[field]) changed.push(field);
		const value = provided || base?.[field] || "";
		if (!value) missing.push(field);
		content[field] = value;
	}
	if (missing.length > 0) {
		return {
			error: `Every proposal section is required; missing: ${missing.join(", ")}. Fill each with substance (evidence: files, outputs, measurements, or sources).`,
		};
	}
	if (content.title.length > COUNCIL_MAX_TITLE_LENGTH) {
		return {
			error: `title must be one line of at most ${COUNCIL_MAX_TITLE_LENGTH} characters (got ${content.title.length}).`,
		};
	}
	return { content, changed };
}

/** Objection text for a challenge raised from a rejected verification. */
function verificationObjection(verdict: CouncilVerification): string {
	const unaddressed = verdict.assessments.filter(entry => entry.assessment === "unaddressed");
	if (unaddressed.length === 0) return verdict.rationale;
	return [
		verdict.rationale,
		"",
		...unaddressed.map(entry => `- ${entry.challengeId} unaddressed: ${entry.note}`),
	].join("\n");
}

export class CouncilLedger {
	readonly #members: readonly string[];
	readonly #emit: (body: CouncilEventBody) => void;
	readonly #now: () => number;
	readonly #proposals = new Map<string, CouncilProposal>();
	readonly #challenges = new Map<string, CouncilChallenge>();
	readonly #acceptances = new Map<string, CouncilAcceptance>();
	readonly #verifications: CouncilVerification[] = [];
	#active: MutableVerification | undefined;
	#attempts = 0;
	#nextProposal = 1;
	#nextChallenge = 1;
	#revision = 0;

	constructor(options: CouncilLedgerOptions) {
		if (options.members.length === 0 || new Set(options.members).size !== options.members.length) {
			throw new Error("Council member ids must be non-empty and unique");
		}
		this.#members = [...options.members];
		this.#emit = options.emit ?? (() => {});
		this.#now = options.now ?? Date.now;
	}

	get members(): readonly string[] {
		return this.#members;
	}

	/**
	 * Bumped by every action that changes what consensus depends on: proposals,
	 * versions, challenges, resolutions, withdrawals, acceptances, and
	 * verification outcomes. Responses do not count.
	 */
	get revision(): number {
		return this.#revision;
	}

	// ─── Queries ────────────────────────────────────────────────────────────

	proposals(): CouncilProposal[] {
		return [...this.#proposals.values()];
	}

	getProposal(ref: string): CouncilProposal | undefined {
		const id = normalizeCouncilRef(ref, "P");
		return id ? this.#proposals.get(id) : undefined;
	}

	challenges(): CouncilChallenge[] {
		return [...this.#challenges.values()];
	}

	getChallenge(ref: string): CouncilChallenge | undefined {
		const id = normalizeCouncilRef(ref, "C");
		return id ? this.#challenges.get(id) : undefined;
	}

	/** Every challenge raised against a proposal, oldest first. */
	challengesFor(proposalId: string): CouncilChallenge[] {
		return this.challenges().filter(challenge => challenge.proposalId === proposalId);
	}

	/** Challenges against a proposal that are `open` or `addressed`. */
	unresolvedChallengesFor(proposalId: string): CouncilChallenge[] {
		return this.challengesFor(proposalId).filter(challenge => challenge.status !== "resolved");
	}

	acceptances(): CouncilAcceptance[] {
		return this.#members.flatMap(member => this.#acceptances.get(member) ?? []);
	}

	acceptanceOf(member: string): CouncilAcceptance | undefined {
		return this.#acceptances.get(member);
	}

	/** Members accepting exactly `proposalId` at `version`, in member order. */
	acceptersOf(proposalId: string, version: number): string[] {
		return this.#members.filter(member => {
			const acceptance = this.#acceptances.get(member);
			return acceptance?.proposalId === proposalId && acceptance.version === version;
		});
	}

	/** Concluded verdicts across all verification attempts, in order. */
	verifications(): CouncilVerification[] {
		return [...this.#verifications];
	}

	activeVerification(): CouncilActiveVerification | undefined {
		return this.#active;
	}

	/** Open proposal whose current version every member accepts. */
	consensusCandidate(): { proposalId: string; version: number } | undefined {
		for (const proposal of this.#proposals.values()) {
			if (proposal.status !== "open") continue;
			const { version } = currentVersion(proposal);
			if (this.acceptersOf(proposal.id, version).length === this.#members.length) {
				return { proposalId: proposal.id, version };
			}
		}
		return undefined;
	}

	// ─── Actions ────────────────────────────────────────────────────────────

	propose(actor: string, round: number, input: CouncilProposalContent): CouncilActionResult {
		const unknown = this.#unknownMember(actor);
		if (unknown) return unknown;
		const built = buildContent(input);
		if ("error" in built) return fail(built.error);
		const id = `P${this.#nextProposal++}`;
		const version: CouncilProposalVersion = {
			...built.content,
			version: 1,
			author: actor,
			round,
			createdAt: this.#now(),
			addresses: [],
		};
		this.#proposals.set(id, { id, author: actor, status: "open", versions: [version] });
		this.#revision++;
		this.#emit({ type: "propose", member: actor, proposalId: id, version: structuredClone(version) });
		return {
			ok: true,
			ref: `${id} v1`,
			message: `Recorded ${id} v1 ("${version.title}"). Accepting is a separate, explicit step (council_accept) for every member, you included.`,
		};
	}

	revise(actor: string, round: number, input: CouncilReviseInput): CouncilActionResult {
		const unknown = this.#unknownMember(actor);
		if (unknown) return unknown;
		const lookup = this.#openProposal(input.proposalId, "revise");
		if ("error" in lookup) return fail(lookup.error);
		const { proposal } = lookup;
		const current = currentVersion(proposal);
		if (input.baseVersion !== current.version) {
			return fail(
				`Stale base_version: ${proposal.id} is at v${current.version} (you passed v${input.baseVersion}). Review the current version (council_view ${proposal.id}) and revise from it.`,
			);
		}
		const changeSummary = clean(input.changeSummary);
		if (!changeSummary) return fail("change_summary is required: state what changed and why.");
		const built = buildContent(input, current);
		if ("error" in built) return fail(built.error);
		if (built.changed.length === 0) {
			return fail(
				`No section of ${proposal.id} v${current.version} changed. Pass the full new text of each section you revise; omitted sections carry over.`,
			);
		}
		const addressed: CouncilChallenge[] = [];
		for (const raw of input.addresses ?? []) {
			const challenge = this.getChallenge(raw);
			if (!challenge || challenge.proposalId !== proposal.id) {
				return fail(`addresses: ${raw} is not a challenge against ${proposal.id}.`);
			}
			if (challenge.status === "resolved") {
				return fail(`addresses: ${challenge.id} is already resolved; list only open or addressed challenges.`);
			}
			if (!addressed.includes(challenge)) addressed.push(challenge);
		}

		const version: CouncilProposalVersion = {
			...built.content,
			version: current.version + 1,
			author: actor,
			round,
			createdAt: this.#now(),
			changeSummary,
			addresses: addressed.map(challenge => challenge.id),
		};
		proposal.versions.push(version);
		const invalidated = this.#clearAcceptances(proposal.id);
		for (const challenge of addressed) {
			challenge.status = "addressed";
			challenge.addressedBy = { version: version.version, author: actor };
		}
		this.#revision++;
		this.#emit({
			type: "revise",
			member: actor,
			proposalId: proposal.id,
			version: structuredClone(version),
			invalidated,
		});
		const cleared =
			invalidated.length > 0
				? ` Cleared ${invalidated.length} acceptance${invalidated.length === 1 ? "" : "s"} of earlier versions;`
				: "";
		return {
			ok: true,
			ref: `${proposal.id} v${version.version}`,
			message: `Recorded ${proposal.id} v${version.version} (changed: ${built.changed.join(", ")}).${cleared} every member, you included, must accept v${version.version} explicitly.`,
		};
	}

	challenge(actor: string, round: number, input: CouncilChallengeInput): CouncilActionResult {
		const unknown = this.#unknownMember(actor);
		if (unknown) return unknown;
		const lookup = this.#openProposal(input.proposalId, "challenge");
		if ("error" in lookup) return fail(lookup.error);
		const { proposal } = lookup;
		const objection = clean(input.objection);
		if (!objection) return fail("objection is required: name the flaw and why it matters.");
		const { challenge, retracted } = this.#createChallenge(actor, round, {
			proposalId: proposal.id,
			proposalVersion: currentVersion(proposal).version,
			objection,
			evidence: clean(input.evidence) || undefined,
		});
		const withdrawn = retracted ? ` Your acceptance of ${proposal.id} was withdrawn.` : "";
		return {
			ok: true,
			ref: challenge.id,
			message: `Recorded ${challenge.id} against ${proposal.id} v${challenge.proposalVersion}.${withdrawn} Resolve it with council_resolve once satisfied.`,
		};
	}

	respond(actor: string, round: number, input: CouncilRespondInput): CouncilActionResult {
		const unknown = this.#unknownMember(actor);
		if (unknown) return unknown;
		const challenge = this.getChallenge(input.challengeId);
		if (!challenge) return fail(`Unknown challenge ${input.challengeId}. Use council_view to list challenges.`);
		if (challenge.status === "resolved") return fail(`${challenge.id} is already resolved.`);
		const text = clean(input.response);
		if (!text) return fail("response is required.");
		challenge.responses.push({ author: actor, text, round, createdAt: this.#now() });
		this.#emit({ type: "respond", member: actor, challengeId: challenge.id, text });
		return { ok: true, ref: challenge.id, message: `Recorded your response to ${challenge.id}.` };
	}

	resolve(actor: string, round: number, input: CouncilResolveInput): CouncilActionResult {
		const unknown = this.#unknownMember(actor);
		if (unknown) return unknown;
		const challenge = this.getChallenge(input.challengeId);
		if (!challenge) return fail(`Unknown challenge ${input.challengeId}. Use council_view to list challenges.`);
		if (challenge.author !== actor) {
			return fail(
				`Only the challenger (${challenge.author}) can resolve ${challenge.id}. Respond with council_respond, or revise ${challenge.proposalId} to address it.`,
			);
		}
		if (challenge.status === "resolved") return fail(`${challenge.id} is already resolved.`);
		const note = clean(input.note);
		if (!note) return fail("note is required: say why the objection is satisfied or withdrawn.");
		challenge.status = "resolved";
		challenge.resolution = { kind: "author", note, round };
		this.#revision++;
		this.#emit({ type: "resolve", member: actor, challengeId: challenge.id, note });
		return { ok: true, ref: challenge.id, message: `Resolved ${challenge.id}.` };
	}

	withdraw(actor: string, round: number, input: CouncilWithdrawInput): CouncilActionResult {
		const unknown = this.#unknownMember(actor);
		if (unknown) return unknown;
		const lookup = this.#openProposal(input.proposalId, "withdraw");
		if ("error" in lookup) return fail(lookup.error);
		const { proposal } = lookup;
		if (proposal.author !== actor) {
			return fail(
				`Only ${proposal.id}'s author (${proposal.author}) can withdraw it. Challenge or revise it instead.`,
			);
		}
		const reason = clean(input.reason);
		if (!reason) return fail("reason is required.");
		proposal.status = "withdrawn";
		proposal.withdrawal = { reason, round };
		const invalidated = this.#clearAcceptances(proposal.id);
		const mooted: string[] = [];
		for (const challenge of this.unresolvedChallengesFor(proposal.id)) {
			challenge.status = "resolved";
			challenge.resolution = { kind: "moot", note: `${proposal.id} was withdrawn.`, round };
			mooted.push(challenge.id);
		}
		this.#revision++;
		this.#emit({ type: "withdraw", member: actor, proposalId: proposal.id, reason, invalidated, mooted });
		return { ok: true, ref: proposal.id, message: `Withdrew ${proposal.id}.` };
	}

	accept(actor: string, round: number, input: CouncilAcceptInput): CouncilActionResult {
		const unknown = this.#unknownMember(actor);
		if (unknown) return unknown;
		const lookup = this.#openProposal(input.proposalId, "accept");
		if ("error" in lookup) return fail(lookup.error);
		const { proposal } = lookup;
		const current = currentVersion(proposal);
		if (input.version !== current.version) {
			return fail(
				`${proposal.id} is at v${current.version}; only the current version can be accepted (you passed v${input.version}). Review it first (council_view ${proposal.id}).`,
			);
		}
		const rationale = clean(input.rationale);
		if (rationale.length < COUNCIL_MIN_RATIONALE_LENGTH) {
			return fail(
				`rationale must explain why you endorse this exact version (at least ${COUNCIL_MIN_RATIONALE_LENGTH} characters).`,
			);
		}
		const ownOpen = this.challengesFor(proposal.id).filter(
			challenge => challenge.author === actor && challenge.status === "open",
		);
		if (ownOpen.length > 0) {
			const ids = ownOpen.map(challenge => challenge.id).join(", ");
			return fail(
				`Your open challenge(s) ${ids} against ${proposal.id} still stand. Resolve them with council_resolve if satisfied, or keep debating.`,
			);
		}
		const previous = this.#acceptances.get(actor);
		if (previous?.proposalId === proposal.id && previous.version === current.version) {
			return {
				ok: true,
				ref: `${proposal.id} v${current.version}`,
				message: `You already accept ${proposal.id} v${current.version}.`,
			};
		}
		this.#acceptances.set(actor, {
			member: actor,
			proposalId: proposal.id,
			version: current.version,
			rationale,
			round,
			createdAt: this.#now(),
		});
		this.#revision++;
		this.#emit({
			type: "accept",
			member: actor,
			proposalId: proposal.id,
			version: current.version,
			rationale,
			replaced: previous ? { proposalId: previous.proposalId, version: previous.version } : undefined,
		});
		const accepted = this.acceptersOf(proposal.id, current.version).length;
		const replaced = previous ? ` (replacing your acceptance of ${previous.proposalId} v${previous.version})` : "";
		return {
			ok: true,
			ref: `${proposal.id} v${current.version}`,
			message: `Recorded your acceptance of ${proposal.id} v${current.version}${replaced}: ${accepted}/${this.#members.length} members accept it. Any revision clears every acceptance.`,
		};
	}

	/**
	 * Open verification of the current consensus candidate.
	 * @returns the attempt number.
	 */
	beginVerification(proposalId: string, version: number): number {
		if (this.#active) throw new Error(`Verification of ${this.#active.proposalId} is already running`);
		const candidate = this.consensusCandidate();
		if (candidate?.proposalId !== proposalId || candidate.version !== version) {
			throw new Error(`${proposalId} v${version} is not accepted by every member`);
		}
		const attempt = ++this.#attempts;
		this.#active = { proposalId, version, attempt, verdicts: new Map() };
		this.#emit({ type: "verification_start", proposalId, version, attempt });
		return attempt;
	}

	verify(actor: string, round: number, input: CouncilVerifyInput): CouncilActionResult {
		const unknown = this.#unknownMember(actor);
		if (unknown) return unknown;
		const active = this.#active;
		if (!active) return fail("No verification is running.");
		if (normalizeCouncilRef(input.proposalId, "P") !== active.proposalId || input.version !== active.version) {
			return fail(`This verification covers ${active.proposalId} v${active.version}; verify exactly that version.`);
		}
		if (input.verdict !== "confirm" && input.verdict !== "reject") {
			return fail('verdict must be "confirm" or "reject".');
		}
		const rationale = clean(input.rationale);
		if (rationale.length < COUNCIL_MIN_RATIONALE_LENGTH) {
			return fail(
				`rationale must give the substantive reasons for your verdict (at least ${COUNCIL_MIN_RATIONALE_LENGTH} characters).`,
			);
		}
		const pending = this.unresolvedChallengesFor(active.proposalId);
		const byId = new Map<string, CouncilObjectionAssessment>();
		for (const entry of input.assessments ?? []) {
			const challenge = this.getChallenge(entry.challengeId);
			if (!challenge) return fail(`assessments: unknown challenge ${entry.challengeId}.`);
			// Assessments of already-resolved objections carry no weight; skip them.
			if (!pending.includes(challenge)) continue;
			if (entry.assessment !== "addressed" && entry.assessment !== "unaddressed") {
				return fail(`assessments: ${challenge.id} must be "addressed" or "unaddressed".`);
			}
			const note = clean(entry.note);
			if (!note) return fail(`assessments: ${challenge.id} needs a note explaining the assessment.`);
			byId.set(challenge.id, { challengeId: challenge.id, assessment: entry.assessment, note });
		}
		const missing = pending.filter(challenge => !byId.has(challenge.id)).map(challenge => challenge.id);
		if (missing.length > 0) {
			return fail(`assessments must cover every objection awaiting confirmation; missing: ${missing.join(", ")}.`);
		}
		const assessments = pending.flatMap(challenge => byId.get(challenge.id) ?? []);
		const unaddressed = assessments.filter(entry => entry.assessment === "unaddressed");
		if (input.verdict === "confirm" && unaddressed.length > 0) {
			return fail(
				`A confirmation cannot leave objections unaddressed (${unaddressed.map(entry => entry.challengeId).join(", ")}). Reject instead, or reassess.`,
			);
		}
		active.verdicts.set(actor, {
			member: actor,
			proposalId: active.proposalId,
			version: active.version,
			attempt: active.attempt,
			verdict: input.verdict,
			rationale,
			assessments,
			risks: clean(input.risks) || undefined,
			round,
			createdAt: this.#now(),
		});
		return {
			ok: true,
			ref: `${active.proposalId} v${active.version}`,
			message: `Recorded your ${input.verdict} verdict on ${active.proposalId} v${active.version}. You may re-record it until verification ends.`,
		};
	}

	/**
	 * Settle the running verification: unanimous confirmation is consensus;
	 * otherwise every rejection becomes a challenge (withdrawing that member's
	 * acceptance), members without a verdict lose their acceptance, and the
	 * debate resumes. Verdict events are emitted here, so no member sees
	 * another's verdict while verification runs.
	 */
	concludeVerification(round: number): CouncilVerificationOutcome {
		const active = this.#active;
		if (!active) throw new Error("No verification is running");
		this.#active = undefined;
		const rejectedBy: string[] = [];
		const missing: string[] = [];
		for (const member of this.#members) {
			const verdict = active.verdicts.get(member);
			if (!verdict) {
				missing.push(member);
				continue;
			}
			this.#verifications.push(verdict);
			this.#emit({ type: "verdict", member, verification: structuredClone(verdict) });
			if (verdict.verdict === "reject") rejectedBy.push(member);
		}
		const confirmed = rejectedBy.length === 0 && missing.length === 0;
		const challengeIds: string[] = [];
		if (confirmed) {
			for (const challenge of this.unresolvedChallengesFor(active.proposalId)) {
				challenge.status = "resolved";
				challenge.resolution = {
					kind: "verified",
					note: `Confirmed addressed by the unanimous verification of ${active.proposalId} v${active.version}.`,
					round,
				};
			}
		} else {
			for (const member of rejectedBy) {
				const verdict = active.verdicts.get(member);
				if (!verdict) continue;
				const { challenge } = this.#createChallenge(member, round, {
					proposalId: active.proposalId,
					proposalVersion: active.version,
					objection: verificationObjection(verdict),
					evidence: verdict.risks,
					fromVerification: active.attempt,
				});
				challengeIds.push(challenge.id);
			}
			for (const member of missing) {
				this.#acceptances.delete(member);
				this.#emit({
					type: "notice",
					text: `${member} recorded no verdict on ${active.proposalId} v${active.version}; their acceptance was withdrawn.`,
				});
			}
		}
		this.#revision++;
		const outcome: CouncilVerificationOutcome = {
			proposalId: active.proposalId,
			version: active.version,
			attempt: active.attempt,
			confirmed,
			rejectedBy,
			missing,
			challengeIds,
		};
		this.#emit({ type: "verification_end", outcome: structuredClone(outcome) });
		return outcome;
	}

	// ─── Internals ──────────────────────────────────────────────────────────

	#unknownMember(actor: string): CouncilActionResult | undefined {
		return this.#members.includes(actor) ? undefined : fail(`Unknown council member ${actor}.`);
	}

	#openProposal(
		ref: string,
		verb: "revise" | "withdraw" | "accept" | "challenge",
	): { proposal: CouncilProposal } | { error: string } {
		const proposal = this.getProposal(ref);
		if (!proposal) return { error: `Unknown proposal ${ref}. Use council_view to list proposals.` };
		if (proposal.status !== "open") return { error: `${proposal.id} was withdrawn; you cannot ${verb} it.` };
		return { proposal };
	}

	/** Create a challenge, withdrawing the author's acceptance of the challenged proposal. */
	#createChallenge(
		actor: string,
		round: number,
		fields: Pick<CouncilChallenge, "proposalId" | "proposalVersion" | "objection" | "evidence" | "fromVerification">,
	): { challenge: CouncilChallenge; retracted: boolean } {
		const challenge: CouncilChallenge = {
			id: `C${this.#nextChallenge++}`,
			...fields,
			author: actor,
			status: "open",
			round,
			createdAt: this.#now(),
			responses: [],
		};
		this.#challenges.set(challenge.id, challenge);
		const retracted = this.#acceptances.get(actor)?.proposalId === fields.proposalId;
		if (retracted) this.#acceptances.delete(actor);
		this.#revision++;
		this.#emit({ type: "challenge", member: actor, challenge: structuredClone(challenge), retracted });
		return { challenge, retracted };
	}

	/** Drop every acceptance of `proposalId`; returns the affected members in member order. */
	#clearAcceptances(proposalId: string): string[] {
		const cleared = this.#members.filter(member => this.#acceptances.get(member)?.proposalId === proposalId);
		for (const member of cleared) this.#acceptances.delete(member);
		return cleared;
	}
}
