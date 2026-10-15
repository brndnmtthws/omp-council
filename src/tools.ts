/**
 * Council member tools: thin `CustomTool` wrappers over a member's
 * {@link CouncilActionApi}. The ledger validates every call; a rejected action
 * surfaces to the model as a tool error carrying the ledger's explanation.
 *
 * Schemas use the host's `pi.arktype` builder so the host tool registry
 * validates them with its own runtime.
 */
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { CustomTool, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { prompt } from "@oh-my-pi/pi-utils";
import acceptDescription from "./prompts/tools/accept.md" with { type: "text" };
import challengeDescription from "./prompts/tools/challenge.md" with { type: "text" };
import proposeDescription from "./prompts/tools/propose.md" with { type: "text" };
import resolveDescription from "./prompts/tools/resolve.md" with { type: "text" };
import respondDescription from "./prompts/tools/respond.md" with { type: "text" };
import reviseDescription from "./prompts/tools/revise.md" with { type: "text" };
import verifyDescription from "./prompts/tools/verify.md" with { type: "text" };
import viewDescription from "./prompts/tools/view.md" with { type: "text" };
import withdrawDescription from "./prompts/tools/withdraw.md" with { type: "text" };
import type { CouncilActionApi, CouncilActionResult } from "./types";

export const COUNCIL_MEMBER_TOOL_NAMES: readonly string[] = [
	"council_propose",
	"council_revise",
	"council_challenge",
	"council_respond",
	"council_resolve",
	"council_withdraw",
	"council_accept",
	"council_verify",
	"council_view",
];

function textResult(text: string, isError = false): AgentToolResult {
	return isError ? { content: [{ type: "text", text }], isError: true } : { content: [{ type: "text", text }] };
}

function actionResult(result: CouncilActionResult): AgentToolResult {
	if (!result.ok) return textResult(result.error, true);
	if (!result.ref || result.message.includes(result.ref)) return textResult(result.message);
	return textResult(`${result.message} (${result.ref})`);
}

/** Builds the ledger action tools for one council member; schemas are built once and shared. */
export function councilMemberToolkit(type: ExtensionAPI["arktype"]): (actions: CouncilActionApi) => CustomTool[] {
	const proposalRef = type("string").describe("proposal id, e.g. P2");
	const challengeRef = type("string").describe("challenge id, e.g. C3");
	const proposeSchema = type({
		title: type("string").describe("short solution name"),
		summary: type("string").describe("solution in a few sentences"),
		solution: type("string").describe("full design"),
		evidence: type("string").describe("supporting findings"),
		tradeoffs: type("string").describe("costs, risks, rejected alternatives"),
		implementation: type("string").describe("concrete steps"),
	});
	const reviseSchema = type({
		proposal: proposalRef,
		base_version: type("number.integer").describe("current version you revise from"),
		change_summary: type("string").describe("what changed and why"),
		"addresses?": type("string").describe("challenge id").array(),
		"title?": type("string").describe("new title"),
		"summary?": type("string").describe("new summary"),
		"solution?": type("string").describe("new solution"),
		"evidence?": type("string").describe("new evidence"),
		"tradeoffs?": type("string").describe("new tradeoffs"),
		"implementation?": type("string").describe("new implementation"),
	});
	const challengeSchema = type({
		proposal: proposalRef,
		objection: type("string").describe("specific flaw and why it matters"),
		"evidence?": type("string").describe("supporting evidence"),
	});
	const respondSchema = type({
		challenge: challengeRef,
		response: type("string").describe("answer with evidence"),
	});
	const resolveSchema = type({
		challenge: challengeRef,
		note: type("string").describe("why the objection no longer stands"),
	});
	const withdrawSchema = type({
		proposal: proposalRef,
		reason: type("string").describe("why it is withdrawn"),
	});
	const acceptSchema = type({
		proposal: proposalRef,
		version: type("number.integer").describe("current version"),
		rationale: type("string").describe("why you endorse it (>= 30 chars)"),
	});
	const assessmentSchema = type({
		challenge: challengeRef,
		assessment: type("'addressed' | 'unaddressed'").describe("whether the challenge is addressed"),
		note: type("string").describe("reason"),
	});
	const verifySchema = type({
		proposal: proposalRef,
		version: type("number.integer").describe("candidate version"),
		verdict: type("'confirm' | 'reject'").describe("verdict"),
		rationale: type("string").describe("independent re-check (>= 30 chars)"),
		"assessments?": assessmentSchema.array(),
		"risks?": type("string").describe("residual risks"),
	});
	const viewSchema = type({
		"ref?": type("string").describe("state, P2, P2@1, or C3"),
	});

	return actions => {
		const propose: CustomTool<typeof proposeSchema> = {
			name: "council_propose",
			label: "Council propose",
			description: prompt.render(proposeDescription),
			parameters: proposeSchema,
			approval: "read",
			loadMode: "essential",
			async execute(_toolCallId, params) {
				return actionResult(
					actions.propose({
						title: params.title,
						summary: params.summary,
						solution: params.solution,
						evidence: params.evidence,
						tradeoffs: params.tradeoffs,
						implementation: params.implementation,
					}),
				);
			},
		};
		const revise: CustomTool<typeof reviseSchema> = {
			name: "council_revise",
			label: "Council revise",
			description: prompt.render(reviseDescription),
			parameters: reviseSchema,
			approval: "read",
			loadMode: "essential",
			async execute(_toolCallId, params) {
				return actionResult(
					actions.revise({
						proposalId: params.proposal,
						baseVersion: params.base_version,
						changeSummary: params.change_summary,
						addresses: params.addresses,
						title: params.title,
						summary: params.summary,
						solution: params.solution,
						evidence: params.evidence,
						tradeoffs: params.tradeoffs,
						implementation: params.implementation,
					}),
				);
			},
		};
		const challenge: CustomTool<typeof challengeSchema> = {
			name: "council_challenge",
			label: "Council challenge",
			description: prompt.render(challengeDescription),
			parameters: challengeSchema,
			approval: "read",
			loadMode: "essential",
			async execute(_toolCallId, params) {
				return actionResult(
					actions.challenge({
						proposalId: params.proposal,
						objection: params.objection,
						evidence: params.evidence,
					}),
				);
			},
		};
		const respond: CustomTool<typeof respondSchema> = {
			name: "council_respond",
			label: "Council respond",
			description: prompt.render(respondDescription),
			parameters: respondSchema,
			approval: "read",
			loadMode: "essential",
			async execute(_toolCallId, params) {
				return actionResult(actions.respond({ challengeId: params.challenge, response: params.response }));
			},
		};
		const resolve: CustomTool<typeof resolveSchema> = {
			name: "council_resolve",
			label: "Council resolve",
			description: prompt.render(resolveDescription),
			parameters: resolveSchema,
			approval: "read",
			loadMode: "essential",
			async execute(_toolCallId, params) {
				return actionResult(actions.resolve({ challengeId: params.challenge, note: params.note }));
			},
		};
		const withdraw: CustomTool<typeof withdrawSchema> = {
			name: "council_withdraw",
			label: "Council withdraw",
			description: prompt.render(withdrawDescription),
			parameters: withdrawSchema,
			approval: "read",
			loadMode: "essential",
			async execute(_toolCallId, params) {
				return actionResult(actions.withdraw({ proposalId: params.proposal, reason: params.reason }));
			},
		};
		const accept: CustomTool<typeof acceptSchema> = {
			name: "council_accept",
			label: "Council accept",
			description: prompt.render(acceptDescription),
			parameters: acceptSchema,
			approval: "read",
			loadMode: "essential",
			async execute(_toolCallId, params) {
				return actionResult(
					actions.accept({ proposalId: params.proposal, version: params.version, rationale: params.rationale }),
				);
			},
		};
		const verify: CustomTool<typeof verifySchema> = {
			name: "council_verify",
			label: "Council verify",
			description: prompt.render(verifyDescription),
			parameters: verifySchema,
			approval: "read",
			loadMode: "essential",
			async execute(_toolCallId, params) {
				return actionResult(
					actions.verify({
						proposalId: params.proposal,
						version: params.version,
						verdict: params.verdict,
						rationale: params.rationale,
						assessments: params.assessments?.map(entry => ({
							challengeId: entry.challenge,
							assessment: entry.assessment,
							note: entry.note,
						})),
						risks: params.risks,
					}),
				);
			},
		};
		const view: CustomTool<typeof viewSchema> = {
			name: "council_view",
			label: "Council view",
			description: prompt.render(viewDescription),
			parameters: viewSchema,
			approval: "read",
			loadMode: "essential",
			async execute(_toolCallId, params) {
				return textResult(actions.view(params.ref?.trim() || undefined));
			},
		};
		return [propose, revise, challenge, respond, resolve, withdraw, accept, verify, view];
	};
}
