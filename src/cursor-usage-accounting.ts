import { calculateCost } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import {
	CURSOR_APPROX_CHARS_PER_TOKEN,
	CURSOR_IMAGE_TOKEN_ESTIMATE,
	estimateCursorContextTokens,
	estimateCursorTextTokens,
	type CursorPromptOptions,
} from "./context.js";
import { asRecord, getNumber } from "./cursor-record-utils.js";
import type { CursorRuntime } from "./cursor-config.js";

export interface CursorUsagePromptOptions extends CursorPromptOptions {
	maxInputTokens: number;
	charsPerToken: number;
	imageTokenEstimate: number;
}

export interface CursorSdkTurnUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
}

function getPromptInputTokenBudget(model: Model<Api>): number {
	const outputReserveTokens = Math.min(model.maxTokens, Math.max(1, Math.floor(model.contextWindow * 0.2)));
	return Math.max(1, model.contextWindow - outputReserveTokens);
}

export function getCursorPromptOptions(model: Model<Api>): CursorUsagePromptOptions {
	return {
		maxInputTokens: getPromptInputTokenBudget(model),
		charsPerToken: CURSOR_APPROX_CHARS_PER_TOKEN,
		imageTokenEstimate: CURSOR_IMAGE_TOKEN_ESTIMATE,
	};
}

function getNonNegativeTokenCount(record: Record<string, unknown> | undefined, key: string): number | undefined {
	const value = getNumber(record, key);
	return value === undefined || value < 0 ? undefined : Math.floor(value);
}

export function readCursorSdkTurnUsage(value: unknown): CursorSdkTurnUsage | undefined {
	const record = asRecord(value);
	const inputTokens = getNonNegativeTokenCount(record, "inputTokens");
	const outputTokens = getNonNegativeTokenCount(record, "outputTokens");
	const cacheReadTokens = getNonNegativeTokenCount(record, "cacheReadTokens");
	const cacheWriteTokens = getNonNegativeTokenCount(record, "cacheWriteTokens");
	if (inputTokens === undefined || outputTokens === undefined || cacheReadTokens === undefined || cacheWriteTokens === undefined) return undefined;
	return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}

export function readCursorSdkTurnUsageFromUpdate(update: unknown): CursorSdkTurnUsage | undefined {
	const record = asRecord(update);
	return record?.type === "turn-ended" ? readCursorSdkTurnUsage(record.usage) : undefined;
}

function stringifyUsageValue(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return String(value);
	}
}

export function estimateCursorAssistantSessionOutputTokens(message: AssistantMessage): number {
	const parts = message.content
		.map((block) => {
			if (block.type === "text") return block.text;
			if (block.type === "thinking") return block.thinking;
			if (block.type === "toolCall") {
				return `Tool call (${block.name}, call ${block.id}): ${stringifyUsageValue(block.arguments)}`;
			}
			return "";
		})
		.filter(Boolean);
	return estimateCursorTextTokens(parts.join("\n"), { charsPerToken: CURSOR_APPROX_CHARS_PER_TOKEN });
}

function withAssistantMessage(context: Context, partial: AssistantMessage): Context {
	return { ...context, messages: [...context.messages, partial] };
}

export function estimateCursorContextTotalTokens(partial: AssistantMessage, model: Model<Api>, context: Context): number {
	return estimateCursorContextTokens(withAssistantMessage(context, partial), getCursorPromptOptions(model));
}

function getCursorSdkUncachedInputTokens(turnUsage: CursorSdkTurnUsage): number {
	// Observed raw local turn-ended.usage: inputTokens is the full prompt; cache fields partition it.
	// Published SDK toTokenUsage instead sums all four into totalTokens — do not use that transform here.
	return turnUsage.inputTokens - turnUsage.cacheReadTokens - turnUsage.cacheWriteTokens;
}

export function isCursorSdkUsagePartitionSafe(turnUsage: CursorSdkTurnUsage, model: Model<Api>): boolean {
	const counts = [turnUsage.inputTokens, turnUsage.outputTokens, turnUsage.cacheReadTokens, turnUsage.cacheWriteTokens];
	const uncachedInput = getCursorSdkUncachedInputTokens(turnUsage);
	return (
		counts.every((count) => Number.isFinite(count) && count >= 0) &&
		Number.isFinite(uncachedInput) &&
		uncachedInput >= 0 &&
		turnUsage.outputTokens <= model.maxTokens
	);
}

export function isCursorSdkUsageSafeForPiMessage(turnUsage: CursorSdkTurnUsage, model: Model<Api>): boolean {
	return (
		isCursorSdkUsagePartitionSafe(turnUsage, model) &&
		turnUsage.inputTokens + turnUsage.outputTokens <= model.contextWindow
	);
}

export interface CursorSdkUsageApplyOptions {
	runtime: CursorRuntime;
	turn?: CursorSdkTurnUsage;
	occupancyFloor?: number;
}

export function applyCursorSdkUsage(partial: AssistantMessage, turnUsage: CursorSdkTurnUsage): void {
	// Pi treats input/cacheRead/cacheWrite as disjoint additive prompt components.
	partial.usage.input = getCursorSdkUncachedInputTokens(turnUsage);
	partial.usage.output = turnUsage.outputTokens;
	partial.usage.cacheRead = turnUsage.cacheReadTokens;
	partial.usage.cacheWrite = turnUsage.cacheWriteTokens;
	// Full prompt + output equals the sum of Pi's disjoint components.
	partial.usage.totalTokens = turnUsage.inputTokens + turnUsage.outputTokens;
}

export function applyCursorApproximateUsage(partial: AssistantMessage, model: Model<Api>, context: Context, sessionInputTokens: number, occupancyFloor?: number): void {
	const outputTokens = estimateCursorAssistantSessionOutputTokens(partial);
	const floor = occupancyFloor !== undefined && Number.isFinite(occupancyFloor) && occupancyFloor > 0 && occupancyFloor <= model.contextWindow ? occupancyFloor : 0;
	const totalTokens = Math.max(
		Math.max(0, sessionInputTokens) + outputTokens,
		estimateCursorContextTotalTokens(partial, model, context),
		floor,
	);
	// Estimated prompt components describe the same occupancy as totalTokens.
	partial.usage.input = totalTokens - outputTokens;
	partial.usage.output = outputTokens;
	partial.usage.cacheRead = 0;
	partial.usage.cacheWrite = 0;
	partial.usage.totalTokens = totalTokens;
}

export function applyCursorUsage(
	partial: AssistantMessage,
	model: Model<Api>,
	context: Context,
	sessionInputTokens: number,
	sdkUsage?: CursorSdkUsageApplyOptions,
): void {
	const localTurn = sdkUsage?.runtime === "local" ? sdkUsage.turn : undefined;
	if (localTurn && isCursorSdkUsageSafeForPiMessage(localTurn, model)) {
		// Fresh LOCAL occupancy supersedes any previous request-provenance floor.
		applyCursorSdkUsage(partial, localTurn);
	} else {
		applyCursorApproximateUsage(partial, model, context, sessionInputTokens, sdkUsage?.occupancyFloor);
	}
	calculateCost(model, partial.usage);
}
