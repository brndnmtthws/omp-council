/**
 * Runs one council: resolves the members, allocates agent ids, builds the
 * AgentSession-backed runtime factory, and drives the deliberation engine.
 * The transcript and report land under `local://council/<runId>/`.
 */
import * as path from "node:path";
import { type LocalProtocolOptions, resolveLocalRoot } from "@oh-my-pi/pi-coding-agent/internal-urls/local-protocol";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentOutputManager } from "@oh-my-pi/pi-coding-agent/task/output-manager";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { resolveCouncilMembers } from "./config";
import { runCouncilEngine } from "./engine";
import { formatCouncilBudgets } from "./render";
import { createSessionRuntimeFactory } from "./session-runtime";
import type { CouncilEnvironment, CouncilRequest, CouncilResult, CouncilRunUi, ResolvedCouncilMember } from "./types";

/**
 * Run one council. Throws an Error with a user-facing message for
 * configuration problems (fewer than two members, unknown model, missing
 * credentials); everything after setup is reported through the result.
 */
export async function runCouncil(
	request: CouncilRequest,
	env: CouncilEnvironment,
	ui: CouncilRunUi,
	signal: AbortSignal,
): Promise<CouncilResult> {
	const { settings, modelRegistry } = env;
	const problem = request.problem.trim();
	if (!problem) throw new Error("Describe the problem the council should solve.");

	const plans = resolveCouncilMembers(request.participants, modelRegistry, settings);
	const runId = String(Snowflake.next());
	const localProtocolOptions: LocalProtocolOptions = env.localProtocolOptions ?? {
		getArtifactsDir: () => env.artifactsDir,
	};
	const outputDir = path.join(resolveLocalRoot(localProtocolOptions), "council", runId);

	// `Council<Name>` ids, unique across the artifacts dir and the live registry.
	const outputs = new AgentOutputManager(() => env.artifactsDir);
	await outputs.reserve(
		AgentRegistry.global()
			.list()
			.map(ref => ref.id),
	);
	const members: ResolvedCouncilMember[] = [];
	for (const plan of plans) {
		const pascal = plan.name
			.split(/[^A-Za-z0-9]+/)
			.filter(Boolean)
			.map(part => part[0]!.toUpperCase() + part.slice(1))
			.join("");
		members.push({ ...plan, agentId: await outputs.allocate(`Council${pascal || "Member"}`) });
	}

	ui.log(
		`Council of ${members.length}: ${members.map(member => `${member.name} (${member.model}${member.thinking ? `:${member.thinking}` : ""})`).join(", ")}`,
	);
	ui.log(`Budget: ${formatCouncilBudgets(request.budgets)} · transcript: local://council/${runId}/transcript.md`);

	const factory = createSessionRuntimeFactory({
		cwd: env.cwd,
		settings,
		modelRegistry,
		members,
		memberTools: env.memberTools,
		sessionDir: env.artifactsDir,
		localProtocolOptions,
		parentAgentId: env.parentAgentId,
	});
	return runCouncilEngine({
		problem,
		context: request.context,
		members: members.map(({ modelRef: _modelRef, ...info }) => info),
		budgets: request.budgets,
		factory,
		outputDir,
		signal,
		onEvent: (event, snapshot) => ui.onEvent(event, snapshot),
		onUpdate: snapshot => ui.onUpdate(snapshot),
	});
}
