import { describe, expect, test } from "bun:test";
import type { ExtensionUiHost, Theme } from "@oh-my-pi/pi-coding-agent";
import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { CouncilBoard } from "../src/board";
import type { CouncilSnapshot } from "../src/types";

function fakeTheme(): Theme {
	return {
		name: "test",
		dark: true,
		depth: "truecolor",
		style: (_tokens, text) => text,
		fg: (_color, text) => text,
		fgResolved: (_color, text) => text,
		bg: (_color, text) => text,
		palette: (_slot, text) => text,
		has: () => true,
		fgSgr: () => "",
		hex: () => "#ffffff",
		symbols: {
			preset: "unicode",
			box: {
				topLeft: "╭",
				topRight: "╮",
				bottomLeft: "╰",
				bottomRight: "╯",
				horizontal: "─",
				vertical: "│",
				teeDown: "┬",
				teeUp: "┴",
				teeLeft: "┤",
				teeRight: "├",
				cross: "┼",
			},
			sharp: {
				topLeft: "┌",
				topRight: "┐",
				bottomLeft: "└",
				bottomRight: "┘",
				horizontal: "─",
				vertical: "│",
				teeDown: "┬",
				teeUp: "┴",
				teeLeft: "┤",
				teeRight: "├",
				cross: "┼",
			},
			symbol: () => "",
			icon: () => "",
			langIcon: () => "",
			spinnerFrames: ["-", "\\", "|", "/"],
			activityFrames: ["⠋", "⠙", "⠹"],
			ellipsis: "…",
		},
	};
}

function makeSnapshot(): CouncilSnapshot {
	return {
		phase: "debate",
		round: 1,
		elapsedMs: 1_500,
		budgets: { maxRounds: 3 },
		usage: { tokens: 150, cost: 0.01 },
		members: [
			{
				agentId: "agent-claude",
				id: "claude",
				name: "Claude",
				model: "anthropic/claude-opus",
				active: true,
				challenges: [],
				activity: { state: "thinking", since: Date.now(), toolCount: 0 },
				usage: { tokens: 150, cost: 0.01 },
			},
		],
		proposals: [],
		openChallenges: 0,
	};
}

describe("CouncilBoard widget", () => {
	test("renders wrapped, width-safe rows with activity spinner frames and requests redraws", () => {
		const board = new CouncilBoard("Design a deterministic consensus protocol for agents", fakeTheme());
		let renders = 0;
		const ui: ExtensionUiHost = {
			requestRender: () => {
				renders += 1;
			},
			size: () => ({ columns: 40, rows: 20 }),
			suspend: async run => run(),
		};

		const widget = board.widget(ui);
		board.log("first\tline\twith\ttabs and a long explanation that must wrap cleanly");
		board.onEvent({ type: "phase", phase: "debate", seq: 1, round: 1, at: Date.now() }, makeSnapshot());
		expect(renders).toBe(2);

		const rowsBeforeTick = widget.render(32);
		expect(rowsBeforeTick.length).toBeGreaterThan(4);
		for (const row of rowsBeforeTick) {
			expect(row.startsWith(" ")).toBe(true);
			expect(row.includes("\t")).toBe(false);
			expect(visibleWidth(row)).toBeLessThanOrEqual(32);
		}
		expect(rowsBeforeTick.some(row => row.includes("⠋"))).toBe(true);

		board.tick();
		expect(renders).toBe(3);
		const rowsAfterTick = widget.render(32);
		expect(rowsAfterTick.some(row => row.includes("⠙"))).toBe(true);
	});
});
