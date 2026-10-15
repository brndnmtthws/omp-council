import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	assignCouncilIdentities,
	normalizeCouncilConfig,
	readCouncilConfig,
	resolveCouncilBudgets,
	resolveCouncilMembers,
	writeCouncilConfig,
} from "../src/config";

let root: string;

beforeAll(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-council-config-"));
});

afterAll(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

describe("council config", () => {
	test("accepts bare selectors and named members, trimming fields and dropping zero budgets", () => {
		expect(
			normalizeCouncilConfig(
				{
					members: [
						" anthropic/claude-opus-4-6 ",
						{ name: " Skeptic ", model: "openai/gpt-5", persona: " Hunt. " },
					],
					maxRounds: 0,
					maxMinutes: 30,
				},
				"council.json",
			),
		).toEqual({
			members: [
				{ model: "anthropic/claude-opus-4-6" },
				{ name: "Skeptic", model: "openai/gpt-5", persona: "Hunt." },
			],
			maxMinutes: 30,
		});
	});

	test("rejects malformed entries with an error naming the entry", () => {
		expect(() => normalizeCouncilConfig({ members: [42] }, "council.json")).toThrow("council.json: members[0]");
		expect(() => normalizeCouncilConfig({ members: [{ name: "Ghost" }] }, "council.json")).toThrow(
			'members[0] needs a non-empty "model"',
		);
		expect(() => normalizeCouncilConfig({ members: [], maxCostUsd: -1 }, "council.json")).toThrow('"maxCostUsd"');
		expect(() => normalizeCouncilConfig([], "council.json")).toThrow("must be a JSON object");
	});

	test("a missing file is an empty roster; a saved config reads back", async () => {
		const file = path.join(root, "council.json");
		expect(await readCouncilConfig(file)).toEqual({ members: [] });
		await writeCouncilConfig({ members: [{ name: "GPT", model: "openai/gpt-5" }], maxTokens: 1_000_000 }, file);
		expect(await readCouncilConfig(file)).toEqual({
			members: [{ name: "GPT", model: "openai/gpt-5" }],
			maxTokens: 1_000_000,
		});
		await Bun.write(file, "{ not json");
		await expect(readCouncilConfig(file)).rejects.toThrow(file);
	});

	test("budgets convert minutes to milliseconds", () => {
		expect(resolveCouncilBudgets({ members: [], maxRounds: 5, maxMinutes: 30, maxCostUsd: 2 })).toEqual({
			maxRounds: 5,
			maxDurationMs: 1_800_000,
			maxCostUsd: 2,
		});
		expect(resolveCouncilBudgets({ members: [] })).toEqual({});
	});
});

describe("council identities", () => {
	test("derives names from the model, and keeps display names and slug ids unique", () => {
		expect(
			assignCouncilIdentities([
				{ modelId: "anthropic/claude-opus-4-6:high" },
				{ modelId: "gpt-5" },
				{ modelId: "gpt-5" },
				{ name: "Claude Opus", modelId: "claude-opus-4-6" },
				{ name: "claude opus", modelId: "claude-opus-4-6" },
				{ name: "!!!", modelId: "x" },
			]),
		).toEqual([
			{ name: "claude-opus-4-6", id: "claude-opus-4-6" },
			{ name: "gpt-5", id: "gpt-5" },
			{ name: "gpt-5-2", id: "gpt-5-2" },
			{ name: "Claude Opus", id: "claude-opus" },
			{ name: "claude opus-2", id: "claude-opus-2" },
			{ name: "!!!", id: "member" },
		]);
	});
});

describe("council member resolution", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const settings = Settings.isolated();

	beforeAll(async () => {
		authStorage = await AuthStorage.create(path.join(root, "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
	});

	test("rejects a council with fewer than two members", () => {
		expect(() => resolveCouncilMembers([{ model: "anthropic/claude-sonnet-4-5" }], modelRegistry, settings)).toThrow(
			"at least two members",
		);
	});

	test("resolves selectors, carries thinking, and dedupes names derived from the resolved model", () => {
		const members = resolveCouncilMembers(
			[{ model: "anthropic/claude-sonnet-4-5:high" }, { model: "anthropic/claude-sonnet-4-5", persona: "Skeptic" }],
			modelRegistry,
			settings,
		);
		expect(members.map(member => [member.id, member.name, member.model, member.thinking, member.persona])).toEqual([
			["claude-sonnet-4-5", "claude-sonnet-4-5", "anthropic/claude-sonnet-4-5", "high", undefined],
			["claude-sonnet-4-5-2", "claude-sonnet-4-5-2", "anthropic/claude-sonnet-4-5", undefined, "Skeptic"],
		]);
		expect(members[0]?.modelRef.id).toBe("claude-sonnet-4-5");
	});

	test("names the member and selector when a model does not resolve or has no credentials", () => {
		expect(() =>
			resolveCouncilMembers(
				[{ model: "anthropic/claude-sonnet-4-5" }, { name: "Ghost", model: "anthropic/no-such-model-xyz" }],
				modelRegistry,
				settings,
			),
		).toThrow('Council member "Ghost" (anthropic/no-such-model-xyz)');
		expect(() =>
			resolveCouncilMembers(
				[{ model: "anthropic/claude-sonnet-4-5" }, { name: "GPT", model: "openai/gpt-5" }],
				modelRegistry,
				settings,
			),
		).toThrow("no credentials for provider openai");
	});
});
