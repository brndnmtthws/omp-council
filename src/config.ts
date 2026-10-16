/** Council configuration: the saved roster and budgets, named presets of them, and member model resolution. */
import * as path from "node:path";
import type { ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";
import { formatModelString, resolveCliModel } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { getAgentDir, isEnoent, isRecord } from "@oh-my-pi/pi-utils";
import type { CouncilBudgets, CouncilParticipantSpec, ResolvedCouncilMember } from "./types";

/** A council setup: the roster plus optional budgets (absent = unlimited). */
export interface CouncilSetup {
	members: CouncilParticipantSpec[];
	maxRounds?: number;
	maxMinutes?: number;
	maxTokens?: number;
	maxCostUsd?: number;
}

/** What `/council` saves: the current setup, plus named presets `/councilpreset` switches between. */
export interface CouncilConfig extends CouncilSetup {
	/** Absent when no preset is saved. */
	presets?: Record<string, CouncilSetup>;
}

export const COUNCIL_BUDGET_KEYS = ["maxRounds", "maxMinutes", "maxTokens", "maxCostUsd"] as const;

export type CouncilBudgetKey = (typeof COUNCIL_BUDGET_KEYS)[number];

/** A member resolved to a model, before its agent id is allocated. */
export type CouncilMemberPlan = Omit<ResolvedCouncilMember, "agentId">;

/** `<agent dir>/council.json`, shared by every project. */
export function councilConfigPath(): string {
	return path.join(getAgentDir(), "council.json");
}

/** The saved configuration; a missing file is an empty roster. */
export async function readCouncilConfig(file = councilConfigPath()): Promise<CouncilConfig> {
	let raw: unknown;
	try {
		raw = await Bun.file(file).json();
	} catch (error) {
		if (isEnoent(error)) return { members: [] };
		throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
	return normalizeCouncilConfig(raw, file);
}

export async function writeCouncilConfig(config: CouncilConfig, file = councilConfigPath()): Promise<void> {
	await Bun.write(file, `${JSON.stringify(config, null, "\t")}\n`);
}

/** Validate a parsed config; `label` prefixes error messages. Zero budgets mean unlimited and are dropped. */
export function normalizeCouncilConfig(raw: unknown, label: string): CouncilConfig {
	if (!isRecord(raw)) throw new Error(`${label} must be a JSON object`);
	const config: CouncilConfig = normalizeCouncilSetup(raw, label, "");
	if (raw.presets === undefined) return config;
	if (!isRecord(raw.presets)) throw new Error(`${label}: "presets" must be an object`);
	const presets: Record<string, CouncilSetup> = {};
	for (const [name, entry] of Object.entries(raw.presets)) {
		if (!isValidCouncilPresetName(name)) {
			throw new Error(`${label}: preset name "${name}" must be a letter, then letters, digits, - or _`);
		}
		if (!isRecord(entry)) throw new Error(`${label}: "presets.${name}" must be an object`);
		presets[name] = normalizeCouncilSetup(entry, label, `presets.${name}.`);
	}
	if (Object.keys(presets).length > 0) config.presets = presets;
	return config;
}

/** Validate the roster and budgets of the config or of one preset; `prefix` locates them in the file. */
function normalizeCouncilSetup(raw: Record<string, unknown>, label: string, prefix: string): CouncilSetup {
	const members = raw.members ?? [];
	if (!Array.isArray(members)) throw new Error(`${label}: "${prefix}members" must be a list`);
	const setup: CouncilSetup = {
		members: members.map((entry, index) =>
			normalizeCouncilParticipant(entry, `${label}: ${prefix}members[${index}]`),
		),
	};
	for (const key of COUNCIL_BUDGET_KEYS) {
		const value = raw[key];
		if (value === undefined) continue;
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
			throw new Error(`${label}: "${prefix}${key}" must be a non-negative number`);
		}
		if (value > 0) setup[key] = value;
	}
	return setup;
}

/** Validate one member entry: a model selector string or `{ name?, model, persona? }`. */
export function normalizeCouncilParticipant(entry: unknown, label: string): CouncilParticipantSpec {
	if (typeof entry === "string") {
		const model = entry.trim();
		if (!model) throw new Error(`${label} is an empty model selector`);
		return { model };
	}
	if (!isRecord(entry)) {
		throw new Error(`${label} must be a model selector string or an object with a "model" field`);
	}
	const { name, model, persona } = entry;
	if (typeof model !== "string" || !model.trim()) {
		throw new Error(`${label} needs a non-empty "model" selector`);
	}
	if (name !== undefined && (typeof name !== "string" || !name.trim())) {
		throw new Error(`${label} "name" must be a non-empty string`);
	}
	if (persona !== undefined && typeof persona !== "string") {
		throw new Error(`${label} "persona" must be a string`);
	}
	const spec: CouncilParticipantSpec = { model: model.trim() };
	if (typeof name === "string") spec.name = name.trim();
	if (persona?.trim()) spec.persona = persona.trim();
	return spec;
}

/** Engine budgets from a saved setup. */
export function resolveCouncilBudgets(setup: CouncilSetup): CouncilBudgets {
	const budgets: CouncilBudgets = {};
	if (setup.maxRounds) budgets.maxRounds = setup.maxRounds;
	if (setup.maxMinutes) budgets.maxDurationMs = Math.round(setup.maxMinutes * 60_000);
	if (setup.maxTokens) budgets.maxTokens = setup.maxTokens;
	if (setup.maxCostUsd) budgets.maxCostUsd = setup.maxCostUsd;
	return budgets;
}

/** Preset names: a letter, then letters, digits, `-` or `_` (the rule model presets use). */
const PRESET_NAME_PATTERN = /^[a-zA-Z][\w-]*$/;

export function isValidCouncilPresetName(name: string): boolean {
	return PRESET_NAME_PATTERN.test(name);
}

/** Saved presets, sorted by name. */
export function councilPresets(config: CouncilConfig): [name: string, setup: CouncilSetup][] {
	return Object.entries(config.presets ?? {}).sort(([a], [b]) => a.localeCompare(b));
}

/** Preset `name`, if saved. Own keys only, so `constructor` and friends never resolve. */
export function getCouncilPreset(config: CouncilConfig, name: string): CouncilSetup | undefined {
	const { presets } = config;
	return presets && Object.hasOwn(presets, name) ? presets[name] : undefined;
}

/** First preset (by name) identical to the current setup: the same members in the same order, the same budgets. */
export function findActiveCouncilPreset(config: CouncilConfig): string | undefined {
	const current = copyCouncilSetup(config);
	return councilPresets(config).find(([, preset]) => Bun.deepEquals(preset, current))?.[0];
}

/**
 * Save the current setup as preset `name`, replacing any preset of that name.
 *
 * @throws Error for an invalid name, or a roster too small to convene.
 */
export function saveCouncilPreset(config: CouncilConfig, name: string): void {
	if (!isValidCouncilPresetName(name)) {
		throw new Error(`Invalid preset name "${name}": use a letter, then letters, digits, - or _`);
	}
	if (config.members.length < 2) {
		throw new Error(`A council preset needs at least two members (found ${config.members.length}).`);
	}
	config.presets = { ...config.presets, [name]: copyCouncilSetup(config) };
}

/** Make preset `name` the current setup: its members and budgets replace the current ones wholesale. */
export function applyCouncilPreset(config: CouncilConfig, name: string): boolean {
	const preset = getCouncilPreset(config, name);
	if (!preset) return false;
	for (const key of COUNCIL_BUDGET_KEYS) delete config[key];
	Object.assign(config, copyCouncilSetup(preset));
	return true;
}

/** Delete preset `name`; false when it is not saved. */
export function deleteCouncilPreset(config: CouncilConfig, name: string): boolean {
	const { presets } = config;
	if (!presets || !Object.hasOwn(presets, name)) return false;
	delete presets[name];
	if (Object.keys(presets).length === 0) delete config.presets;
	return true;
}

/** The roster and budgets alone, copied so editing the current setup never edits a preset, or back. */
function copyCouncilSetup(setup: CouncilSetup): CouncilSetup {
	const copy: CouncilSetup = { members: setup.members.map(member => ({ ...member })) };
	for (const key of COUNCIL_BUDGET_KEYS) {
		if (setup[key] !== undefined) copy[key] = setup[key];
	}
	return copy;
}

/**
 * Unique display names and ledger ids. A missing name falls back to the model
 * id without its `provider/` prefix and `:thinking` suffix; repeats get `-2`,
 * `-3`, … (compared case-insensitively). Ids are lower-case slugs.
 */
export function assignCouncilIdentities(
	entries: readonly { name?: string; modelId: string }[],
): { name: string; id: string }[] {
	const names = new Set<string>();
	const ids = new Set<string>();
	return entries.map(entry => {
		const base =
			entry.name?.trim() || entry.modelId.slice(entry.modelId.lastIndexOf("/") + 1).split(":")[0] || "member";
		let name = base;
		for (let n = 2; names.has(name.toLowerCase()); n++) name = `${base}-${n}`;
		names.add(name.toLowerCase());
		const slug =
			name
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "-")
				.replace(/^-+|-+$/g, "") || "member";
		let id = slug;
		for (let n = 2; ids.has(id); n++) id = `${slug}-${n}`;
		ids.add(id);
		return { name, id };
	});
}

