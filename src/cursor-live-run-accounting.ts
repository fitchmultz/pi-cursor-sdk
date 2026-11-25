import type { Context, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { CURSOR_APPROX_CHARS_PER_TOKEN, estimateCursorPromptMessageTokens } from "./context.js";
import type { CursorSdkTurnUsage } from "./cursor-usage-accounting.js";

/**
 * SDK usage for the next emitted Pi turn; an ended SDK turn may omit usage. Suppression lasts for the
 * rest of the run because, once a Pi turn is emitted before its SDK turn ended, later turn-ended usage
 * describes an already emitted turn.
 */
type CursorLiveSdkTurnUsageObservation =
	| { kind: "awaiting" }
	| { kind: "available"; usage?: CursorSdkTurnUsage }
	| { kind: "suppressed" };

export interface CursorLiveRunAccountingState {
	promptInputTokens: number;
	promptInputTokensReported: boolean;
	consumedToolResultIds: ReadonlySet<string>;
	sdkTurnUsage: CursorLiveSdkTurnUsageObservation;
	/**
	 * Latest completed SDK model request not yet attributed to an emitted Pi turn. It is the fallback when
	 * turn usage is not attributable, such as tool-use turns emitted while the SDK turn is still running.
	 */
	sdkModelCallUsage?: CursorSdkTurnUsage;
}

export interface CursorLiveToolResultConsumption {
	state: CursorLiveRunAccountingState;
	toolResults: ToolResultMessage[];
	toolResultInputTokens: number;
	toolCallIds: string[];
}

export function createCursorLiveRunAccountingState(promptInputTokens: number): CursorLiveRunAccountingState {
	return {
		promptInputTokens,
		promptInputTokensReported: false,
		consumedToolResultIds: new Set(),
		sdkTurnUsage: { kind: "awaiting" },
	};
}

export function recordCursorLiveSdkTurnEnded(
	state: CursorLiveRunAccountingState,
	usage?: CursorSdkTurnUsage,
): CursorLiveRunAccountingState {
	switch (state.sdkTurnUsage.kind) {
		case "awaiting":
		case "available":
			// The latest ended turn describes current occupancy, replacing an earlier untaken turn.
			return { ...state, sdkTurnUsage: { kind: "available", usage } };
		case "suppressed":
			return state;
		default: {
			const _exhaustive: never = state.sdkTurnUsage;
			return _exhaustive;
		}
	}
}

export function recordCursorLiveSdkModelCallCompleted(
	state: CursorLiveRunAccountingState,
	usage: CursorSdkTurnUsage,
): CursorLiveRunAccountingState {
	// The latest completed request describes current occupancy, replacing an earlier untaken request.
	return { ...state, sdkModelCallUsage: usage };
}

/**
 * Takes SDK usage for one emitted Pi turn; taking before the SDK turn ended suppresses the rest of the run.
 * When no attributable turn usage exists, the latest untaken model request's usage is used instead.
 */
export function takeCursorLiveSdkTurnUsage(state: CursorLiveRunAccountingState): {
	state: CursorLiveRunAccountingState;
	usage?: CursorSdkTurnUsage;
} {
	const observation = state.sdkTurnUsage;
	const modelCallUsage = state.sdkModelCallUsage;
	switch (observation.kind) {
		case "available":
			return {
				state: { ...state, sdkTurnUsage: { kind: "awaiting" }, sdkModelCallUsage: undefined },
				usage: observation.usage ?? modelCallUsage,
			};
		case "awaiting":
			return { state: { ...state, sdkTurnUsage: { kind: "suppressed" }, sdkModelCallUsage: undefined }, usage: modelCallUsage };
		case "suppressed":
			return { state: { ...state, sdkModelCallUsage: undefined }, usage: modelCallUsage };
		default: {
			const _exhaustive: never = observation;
			return _exhaustive;
		}
	}
}

function asToolResultMessage(message: Message): ToolResultMessage | undefined {
	return message.role === "toolResult" ? message : undefined;
}

export function consumeCursorLiveToolResults(
	state: CursorLiveRunAccountingState,
	context: Context,
	isMatchingToolResult: (toolResult: ToolResultMessage) => boolean,
): CursorLiveToolResultConsumption {
	const consumedToolResultIds = new Set(state.consumedToolResultIds);
	const toolResults: ToolResultMessage[] = [];
	let toolResultInputTokens = 0;

	for (const message of context.messages) {
		const toolResult = asToolResultMessage(message);
		if (!toolResult) continue;
		if (consumedToolResultIds.has(toolResult.toolCallId)) continue;
		if (!isMatchingToolResult(toolResult)) continue;
		consumedToolResultIds.add(toolResult.toolCallId);
		toolResults.push(toolResult);
		toolResultInputTokens += estimateCursorPromptMessageTokens(toolResult, { charsPerToken: CURSOR_APPROX_CHARS_PER_TOKEN });
	}

	return {
		state: { ...state, consumedToolResultIds },
		toolResults,
		toolResultInputTokens,
		toolCallIds: toolResults.map((toolResult) => toolResult.toolCallId),
	};
}

export function takeCursorLiveTurnInputTokens(
	state: CursorLiveRunAccountingState,
	toolResultInputTokens: number,
): { state: CursorLiveRunAccountingState; sessionInputTokens: number } {
	const promptInputTokens = state.promptInputTokensReported ? 0 : state.promptInputTokens;
	return {
		state: state.promptInputTokensReported ? state : { ...state, promptInputTokensReported: true },
		sessionInputTokens: promptInputTokens + toolResultInputTokens,
	};
}
