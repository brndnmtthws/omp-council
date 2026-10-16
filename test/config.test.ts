import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	applyCouncilPreset,
	assignCouncilIdentities,
	type CouncilConfig,
	deleteCouncilPreset,
	findActiveCouncilPreset,
	getCouncilPreset,
	normalizeCouncilConfig,
	readCouncilConfig,
	resolveCouncilBudgets,
	resolveCouncilMembers,
	saveCouncilPreset,
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

describe("council presets", () => {
	test("a preset is a snapshot: editing the council after saving or switching never rewrites it", () => {
		const config: CouncilConfig = {
			members: [{ model: "a/x" }, { name: "Skeptic", model: "b/y", persona: "Doubt." }],
			maxRounds: 3,
		};
		saveCouncilPreset(config, "duo");
		expect(findActiveCouncilPreset(config)).toBe("duo");

		config.members.push({ model: "c/z" });
		config.members[1]!.persona = "Agree.";
		config.maxRounds = 5;
		const snapshot = {
			members: [{ model: "a/x" }, { name: "Skeptic", model: "b/y", persona: "Doubt." }],
			maxRounds: 3,
		};
		expect(getCouncilPreset(config, "duo")).toEqual(snapshot);
		expect(findActiveCouncilPreset(config)).toBeUndefined();

		expect(applyCouncilPreset(config, "duo")).toBe(true);
		expect(findActiveCouncilPreset(config)).toBe("duo");
		config.members[0]!.name = "Renamed";
		expect(getCouncilPreset(config, "duo")).toEqual(snapshot);
	});

	test("switching replaces members and budgets wholesale, so budgets the preset leaves unset become unlimited", () => {
		const config = normalizeCouncilConfig(
			{
				members: ["a/x", "b/y"],
				maxRounds: 3,
				maxCostUsd: 5,
				presets: { cheap: { members: ["c/z", "d/w"], maxMinutes: 10 } },
			},
			"council.json",
		);
		expect(applyCouncilPreset(config, "cheap")).toBe(true);
		expect(config.members).toEqual([{ model: "c/z" }, { model: "d/w" }]);
		expect(resolveCouncilBudgets(config)).toEqual({ maxDurationMs: 600_000 });
	});

	test("only saved names are presets: missing and Object.prototype names change nothing", () => {
		const config: CouncilConfig = { members: [{ model: "a/x" }, { model: "b/y" }] };
		saveCouncilPreset(config, "duo");
		const before = structuredClone(config);
		for (const name of ["missing", "constructor"]) {
			expect(getCouncilPreset(config, name)).toBeUndefined();
			expect(applyCouncilPreset(config, name)).toBe(false);
			expect(deleteCouncilPreset(config, name)).toBe(false);
		}
		expect(config).toEqual(before);
	});

	test("saving refuses an invalid name or a roster too small to convene, keeping the saved preset", () => {
		const config: CouncilConfig = { members: [{ model: "a/x" }, { model: "b/y" }] };
		saveCouncilPreset(config, "duo");
		expect(() => saveCouncilPreset(config, "2fast")).toThrow('Invalid preset name "2fast"');
		config.members.pop();
		expect(() => saveCouncilPreset(config, "duo")).toThrow("at least two members");
		expect(getCouncilPreset(config, "duo")?.members).toEqual([{ model: "a/x" }, { model: "b/y" }]);
	});

	test("presets survive a write and read and still match the council; malformed ones name the preset", async () => {
		const file = path.join(root, "presets.json");
		const config: CouncilConfig = {
			members: [{ name: "GPT", model: "openai/gpt-5" }, { model: "a/x" }],
			maxTokens: 1000,
		};
		saveCouncilPreset(config, "duo");
		await writeCouncilConfig(config, file);
		const read = await readCouncilConfig(file);
		expect(read).toEqual(config);
		expect(findActiveCouncilPreset(read)).toBe("duo");

		expect(() => normalizeCouncilConfig({ presets: [] }, "council.json")).toThrow('"presets" must be an object');
		expect(() => normalizeCouncilConfig({ presets: { "my preset": {} } }, "council.json")).toThrow(
			'preset name "my preset"',
		);
		expect(() =>
			normalizeCouncilConfig({ presets: { duo: { members: [{ name: "Ghost" }] } } }, "council.json"),
		).toThrow('council.json: presets.duo.members[0] needs a non-empty "model"');
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