/** Resolve every participant to a model with credentials; requires at least two members. */
export function resolveCouncilMembers(
	specs: readonly CouncilParticipantSpec[],
	modelRegistry: ModelRegistry,
	settings: Settings,
): CouncilMemberPlan[] {
	if (specs.length < 2) {
		throw new Error(`A council needs at least two members (found ${specs.length}). Run /council to add members.`);
	}
	const resolved = specs.map(spec => {
		const who = `Council member "${spec.name ?? spec.model}"`;
		const result = resolveCliModel({ cliModel: spec.model, modelRegistry, settings });
		if (result.error || !result.model)
			throw new Error(`${who} (${spec.model}): ${result.error ?? "model not found"}`);
		if (!modelRegistry.hasConfiguredAuth(result.model)) {
			throw new Error(
				`${who} (${formatModelString(result.model)}): no credentials for provider ${result.model.provider}`,
			);
		}
		return { model: result.model, thinkingLevel: result.thinkingLevel };
	});
	const identities = assignCouncilIdentities(
		specs.map((spec, index) => ({ name: spec.name, modelId: resolved[index]!.model.id })),
	);
	return specs.map((spec, index) => {
		const { model, thinkingLevel } = resolved[index]!;
		const member: CouncilMemberPlan = { ...identities[index]!, model: formatModelString(model), modelRef: model };
		if (thinkingLevel !== undefined) member.thinking = thinkingLevel;
		if (spec.persona) member.persona = spec.persona;
		return member;
	});
}
