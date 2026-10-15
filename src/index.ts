/**
 * omp-council — `/council` convenes several models on one problem. They
 * analyze it independently, debate through a structured ledger, and stop only
 * when every member accepts the exact same proposal version and an
 * independent verification round confirms it.
 *
 * Bare `/council` opens setup (members and budgets, saved to
 * `<agent dir>/council.json`); `/council <problem>` runs; `/council stop`
 * cancels. The final report is posted to the conversation.
 */
import * as path from "node:path";
import { type ExtensionAPI, type ExtensionCommandContext, getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { formatModelString } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { buildSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { formatSessionHistoryMarkdown } from "@oh-my-pi/pi-coding-agent/session/session-history-format";
import { CouncilBoard } from "./board";
import {
	assignCouncilIdentities,
	COUNCIL_BUDGET_KEYS,
	type CouncilBudgetKey,
	type CouncilConfig,
	readCouncilConfig,
	resolveCouncilBudgets,
	writeCouncilConfig,
} from "./config";
import { COUNCIL_OUTCOME_LABELS, formatCouncilBudgets } from "./render";
import { runCouncil } from "./service";
import { councilMemberToolkit } from "./tools";

const REPORT_MESSAGE_TYPE = "council-report";
const WIDGET_KEY = "council";
const SPINNER_INTERVAL_MS = 100;
/** Tail of the invoking conversation handed to the council as context. */
const MAX_CONTEXT_CHARS = 24_000;

const START = "▶ Start the council";
const ADD = "+ Add a member…";
const BUDGETS = "⚙ Budgets…";

const BUDGET_LABELS: Record<CouncilBudgetKey, string> = {
	maxRounds: "Max debate rounds",
	maxMinutes: "Time budget (minutes)",
	maxTokens: "Token budget",
	maxCostUsd: "Cost budget (USD)",
};

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default function council(pi: ExtensionAPI): void {
	const memberTools = councilMemberToolkit(pi.arktype);
	let active: AbortController | undefined;

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
				config = await readCouncilConfig();
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
			// Runs in the background so the editor stays usable; run() contains every failure.
			void run(ctx, problem, controller.signal).finally(() => {
				if (active === controller) active = undefined;
			});
		},
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
			const options = [
				...members.map((member, index) => ({ label: memberLabels[index]!, description: member.model })),
				...(ready ? [{ label: START, description: problem || "You will be asked for the problem" }] : []),
				{
					label: ADD,
					description: "Any model you have credentials for; a model can sit twice under different names",
				},
				{ label: BUDGETS, description: formatCouncilBudgets(resolveCouncilBudgets(config)) },
			];
			const choice = await ctx.ui.select(
				ready
					? `Council — ${members.length} members (select one to remove it)`
					: `Council — add at least two members (${members.length} so far)`,
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
				} else {
					const index = memberLabels.indexOf(choice);
					const member = members[index];
					if (member && (await ctx.ui.confirm(`Remove ${names[index]!.name}?`, member.model))) {
						members.splice(index, 1);
						await writeCouncilConfig(config);
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
		await writeCouncilConfig(config);
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
		await writeCouncilConfig(config);
	}

	/** One council run: widget while it deliberates, report into the conversation when it ends. */
	async function run(ctx: ExtensionCommandContext, problem: string, signal: AbortSignal): Promise<void> {
		const board = new CouncilBoard(problem, ctx.ui.theme);
		ctx.ui.setWidget(WIDGET_KEY, board.widget, { placement: "aboveEditor" });
		const timer = ctx.setInterval(() => board.tick(), SPINNER_INTERVAL_MS);
		const sessionId = ctx.sessionManager.getSessionId();
		try {
			const config = await readCouncilConfig();
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
			const summary = `Council: ${COUNCIL_OUTCOME_LABELS[result.outcome]} — ${result.reason}`;
			// The report belongs to the session that convened the council.
			if (ctx.sessionManager.getSessionId() !== sessionId) {
				ctx.ui.notify(`${summary} Report: ${result.reportPath ?? "not saved"}`, "info");
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
				{ triggerTurn: false, deliverAs: "nextTurn" },
			);
			ctx.ui.notify(summary, result.outcome === "consensus" ? "info" : "warning");
		} catch (error) {
			ctx.ui.notify(`Council failed: ${errorText(error)}`, "error");
		} finally {
			ctx.clearTimer(timer);
			ctx.ui.setWidget(WIDGET_KEY, undefined);
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
