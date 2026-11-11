import { describe, expect, it } from "vitest";
import type { Context, ToolResultMessage } from "@earendil-works/pi-ai";
import { estimateCursorPromptMessageTokens } from "../src/context.js";
import {
	consumeCursorLiveToolResults,
	createCursorLiveRunAccountingState,
	recordCursorLiveSdkTurnEnded,
	takeCursorLiveSdkTurnUsage,
	takeCursorLiveTurnInputTokens,
} from "../src/cursor-live-run-accounting.js";

const earlierTurn = { inputTokens: 25_432, outputTokens: 612, cacheReadTokens: 24_000, cacheWriteTokens: 123 };
const laterTurn = { inputTokens: 26_044, outputTokens: 95, cacheReadTokens: 25_408, cacheWriteTokens: 0 };

function makeToolResult(toolCallId: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 1,
	};
}

describe("cursor live-run accounting", () => {
	it("counts the original prompt once and consumes matching tool results once", () => {
		const promptInputTokens = 100;
		const matchingFirst = makeToolResult("cursor-replay-run-tool-1", "first result");
		const matchingDuplicate = makeToolResult("cursor-replay-run-tool-1", "duplicate result should not count");
		const matchingSecond = makeToolResult("cursor-replay-run-tool-2", "second result");
		const nonmatching = makeToolResult("other-run-tool-1", "other result");
		const context: Context = {
			systemPrompt: "",
			messages: [
				{ role: "user", content: "Run tools", timestamp: 0 },
				nonmatching,
				matchingFirst,
				matchingDuplicate,
				matchingSecond,
			],
		};

		const firstConsumption = consumeCursorLiveToolResults(
			createCursorLiveRunAccountingState(promptInputTokens),
			context,
			(toolResult) => toolResult.toolCallId.startsWith("cursor-replay-run-"),
		);
		const expectedToolResultInput = estimateCursorPromptMessageTokens(matchingFirst) + estimateCursorPromptMessageTokens(matchingSecond);

		expect(firstConsumption.toolCallIds).toEqual([matchingFirst.toolCallId, matchingSecond.toolCallId]);
		expect(firstConsumption.toolResults).toEqual([matchingFirst, matchingSecond]);
		expect(firstConsumption.toolResultInputTokens).toBe(expectedToolResultInput);
		expect(firstConsumption.state.consumedToolResultIds.has(nonmatching.toolCallId)).toBe(false);

		const firstTurn = takeCursorLiveTurnInputTokens(firstConsumption.state, firstConsumption.toolResultInputTokens);
		expect(firstTurn.sessionInputTokens).toBe(promptInputTokens + expectedToolResultInput);

		const secondConsumption = consumeCursorLiveToolResults(
			firstTurn.state,
			context,
			(toolResult) => toolResult.toolCallId.startsWith("cursor-replay-run-"),
		);
		const secondTurn = takeCursorLiveTurnInputTokens(secondConsumption.state, secondConsumption.toolResultInputTokens);

		expect(secondConsumption.toolCallIds).toEqual([]);
		expect(secondConsumption.toolResultInputTokens).toBe(0);
		expect(secondTurn.sessionInputTokens).toBe(0);
	});

	it("takes the latest ended SDK turn usage once", () => {
		const state = recordCursorLiveSdkTurnEnded(
			recordCursorLiveSdkTurnEnded(createCursorLiveRunAccountingState(100), earlierTurn),
			laterTurn,
		);

		const first = takeCursorLiveSdkTurnUsage(state);
		const second = takeCursorLiveSdkTurnUsage(first.state);

		expect(first.usage).toEqual(laterTurn);
		expect(second.usage).toBeUndefined();
	});

	it("keeps attributing later SDK usage after a turn ends without usage", () => {
		const unreported = takeCursorLiveSdkTurnUsage(recordCursorLiveSdkTurnEnded(createCursorLiveRunAccountingState(100)));
		const next = takeCursorLiveSdkTurnUsage(recordCursorLiveSdkTurnEnded(unreported.state, laterTurn));

		expect(unreported.usage).toBeUndefined();
		expect(next.usage).toEqual(laterTurn);
	});

	it("suppresses SDK usage for the rest of the run once a turn is emitted before its SDK turn ended", () => {
		let state = takeCursorLiveSdkTurnUsage(createCursorLiveRunAccountingState(100)).state;

		for (const lateTurns of [[earlierTurn], [undefined, laterTurn], [laterTurn, earlierTurn]]) {
			for (const usage of lateTurns) state = recordCursorLiveSdkTurnEnded(state, usage);
			const taken = takeCursorLiveSdkTurnUsage(state);
			expect(taken.usage).toBeUndefined();
			state = taken.state;
		}
	});
});
