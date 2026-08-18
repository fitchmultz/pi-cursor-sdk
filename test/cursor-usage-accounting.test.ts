import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { InteractionUpdateSchema, TurnEndedUpdateSchema } from "@cursor/sdk";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { calculateContextTokens } from "@earendil-works/pi-coding-agent";
import {
	applyCursorApproximateUsage,
	applyCursorUsage,
	estimateCursorAssistantSessionOutputTokens,
	estimateCursorContextTotalTokens,
	isCursorSdkUsageSafeForPiMessage,
	readCursorSdkTurnUsage,
	readCursorSdkTurnUsageFromUpdate,
} from "../src/cursor-usage-accounting.js";
import { makeModel } from "./helpers/pi-harness.js";

function makeAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "cursor-sdk",
		provider: "cursor",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	};
}

describe("cursor usage accounting", () => {
	it("counts assistant session output from text, thinking, and tool calls", () => {
		const textOnly = makeAssistantMessage([{ type: "text", text: "Done." }]);
		const withThinking = makeAssistantMessage([
			{ type: "thinking", thinking: "Inspecting the repository." },
			{ type: "text", text: "Done." },
		]);
		const withToolCall = makeAssistantMessage([
			{ type: "text", text: "I will inspect it." },
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
		]);

		expect(estimateCursorAssistantSessionOutputTokens(textOnly)).toBeGreaterThan(0);
		expect(estimateCursorAssistantSessionOutputTokens(withThinking)).toBeGreaterThan(estimateCursorAssistantSessionOutputTokens(textOnly));
		expect(estimateCursorAssistantSessionOutputTokens(withToolCall)).toBeGreaterThan(estimateCursorAssistantSessionOutputTokens(textOnly));
	});

	it("applies real SDK usage when a turn reports usage within the model window", () => {
		const model = makeModel();
		const context: Context = {
			systemPrompt: "Be helpful.",
			messages: [{ role: "user", content: "Hello", timestamp: 1 }],
		};
		const partial = makeAssistantMessage([{ type: "text", text: "Hello back." }]);

		applyCursorUsage(partial, model, context, 7, {
			runtime: "local",
			turn: { inputTokens: 25_432, outputTokens: 612, cacheReadTokens: 24_000, cacheWriteTokens: 123 },
		});

		expect(partial.usage.input).toBe(25_432 - 24_000 - 123);
		expect(partial.usage.output).toBe(612);
		expect(partial.usage.cacheRead).toBe(24_000);
		expect(partial.usage.cacheWrite).toBe(123);
		expect(partial.usage.totalTokens).toBe(25_432 + 612);
		expect(partial.usage.input + partial.usage.cacheRead + partial.usage.cacheWrite + partial.usage.output).toBe(
			partial.usage.totalTokens,
		);
	});

	it("maps SDK cache fields to disjoint pi components and occupancy totalTokens", () => {
		const model = makeModel();
		const context: Context = {
			systemPrompt: "Be helpful.",
			messages: [{ role: "user", content: "Hello", timestamp: 1 }],
		};
		const partial = makeAssistantMessage([{ type: "text", text: "A" }]);
		// Observed raw local turn-ended.usage (issue #196): inputTokens is full prompt; cache fields partition it.
		// Distinct from published SDK toTokenUsage additive totalTokens (see turn-ended usage contract fixture).
		const turn = {
			inputTokens: 46_965,
			outputTokens: 3,
			cacheReadTokens: 42_036,
			cacheWriteTokens: 4_927,
		};

		expect(isCursorSdkUsageSafeForPiMessage(turn, model)).toBe(true);
		applyCursorUsage(partial, model, context, 7, { runtime: "local", turn });
		expect(partial.usage).toMatchObject({
			input: 46_965 - 42_036 - 4_927,
			output: 3,
			cacheRead: 42_036,
			cacheWrite: 4_927,
			totalTokens: 46_968,
		});
		expect(partial.usage.input + partial.usage.cacheRead + partial.usage.cacheWrite + partial.usage.output).toBe(
			partial.usage.totalTokens,
		);
	});

	it("rejects SDK usage whose cache partition exceeds inputTokens", () => {
		const model = makeModel();
		expect(
			isCursorSdkUsageSafeForPiMessage(
				{ inputTokens: 100, outputTokens: 1, cacheReadTokens: 80, cacheWriteTokens: 30 },
				model,
			),
		).toBe(false);
	});

	it("rejects SDK usage whose input+output would exceed the selected model window", () => {
		const model = makeModel();
		const context: Context = {
			systemPrompt: "Be helpful.",
			messages: [{ role: "user", content: "Hello", timestamp: 1 }],
		};
		const partial = makeAssistantMessage([{ type: "text", text: "Hello back." }]);
		const overWindowUsage = {
			inputTokens: model.contextWindow - 10,
			outputTokens: 11,
			cacheReadTokens: 9,
			cacheWriteTokens: 1,
		};

		expect(isCursorSdkUsageSafeForPiMessage(overWindowUsage, model)).toBe(false);
		expect(isCursorSdkUsageSafeForPiMessage({ ...overWindowUsage, inputTokens: -1 }, model)).toBe(false);
		expect(isCursorSdkUsageSafeForPiMessage({ ...overWindowUsage, inputTokens: Number.NaN }, model)).toBe(false);

		applyCursorUsage(partial, model, context, 7, { runtime: "local", turn: overWindowUsage });

		expect(partial.usage.input).toBe(7);
		expect(partial.usage.totalTokens).toBeLessThan(model.contextWindow);
	});

	it("rejects full-run-sized SDK usage before it can poison compaction totals", () => {
		const fixturePath = new URL("./fixtures/cursor-run-usage-compaction-poison.jsonl", import.meta.url);
		const poisonedMessage = readFileSync(fixturePath, "utf8")
			.trim()
			.split(/\r?\n/)
			.map((line) => JSON.parse(line) as { message?: { usage?: { input: number; output: number; cacheRead: number; cacheWrite: number } } })
			.find((entry) => entry.message?.usage)?.message?.usage;
		expect(poisonedMessage).toMatchObject({ input: 1_125_429, cacheRead: 1_015_493 });

		const model = makeModel();
		const context: Context = {
			systemPrompt: "Be helpful.",
			messages: [{ role: "user", content: "Hello", timestamp: 1 }],
		};
		const partial = makeAssistantMessage([{ type: "text", text: "Hello back." }]);
		const poisonedSdkUsage = {
			inputTokens: poisonedMessage!.input,
			outputTokens: poisonedMessage!.output,
			cacheReadTokens: poisonedMessage!.cacheRead,
			cacheWriteTokens: poisonedMessage!.cacheWrite,
		};

		expect(isCursorSdkUsageSafeForPiMessage(poisonedSdkUsage, model)).toBe(false);

		applyCursorUsage(partial, model, context, 7, { runtime: "local", turn: poisonedSdkUsage });

		expect(partial.usage.cacheRead).toBe(0);
		expect(partial.usage.cacheWrite).toBe(0);
		expect(partial.usage.input).toBe(7);
		expect(partial.usage.totalTokens).toBeLessThan(model.contextWindow);
	});

	it("reads the installed Cursor SDK turn-ended usage update contract", () => {
		const update = {
			type: "turn-ended",
			usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, reasoningTokens: 5 },
		};

		expect(TurnEndedUpdateSchema.safeParse(update).success).toBe(true);
		expect(InteractionUpdateSchema.safeParse(update).success).toBe(true);
		expect(readCursorSdkTurnUsageFromUpdate(update)).toEqual({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 });
		// Published SDK toTokenUsage/sumTokenUsage formula only — not the observed raw local turn-ended mapping.
		const sdkBundle = readFileSync(createRequire(import.meta.url).resolve("@cursor/sdk"), "utf8");
		expect(sdkBundle).toMatch(/totalTokens:\w\+\w\+\w\+\w/);
		expect(calculateContextTokens({
			input: 1,
			output: 2,
			cacheRead: 3,
			cacheWrite: 4,
			totalTokens: 10,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		})).toBe(10);
		expect(readCursorSdkTurnUsage({ inputTokens: -1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 })).toBeUndefined();
		expect(readCursorSdkTurnUsage({ inputTokens: 1, outputTokens: Number.POSITIVE_INFINITY, cacheReadTokens: 3, cacheWriteTokens: 4 })).toBeUndefined();
		expect(InteractionUpdateSchema.safeParse({
			type: "usage",
			usage: { inputTokens: 5, outputTokens: 6, cacheReadTokens: 7, cacheWriteTokens: 8, totalTokens: 11 },
		}).success).toBe(false);
	});

	it("ignores returned RunResult usage for pi context totals when turn usage is absent", () => {
		const model = makeModel();
		const context: Context = {
			systemPrompt: "Be helpful.",
			messages: [{ role: "user", content: "Hello", timestamp: 1 }],
		};
		const partial = makeAssistantMessage([{ type: "text", text: "Hello back." }]);

		applyCursorUsage(partial, model, context, 7);

		expect(partial.usage.input).toBe(7);
		expect(partial.usage.cacheRead).toBe(0);
		expect(partial.usage.cacheWrite).toBe(0);
		expect(partial.usage.totalTokens).toBe(estimateCursorContextTotalTokens(partial, model, context));
		expect(partial.usage.totalTokens).toBeLessThan(1_125_429);
	});

	it("uses turn-ended usage when present", () => {
		const model = makeModel();
		const context: Context = {
			systemPrompt: "Be helpful.",
			messages: [{ role: "user", content: "Hello", timestamp: 1 }],
		};
		const partial = makeAssistantMessage([{ type: "text", text: "Hello back." }]);

		applyCursorUsage(partial, model, context, 7, {
			runtime: "local",
			turn: { inputTokens: 25, outputTokens: 6, cacheReadTokens: 24, cacheWriteTokens: 1 },
		});

		expect(partial.usage).toMatchObject({ input: 0, output: 6, cacheRead: 24, cacheWrite: 1, totalTokens: 31 });
		expect(partial.usage.input + partial.usage.cacheRead + partial.usage.cacheWrite + partial.usage.output).toBe(31);
	});

	it("keeps the prompt/output estimate fallback when SDK usage is absent", () => {
		const model = makeModel();
		const context: Context = {
			systemPrompt: "Be helpful.",
			messages: [{ role: "user", content: "Hello", timestamp: 1 }],
		};
		const partial = makeAssistantMessage([
			{ type: "thinking", thinking: "Need a concise answer." },
			{ type: "text", text: "Hello back." },
		]);
		const sessionInputTokens = 7;

		applyCursorApproximateUsage(partial, model, context, sessionInputTokens);

		expect(partial.usage.output).toBe(estimateCursorAssistantSessionOutputTokens(partial));
		expect(partial.usage.cacheRead).toBe(0);
		expect(partial.usage.cacheWrite).toBe(0);
		expect(partial.usage.input).toBe(sessionInputTokens);
		expect(partial.usage.totalTokens).toBe(estimateCursorContextTotalTokens(partial, model, context));
		expect(partial.usage.totalTokens).toBeGreaterThan(partial.usage.input + partial.usage.output);
	});

	it("floors approximate totalTokens at the last accepted assistant occupancy", () => {
		const model = makeModel();
		const prior = makeAssistantMessage([{ type: "text", text: "Prior." }]);
		prior.usage = {
			input: 10_000,
			output: 50,
			cacheRead: 40_000,
			cacheWrite: 100,
			totalTokens: 50_150,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const context: Context = {
			systemPrompt: "Be helpful.",
			messages: [
				{ role: "user", content: "Hello", timestamp: 1 },
				prior,
				{ role: "user", content: "Again", timestamp: 3 },
			],
		};
		const partial = makeAssistantMessage([{ type: "text", text: "Hi." }]);
		applyCursorUsage(partial, model, context, 7);
		expect(partial.usage.cacheRead).toBe(0);
		expect(partial.usage.totalTokens).toBeGreaterThanOrEqual(50_150);
	});

	it("never uses billed spend as occupancy, including in-window cloud billed rows", () => {
		const model = makeModel();
		const context: Context = {
			systemPrompt: "Be helpful.",
			messages: [{ role: "user", content: "Hello", timestamp: 1 }],
		};
		const partial = makeAssistantMessage([{ type: "text", text: "Hello back." }]);
		const billed = { inputTokens: 25, outputTokens: 6, cacheReadTokens: 24, cacheWriteTokens: 1 };
		applyCursorUsage(partial, model, context, 7, { runtime: "cloud", billed });
		expect(partial.usage.input).toBe(0);
		expect(partial.usage.output).toBe(6);
		expect(partial.usage.cacheRead).toBe(24);
		expect(partial.usage.cacheWrite).toBe(1);
		expect(partial.usage.totalTokens).toBe(estimateCursorContextTotalTokens(partial, model, context));
		expect(partial.usage.totalTokens).not.toBe(31);
	});

	it("rejects local turn occupancy at or above the latest compaction tokensBefore", () => {
		const model = makeModel();
		const kept = makeAssistantMessage([{ type: "text", text: "Kept." }]);
		kept.usage = {
			input: 10_000,
			output: 50,
			cacheRead: 40_000,
			cacheWrite: 100,
			totalTokens: 50_150,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const context: Context = {
			systemPrompt: "Be helpful.",
			messages: [
				{ role: "compactionSummary", summary: "compacted", tokensBefore: 50_150, timestamp: 2 } as unknown as Context["messages"][number],
				kept,
				{ role: "user", content: "Again", timestamp: 3 },
			],
		};
		const partial = makeAssistantMessage([{ type: "text", text: "Hi." }]);
		applyCursorUsage(partial, model, context, 7, {
			runtime: "local",
			turn: { inputTokens: 50_100, outputTokens: 50, cacheReadTokens: 40_000, cacheWriteTokens: 100 },
			billed: { inputTokens: 80, outputTokens: 12, cacheReadTokens: 60, cacheWriteTokens: 1 },
		});
		expect(partial.usage.input).toBe(19);
		expect(partial.usage.output).toBe(12);
		expect(partial.usage.cacheRead).toBe(60);
		expect(partial.usage.cacheWrite).toBe(1);
		expect(partial.usage.totalTokens).toBeLessThan(50_150);
		expect(partial.usage.totalTokens).toBe(estimateCursorContextTotalTokens(partial, model, context));
	});

	it("keeps post-compaction local turn occupancy when it is below tokensBefore", () => {
		const model = makeModel();
		const context: Context = {
			systemPrompt: "Be helpful.",
			messages: [
				{ role: "compactionSummary", summary: "compacted", tokensBefore: 50_150, timestamp: 2 } as unknown as Context["messages"][number],
				{ role: "user", content: "Again", timestamp: 3 },
			],
		};
		const partial = makeAssistantMessage([{ type: "text", text: "Hi." }]);
		applyCursorUsage(partial, model, context, 7, {
			runtime: "local",
			turn: { inputTokens: 12_000, outputTokens: 40, cacheReadTokens: 11_000, cacheWriteTokens: 20 },
		});
		expect(partial.usage.totalTokens).toBe(12_040);
	});

	it("prefers billed spend even when billed occupancy exceeds the context window", () => {
		const model = makeModel();
		const context: Context = {
			systemPrompt: "Be helpful.",
			messages: [{ role: "user", content: "Hello", timestamp: 1 }],
		};
		const partial = makeAssistantMessage([{ type: "text", text: "Hello back." }]);
		applyCursorUsage(partial, model, context, 7, {
			runtime: "local",
			turn: { inputTokens: 25, outputTokens: 6, cacheReadTokens: 24, cacheWriteTokens: 1 },
			billed: { inputTokens: 200_000, outputTokens: 80, cacheReadTokens: 150_000, cacheWriteTokens: 10 },
		});
		expect(partial.usage.input).toBe(49_990);
		expect(partial.usage.output).toBe(80);
		expect(partial.usage.cacheRead).toBe(150_000);
		expect(partial.usage.cacheWrite).toBe(10);
		expect(partial.usage.totalTokens).toBe(31);
		expect(partial.usage.totalTokens).toBeLessThan(model.contextWindow);
	});

	it("ignores pre-compaction occupancy and watermarks at or above tokensBefore", () => {
		const model = makeModel();
		const prior = makeAssistantMessage([{ type: "text", text: "Prior." }]);
		prior.usage = {
			input: 10_000,
			output: 50,
			cacheRead: 40_000,
			cacheWrite: 100,
			totalTokens: 50_150,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const kept = makeAssistantMessage([{ type: "text", text: "Kept." }]);
		kept.usage = {
			...prior.usage,
			totalTokens: 50_150,
		};
		const context: Context = {
			systemPrompt: "Be helpful.",
			messages: [
				{ role: "user", content: "Hello", timestamp: 1 },
				prior,
				{ role: "compactionSummary", summary: "compacted", tokensBefore: 50_150, timestamp: 2 } as unknown as Context["messages"][number],
				kept,
				{ role: "user", content: "Again", timestamp: 3 },
			],
		};
		const partial = makeAssistantMessage([{ type: "text", text: "Hi." }]);
		applyCursorUsage(partial, model, context, 7);
		expect(partial.usage.cacheRead).toBe(0);
		expect(partial.usage.totalTokens).toBeLessThan(50_150);
	});

	it("rejects over-window prior assistant occupancy from the compaction poison fixture", () => {
		const fixturePath = new URL("./fixtures/cursor-run-usage-compaction-poison.jsonl", import.meta.url);
		const poisonedAssistant = readFileSync(fixturePath, "utf8")
			.trim()
			.split(/\r?\n/)
			.map((line) => JSON.parse(line) as { message?: AssistantMessage })
			.find((entry) => entry.message?.role === "assistant")?.message;
		expect(poisonedAssistant?.usage.totalTokens).toBe(1_132_478);

		// Same api/provider/model as the fixture so rejection is only over-window poison.
		const model = makeModel("cursor/composer-2-5");
		expect(poisonedAssistant).toMatchObject({
			api: model.api,
			provider: model.provider,
			model: model.id,
		});
		expect(poisonedAssistant!.usage.totalTokens).toBeGreaterThan(model.contextWindow);

		const context: Context = {
			systemPrompt: "Be helpful.",
			messages: [
				{ role: "user", content: "Hello", timestamp: 1 },
				poisonedAssistant!,
				{ role: "user", content: "Again", timestamp: 3 },
			],
		};
		const partial = makeAssistantMessage([{ type: "text", text: "Hi." }]);
		partial.model = model.id;

		applyCursorUsage(partial, model, context, 7);

		expect(partial.usage.cacheRead).toBe(0);
		expect(partial.usage.totalTokens).toBeLessThan(model.contextWindow);
		expect(partial.usage.totalTokens).not.toBe(1_132_478);
	});
});
