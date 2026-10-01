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

	it("takes SDK turn usage once", () => {
		const state = recordCursorLiveSdkTurnEnded(
			createCursorLiveRunAccountingState(100),
			{ inputTokens: 25_432, outputTokens: 612, cacheReadTokens: 24_000, cacheWriteTokens: 123 },
		);

		const first = takeCursorLiveSdkTurnUsage(state);
		const second = takeCursorLiveSdkTurnUsage(first.state);

		expect(first.sdkTurnUsage).toEqual({ inputTokens: 25_432, outputTokens: 612, cacheReadTokens: 24_000, cacheWriteTokens: 123 });
		expect(second.sdkTurnUsage).toBeUndefined();
		expect(second.state.sdkTurnUsageObserved).toBe(true);
	});

	it("ignores nonmatching tool results without consuming them", () => {
		const promptInputTokens = 25;
		const toolResult = makeToolResult("unrelated-tool-1", "not for this live run");
		const context: Context = {
			systemPrompt: "",
			messages: [toolResult],
		};
		const state = createCursorLiveRunAccountingState(promptInputTokens);
		const consumption = consumeCursorLiveToolResults(state, context, () => false);

		expect(consumption.toolResults).toEqual([]);
		expect(consumption.toolResultInputTokens).toBe(0);
		expect(consumption.state.consumedToolResultIds.has(toolResult.toolCallId)).toBe(false);

		const firstTurn = takeCursorLiveTurnInputTokens(consumption.state, consumption.toolResultInputTokens);
		expect(firstTurn.sessionInputTokens).toBe(promptInputTokens);
	});
});
