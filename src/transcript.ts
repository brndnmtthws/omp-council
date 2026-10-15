/**
 * Ordered council transcript.
 *
 * Assigns sequence numbers and timestamps, fans events out to listeners, and —
 * when an output directory is given — appends every event to
 * `transcript.jsonl` (machine-readable, one event per line) and
 * `transcript.md` (human-readable). Writes are serialized; a failing disk
 * never interrupts deliberation.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { CouncilEvent, CouncilEventBody } from "./types";

export interface CouncilTranscriptOptions {
	/** Directory for transcript.jsonl and transcript.md; omit to stay in memory. */
	outputDir?: string;
	/** Markdown written at the top of transcript.md. */
	header?: string;
	/** Markdown rendering of one event for transcript.md; return "" to skip. */
	formatMarkdown?: (event: CouncilEvent) => string;
	now?: () => number;
}

export class CouncilTranscript {
	readonly #events: CouncilEvent[] = [];
	readonly #listeners = new Set<(event: CouncilEvent) => void>();
	readonly #now: () => number;
	readonly #formatMarkdown: ((event: CouncilEvent) => string) | undefined;
	readonly #jsonlPath: string | undefined;
	readonly #markdownPath: string | undefined;
	#writes: Promise<void> = Promise.resolve();
	#writeFailed = false;
	#round = 0;

	constructor(options: CouncilTranscriptOptions = {}) {
		this.#now = options.now ?? Date.now;
		this.#formatMarkdown = options.formatMarkdown;
		if (options.outputDir) {
			this.#jsonlPath = path.join(options.outputDir, "transcript.jsonl");
			this.#markdownPath = path.join(options.outputDir, "transcript.md");
			const outputDir = options.outputDir;
			const header = options.header ? `${options.header.trimEnd()}\n\n` : "";
			this.#enqueue(async () => {
				await fs.mkdir(outputDir, { recursive: true });
				await Bun.write(this.#markdownPath as string, header);
				await Bun.write(this.#jsonlPath as string, "");
			});
		}
	}

	get jsonlPath(): string | undefined {
		return this.#jsonlPath;
	}

	get markdownPath(): string | undefined {
		return this.#markdownPath;
	}

	/** Round stamped on subsequently appended events. */
	get round(): number {
		return this.#round;
	}

	set round(round: number) {
		this.#round = round;
	}

	get events(): readonly CouncilEvent[] {
		return this.#events;
	}

	/** Sequence number of the newest event (0 when empty). */
	get lastSeq(): number {
		return this.#events.length;
	}

	/** Events with a sequence number greater than `seq`, oldest first. */
	since(seq: number): CouncilEvent[] {
		return this.#events.slice(Math.max(0, seq));
	}

	append(body: CouncilEventBody): CouncilEvent {
		const event = { ...body, seq: this.#events.length + 1, round: this.#round, at: this.#now() } as CouncilEvent;
		this.#events.push(event);
		if (this.#jsonlPath) {
			const jsonlPath = this.#jsonlPath;
			const markdownPath = this.#markdownPath as string;
			const markdown = this.#formatMarkdown?.(event) ?? "";
			this.#enqueue(async () => {
				await fs.appendFile(jsonlPath, `${JSON.stringify(event)}\n`);
				if (markdown) await fs.appendFile(markdownPath, `${markdown.trimEnd()}\n\n`);
			});
		}
		for (const listener of this.#listeners) {
			try {
				listener(event);
			} catch (error) {
				logger.warn("Council transcript listener failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return event;
	}

	/** Write an auxiliary file next to the transcript (e.g. report.md); resolves to its path once written. */
	async writeFile(name: string, content: string): Promise<string | undefined> {
		if (!this.#markdownPath) return undefined;
		const filePath = path.join(path.dirname(this.#markdownPath), name);
		let written = false;
		this.#enqueue(async () => {
			await Bun.write(filePath, content);
			written = true;
		});
		await this.flush();
		return written ? filePath : undefined;
	}

	subscribe(listener: (event: CouncilEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Resolve once every queued write has settled. */
	flush(): Promise<void> {
		return this.#writes;
	}

	#enqueue(write: () => Promise<void>): void {
		this.#writes = this.#writes.then(write).catch(error => {
			if (this.#writeFailed) return;
			this.#writeFailed = true;
			logger.warn("Council transcript write failed", {
				path: this.#markdownPath,
				error: error instanceof Error ? error.message : String(error),
			});
		});
	}
}
