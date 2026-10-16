/**
 * omp-council — `/council` convenes several models on one problem. They
 * analyze it independently, debate through a structured ledger, and stop only
 * when every member accepts the exact same proposal version and an
 * independent verification round confirms it.
 *
 * Bare `/council` opens setup (members, budgets, and presets, saved to
 * `<agent dir>/council.json`); `/council <problem>` runs; `/council stop`
 * cancels. `/councilpreset` saves and switches named setups. The final
 * report is posted to the conversation.
 */
import * as path from "node:path";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionUISelectOption,
	getAgentDir,
} from "@oh-my-pi/pi-coding-agent";
import { formatModelString } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { buildSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { formatSessionHistoryMarkdown } from "@oh-my-pi/pi-coding-agent/session/session-history-format";
import type { AutocompleteItem } from "@oh-my-pi/pi-tui";
import { CouncilBoard } from "./board";
import {
	applyCouncilPreset,
	assignCouncilIdentities,
	COUNCIL_BUDGET_KEYS,
	type CouncilBudgetKey,
	type CouncilConfig,
	type CouncilSetup,
	councilPresets,
	deleteCouncilPreset,
	findActiveCouncilPreset,
	getCouncilPreset,
	readCouncilConfig,
	resolveCouncilBudgets,
	saveCouncilPreset,
	writeCouncilConfig,
} from "./config";
import { COUNCIL_OUTCOME_LABELS, formatCouncilBudgets } from "./render";
import { runCouncil } from "./service";
import { councilMemberToolkit } from "./tools";
import type { CouncilResult } from "./types";

const REPORT_MESSAGE_TYPE = "council-report";
const WIDGET_KEY = "council";
const SPINNER_INTERVAL_MS = 100;
/** Tail of the invoking conversation handed to the council as context. */
const MAX_CONTEXT_CHARS = 24_000;
/** Poll interval while a finished prompt unwinds after its agent loop settled. */
const IDLE_POLL_MS = 50;

const START = "▶ Start the council";
const ADD = "+ Add a member…";
const BUDGETS = "⚙ Budgets…";
const PRESETS = "★ Presets…";
const SAVE_PRESET = "+ Save this council as a preset…";
const DELETE_PRESET = "− Delete a preset…";

const BUDGET_LABELS: Record<CouncilBudgetKey, string> = {
	maxRounds: "Max debate rounds",
	maxMinutes: "Time budget (minutes)",
	maxTokens: "Token budget",
	maxCostUsd: "Cost budget (USD)",
};

const PRESET_USAGE = "Usage: /councilpreset [list | save <name> | switch <name> | delete <name>]";
const NO_PRESETS = "No council presets saved. Use /councilpreset save <name> to create one.";

/** `/councilpreset` subcommands, in completion order; a `usage` means the subcommand needs a name. */
const PRESET_SUBCOMMANDS: { name: string; description: string; usage?: string }[] = [
	{ name: "list", description: "List saved council presets" },
	{ name: "save", description: "Save the current members and budgets as a preset", usage: "<name>" },
	{ name: "switch", description: "Make a saved preset the current council", usage: "<name>" },
	{ name: "delete", description: "Delete a saved preset", usage: "<name>" },
];

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** A setup at a glance: `4 members: a, b, c, d · 30m, $2.00`. */
function describeSetup(setup: CouncilSetup): string {
	const names = assignCouncilIdentities(setup.members.map(member => ({ name: member.name, modelId: member.model })));
	const roster =
		names.length > 0
			? `${names.length} member${names.length === 1 ? "" : "s"}: ${names.map(entry => entry.name).join(", ")}`
			: "no members";
	const budgets = resolveCouncilBudgets(setup);
	return Object.keys(budgets).length > 0 ? `${roster} · ${formatCouncilBudgets(budgets)}` : roster;
}

/** One select option per saved preset, labelled with its name; the active one says so. */
function presetOptions(config: CouncilConfig): ExtensionUISelectOption[] {
	const current = findActiveCouncilPreset(config);
	return councilPresets(config).map(([name, preset]) => ({
		label: name,
		description: name === current ? `active · ${describeSetup(preset)}` : describeSetup(preset),
	}));
}

/** `/councilpreset` completions: the subcommand, then a saved preset name for `switch` and `delete`. */
function presetCompletions(prefix: string, presets: readonly ExtensionUISelectOption[]): AutocompleteItem[] | null {
	const space = prefix.indexOf(" ");
	if (space === -1) {
		// Nothing until a letter is typed, so Enter on a bare `/councilpreset ` still opens the picker.
		if (!prefix) return null;
		const typed = prefix.toLowerCase();
		const items = PRESET_SUBCOMMANDS.filter(sub => sub.name.startsWith(typed)).map(sub => ({
			value: `${sub.name} `,
			label: sub.name,
			description: sub.description,
			hint: `${sub.name.slice(typed.length)}${sub.usage ? ` ${sub.usage}` : ""}` || undefined,
		}));
		return items.length > 0 ? items : null;
	}
	const sub = prefix.slice(0, space);
	if (sub !== "switch" && sub !== "delete") return null;
	const typed = prefix.slice(space + 1).toLowerCase();
	const items = presets
		.filter(preset => preset.label.toLowerCase().startsWith(typed))
		.map(preset => ({ value: `${sub} ${preset.label}`, label: preset.label, description: preset.description }));
	return items.length > 0 ? items : null;
}

export default function council(pi: ExtensionAPI): void {
	const memberTools = councilMemberToolkit(pi.arktype);
	let active: AbortController | undefined;
	/** Saved presets as of the last config read or write: argument completion cannot await a read. */
	let knownPresets: ExtensionUISelectOption[] = [];

	async function loadConfig(): Promise<CouncilConfig> {
		const config = await readCouncilConfig();
		knownPresets = presetOptions(config);
		return config;
	}

	async function saveConfig(config: CouncilConfig): Promise<void> {
		await writeCouncilConfig(config);
		knownPresets = presetOptions(config);
	}

	pi.registerCommand("council", {
		description: "Multi-model council that debates to unanimous consensus (bare: setup · stop: cancel)",
		handler: async (args, ctx) => {
			const text = args.trim();
			if (text === "stop") {
				if (active) active.abort(new Error("Cancelled by the user."));
				else ctx.ui.notify("No council is running.", "info");
				return;
			}
			if (active) {
				ctx.ui.notify("A council is already running — /council stop cancels it.", "warning");
				return;
			}
			let config: CouncilConfig;
			try {
				config = await loadConfig();
			} catch (error) {
				ctx.ui.notify(errorText(error), "error");
				return;
			}
			let problem: string | undefined = text;
			if (!text || config.members.length < 2) {
				if (!ctx.hasUI) {
					ctx.ui.notify("Configure at least two members with /council in the interactive TUI first.", "error");
					return;
				}
				problem = await setup(ctx, config, text);
			}
			if (!problem) return;
			const controller = new AbortController();
			active = controller;
			const sessionId = ctx.sessionManager.getSessionId();
			// Runs in the background so the editor stays usable; run() and postReport() contain every failure.
			void run(ctx, problem, controller.signal)
				.finally(() => {
					if (active === controller) active = undefined;
				})
				.then(result => result && postReport(ctx, sessionId, result));
		},
	});

	pi.registerCommand("councilpreset", {
		description: "Save and switch council presets (members + budgets)",
		getArgumentCompletions: prefix => presetCompletions(prefix, knownPresets),
		handler: async (args, ctx) => {
			let config: CouncilConfig;
			try {
				config = await loadConfig();
			} catch (error) {
				ctx.ui.notify(errorText(error), "error");
				return;
			}
			const text = args.trim();
			try {
				if (text || !ctx.hasUI) {
					await presetCommand(ctx, config, text);
					return;
				}
				const options = presetOptions(config);
				if (options.length === 0) {
					ctx.ui.notify(NO_PRESETS, "info");
					return;
				}
				const picked = await ctx.ui.select("Switch the council to a preset", options);
				// Picked, not typed: like the setup menu, ask before replacing a council no preset saves.
				if (picked !== undefined && (await loadPreset(ctx, config, picked))) {
					ctx.ui.notify(`Switched to council preset "${picked}": ${describeSetup(config)}`, "info");
				}
			} catch (error) {
				ctx.ui.notify(`Could not save the council: ${errorText(error)}`, "error");
			}
		},
	});

	pi.on("session_start", async () => {
		try {
			await loadConfig();
		} catch {
			// Primes preset completion only; the commands report an unreadable file when they read it.
		}
	});

	pi.on("session_shutdown", () => {
		active?.abort(new Error("Session ended."));
	});

	/** Setup menu; resolves to the problem once the user starts the council. */
	async function setup(
		ctx: ExtensionCommandContext,
		config: CouncilConfig,
		problem: string,
	): Promise<string | undefined> {
		for (;;) {
			const { members } = config;
			const names = assignCouncilIdentities(members.map(member => ({ name: member.name, modelId: member.model })));
			const memberLabels = names.map(entry => `● ${entry.name}`);
			const ready = members.length >= 2;
			const preset = findActiveCouncilPreset(config);
			const heading = preset ? `Council "${preset}"` : "Council";
			const saved = councilPresets(config).map(([name]) => (name === preset ? `${name} (active)` : name));
			const options = [
				...members.map((member, index) => ({ label: memberLabels[index]!, description: member.model })),
				...(ready ? [{ label: START, description: problem || "You will be asked for the problem" }] : []),
				{
					label: ADD,
					description: "Any model you have credentials for; a model can sit twice under different names",
				},
				{ label: BUDGETS, description: formatCouncilBudgets(resolveCouncilBudgets(config)) },
				{ label: PRESETS, description: saved.length > 0 ? saved.join(" · ") : "None saved yet" },
			];
			const choice = await ctx.ui.select(
				ready
					? `${heading} — ${members.length} members (select one to remove it)`
					: `${heading} — add at least two members (${members.length} so far)`,
				options,
				{ initialIndex: members.length },
			);
			if (choice === undefined) return undefined;
			try {
				if (choice === START) {
					if (problem) return problem;
					const typed = (await ctx.ui.input("What should the council solve?"))?.trim();
					if (typed) return typed;
				} else if (choice === ADD) {
					await addMember(ctx, config);
				} else if (choice === BUDGETS) {
					await editBudgets(ctx, config);
				} else if (choice === PRESETS) {
					await presetsMenu(ctx, config);
				} else {
					const index = memberLabels.indexOf(choice);
					const member = members[index];
					if (member && (await ctx.ui.confirm(`Remove ${names[index]!.name}?`, member.model))) {
						members.splice(index, 1);
						await saveConfig(config);
					}
				}
			} catch (error) {
				ctx.ui.notify(`Could not save the council: ${errorText(error)}`, "error");
			}
		}
	}

	async function addMember(ctx: ExtensionCommandContext, config: CouncilConfig): Promise<void> {
		const models = ctx.modelRegistry.getAvailable();
		if (models.length === 0) {
			ctx.ui.notify("No models with credentials — run /login first.", "error");
			return;
		}
		const model = await ctx.ui.select(
			"Add a council member (type to filter)",
			models.map(entry => ({ label: formatModelString(entry), description: entry.name })),
		);
		if (model === undefined) return;
		const fallback = assignCouncilIdentities([{ modelId: model }])[0]!.name;
		const name = await ctx.ui.input(`Name for ${model} (Enter keeps "${fallback}")`);
		if (name === undefined) return;
		config.members.push(name.trim() ? { name: name.trim(), model } : { model });
		await saveConfig(config);
	}

	async function editBudgets(ctx: ExtensionCommandContext, config: CouncilConfig): Promise<void> {
		const choice = await ctx.ui.select(
			"Council budgets",
			COUNCIL_BUDGET_KEYS.map(key => ({
				label: BUDGET_LABELS[key],
				description: String(config[key] ?? "unlimited"),
			})),
		);
		const key = COUNCIL_BUDGET_KEYS.find(candidate => BUDGET_LABELS[candidate] === choice);
		if (!key) return;
		const raw = await ctx.ui.input(`${BUDGET_LABELS[key]} — 0 or empty means unlimited (now ${config[key] ?? 0})`);
		if (raw === undefined) return;
		const value = Number(raw.trim() || "0");
		if (!Number.isFinite(value) || value < 0) {
			ctx.ui.notify("Enter a non-negative number.", "error");
			return;
		}
		if (value > 0) config[key] = key === "maxRounds" || key === "maxTokens" ? Math.ceil(value) : value;
		else delete config[key];
		await saveConfig(config);
	}

	/** Load a preset (replacing the current members and budgets), save this council as one, or delete one. */
	async function presetsMenu(ctx: ExtensionCommandContext, config: CouncilConfig): Promise<void> {
		const presets = presetOptions(config);
		const options = [
			...presets,
			...(config.members.length >= 2 ? [{ label: SAVE_PRESET, description: describeSetup(config) }] : []),
			...(presets.length > 0 ? [{ label: DELETE_PRESET, description: "Pick one, then confirm" }] : []),
		];
		if (options.length === 0) {
			ctx.ui.notify("No presets yet — add at least two members, then save them as one.", "info");
			return;
		}
		const choice = await ctx.ui.select(
			presets.length > 0 ? "Council presets (select one to load it)" : "Council presets",
			options,
		);
		if (choice === SAVE_PRESET) await savePreset(ctx, config);
		else if (choice === DELETE_PRESET) await deletePreset(ctx, config);
		else if (choice !== undefined) await loadPreset(ctx, config, choice);
	}

	/** Make preset `name` the current council; false when the user declines replacing an unsaved one. */
	async function loadPreset(ctx: ExtensionCommandContext, config: CouncilConfig, name: string): Promise<boolean> {
		const current = findActiveCouncilPreset(config);
		if (name === current) return true;
		// Loading over a council that no preset holds would lose it.
		if (
			current === undefined &&
			config.members.length > 0 &&
			!(await ctx.ui.confirm(
				`Load preset "${name}"?`,
				`It replaces the current council (${describeSetup(config)}), which no preset saves.`,
			))
		) {
			return false;
		}
		applyCouncilPreset(config, name);
		await saveConfig(config);
		return true;
	}

	async function savePreset(ctx: ExtensionCommandContext, config: CouncilConfig): Promise<void> {
		const name = (await ctx.ui.input("Preset name (a letter, then letters, digits, - or _)"))?.trim();
		if (!name) return;
		const existing = getCouncilPreset(config, name);
		if (existing && !(await ctx.ui.confirm(`Replace preset "${name}"?`, describeSetup(existing)))) return;
		try {
			saveCouncilPreset(config, name);
		} catch (error) {
			ctx.ui.notify(errorText(error), "error");
			return;
		}
		await saveConfig(config);
		ctx.ui.notify(`Saved council preset "${name}"`, "info");
	}

	async function deletePreset(ctx: ExtensionCommandContext, config: CouncilConfig): Promise<void> {
		const name = await ctx.ui.select("Delete a council preset", presetOptions(config));
		if (name === undefined) return;
		const preset = getCouncilPreset(config, name);
		if (!preset || !(await ctx.ui.confirm(`Delete preset "${name}"?`, describeSetup(preset)))) return;
		deleteCouncilPreset(config, name);
		await saveConfig(config);
		ctx.ui.notify(`Deleted council preset "${name}"`, "info");
	}

	/** `/councilpreset <subcommand> [name]`, reported through notifications; saves the config when it changes. */
	async function presetCommand(ctx: ExtensionCommandContext, config: CouncilConfig, text: string): Promise<void> {
		const [sub = "list", ...rest] = text.split(/\s+/).filter(Boolean);
		const name = rest.join(" ");
		if (!name && PRESET_SUBCOMMANDS.find(entry => entry.name === sub)?.usage) {
			ctx.ui.notify(`Usage: /councilpreset ${sub} <name>`, "warning");
			return;
		}
		switch (sub) {
			case "list": {
				const current = findActiveCouncilPreset(config);
				const names = councilPresets(config).map(([preset]) =>
					preset === current ? `${preset} (active)` : preset,
				);
				ctx.ui.notify(names.length > 0 ? `Council presets: ${names.join(", ")}` : NO_PRESETS, "info");
				return;
			}
			case "save":
				try {
					saveCouncilPreset(config, name);
				} catch (error) {
					ctx.ui.notify(errorText(error), "error");
					return;
				}
				await saveConfig(config);
				ctx.ui.notify(`Saved council preset "${name}": ${describeSetup(config)}`, "info");
				return;
			case "switch":
				if (!applyCouncilPreset(config, name)) {
					ctx.ui.notify(`Council preset not found: ${name}`, "error");
					return;
				}
				await saveConfig(config);
				ctx.ui.notify(`Switched to council preset "${name}": ${describeSetup(config)}`, "info");
				return;
			case "delete":
				if (!deleteCouncilPreset(config, name)) {
					ctx.ui.notify(`Council preset not found: ${name}`, "error");
					return;
				}
				await saveConfig(config);
				ctx.ui.notify(`Deleted council preset "${name}"`, "info");
				return;
			default:
				ctx.ui.notify(PRESET_USAGE, "warning");
		}
	}

	/** One council run: the widget while it deliberates, then the outcome; undefined when it could not run. */
	async function run(
		ctx: ExtensionCommandContext,
		problem: string,
		signal: AbortSignal,
	): Promise<CouncilResult | undefined> {
		const board = new CouncilBoard(problem, ctx.ui.theme);
		ctx.ui.setWidget(WIDGET_KEY, board.widget, { placement: "aboveEditor" });
		const timer = ctx.setInterval(() => board.tick(), SPINNER_INTERVAL_MS);
		try {
			const config = await loadConfig();
			const sessionArtifacts = ctx.sessionManager.getArtifactsDir();
			const result = await runCouncil(
				{
					problem,
					context: conversationContext(ctx),
					participants: config.members,
					budgets: resolveCouncilBudgets(config),
				},
				{
					cwd: ctx.cwd,
					settings: pi.pi.settings,
					modelRegistry: ctx.modelRegistry,
					memberTools,
					artifactsDir: sessionArtifacts ?? path.join(getAgentDir(), "council"),
					localProtocolOptions: sessionArtifacts ? ctx.localProtocolOptions : undefined,
					parentAgentId: ctx.agent.id || MAIN_AGENT_ID,
				},
				board,
				signal,
			);
			ctx.ui.notify(
				`Council: ${COUNCIL_OUTCOME_LABELS[result.outcome]} — ${result.reason}`,
				result.outcome === "consensus" ? "info" : "warning",
			);
			return result;
		} catch (error) {
			ctx.ui.notify(`Council failed: ${errorText(error)}`, "error");
			return undefined;
		} finally {
			ctx.clearTimer(timer);
			ctx.ui.setWidget(WIDGET_KEY, undefined);
		}
	}

	/**
	 * Post the report into the session that convened the council, once its agent
	 * is idle: sent mid-turn it would be steered into unrelated work, and only the
	 * default idle delivery paints a display message right away.
	 */
	async function postReport(ctx: ExtensionCommandContext, sessionId: string, result: CouncilResult): Promise<void> {
		try {
			for (;;) {
				await ctx.waitForIdle();
				if (ctx.isIdle()) break;
				// The agent loop settled but its prompt is still unwinding; a message sent now would start a turn.
				await Bun.sleep(IDLE_POLL_MS);
			}
			if (ctx.sessionManager.getSessionId() !== sessionId) {
				ctx.ui.notify(`Council report: ${result.reportPath ?? "not saved"}`, "info");
				return;
			}
			pi.sendMessage(
				{
					customType: REPORT_MESSAGE_TYPE,
					content: result.report,
					display: true,
					attribution: "user",
					details: {
						outcome: result.outcome,
						reason: result.reason,
						transcriptPath: result.transcriptPath,
						reportPath: result.reportPath,
						rounds: result.rounds,
						usage: result.usage,
					},
				},
				{ triggerTurn: false },
			);
		} catch (error) {
			ctx.ui.notify(`Could not post the council report: ${errorText(error)}`, "error");
		}
	}
}

/** The conversation so far, newest last; optional context, so failures yield none. */
function conversationContext(ctx: ExtensionCommandContext): string | undefined {
	try {
		const { messages } = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
		if (messages.length === 0) return undefined;
		const history = formatSessionHistoryMarkdown(messages).trim();
		if (!history) return undefined;
		return history.length > MAX_CONTEXT_CHARS ? history.slice(-MAX_CONTEXT_CHARS) : history;
	} catch {
		return undefined;
	}
}
