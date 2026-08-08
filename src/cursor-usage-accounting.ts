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

export function isCursorSdkUsageSafeForPiMessage(turnUsage: CursorSdkTurnUsage, model: Model<Api>): boolean {
	const counts = [turnUsage.inputTokens, turnUsage.outputTokens, turnUsage.cacheReadTokens, turnUsage.cacheWriteTokens];
	const uncachedInput = getCursorSdkUncachedInputTokens(turnUsage);
	return (
		counts.every((count) => Number.isFinite(count) && count >= 0) &&
		Number.isFinite(uncachedInput) &&
		uncachedInput >= 0 &&
		turnUsage.outputTokens <= model.maxTokens &&
		turnUsage.inputTokens + turnUsage.outputTokens <= model.contextWindow
	);
}

export function applyCursorSdkUsage(partial: AssistantMessage, turnUsage: CursorSdkTurnUsage): void {
	// Pi treats input/cacheRead/cacheWrite as disjoint additive prompt components.
	partial.usage.input = getCursorSdkUncachedInputTokens(turnUsage);
	partial.usage.output = turnUsage.outputTokens;
	partial.usage.cacheRead = turnUsage.cacheReadTokens;
	partial.usage.cacheWrite = turnUsage.cacheWriteTokens;
	// totalTokens is context occupancy (full prompt + output), not the sum of spend components alone.
	partial.usage.totalTokens = turnUsage.inputTokens + turnUsage.outputTokens;
}

function isCompatibleCursorAssistantMeasurement(assistant: AssistantMessage, model: Model<Api>): boolean {
	return assistant.api === model.api && assistant.provider === model.provider && assistant.model === model.id;
}

function readAssistantOccupancy(assistant: AssistantMessage, model: Model<Api>): number | undefined {
	if (assistant.stopReason === "aborted" || assistant.stopReason === "error" || !assistant.usage) return undefined;
	if (!isCompatibleCursorAssistantMeasurement(assistant, model)) return undefined;
	const { usage } = assistant;
	const total = usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	if (!(Number.isFinite(total) && total > 0 && total <= model.contextWindow)) return undefined;
	return total;
}

/**
 * Last accepted occupancy for approximate flooring.
 *
 * Only assistants after the latest `compactionSummary` are eligible. Split-turn keep can retain
 * pre-compaction `totalTokens` on those assistants (#204); drop any measurement at or above that
 * summary's `tokensBefore` high-water mark so the footer can fall after compact without using a
 * ratio that also rejects legitimate post-compact SDK occupancy when the pi estimate is smaller.
 */
function getLastAcceptedContextOccupancy(context: Context, model: Model<Api>): number {
	let latestCompactionIndex = -1;
	let compactionTokensBefore: number | undefined;
	for (let index = context.messages.length - 1; index >= 0; index -= 1) {
		const message = context.messages[index];
		const record = asRecord(message);
		if (record?.role !== "compactionSummary") continue;
		latestCompactionIndex = index;
		const tokensBefore = getNonNegativeTokenCount(record, "tokensBefore");
		if (tokensBefore !== undefined) compactionTokensBefore = tokensBefore;
		break;
	}

	for (let index = context.messages.length - 1; index > latestCompactionIndex; index -= 1) {
		const message = context.messages[index];
		if (!message || typeof message !== "object" || !("role" in message) || message.role !== "assistant") continue;
		const total = readAssistantOccupancy(message as AssistantMessage, model);
		if (total === undefined) continue;
		if (compactionTokensBefore !== undefined && total >= compactionTokensBefore) continue;
		return total;
	}
	return 0;
}

export function applyCursorApproximateUsage(partial: AssistantMessage, model: Model<Api>, context: Context, sessionInputTokens: number): void {
	const outputTokens = estimateCursorAssistantSessionOutputTokens(partial);
	partial.usage.input = Math.max(0, sessionInputTokens);
	partial.usage.output = outputTokens;
	partial.usage.cacheRead = 0;
	partial.usage.cacheWrite = 0;
	const estimate = estimateCursorContextTotalTokens(partial, model, context);
	const occupancyFloor = getLastAcceptedContextOccupancy(context, model);
	partial.usage.totalTokens = Math.max(partial.usage.input + partial.usage.output, estimate, occupancyFloor);
}

export function applyCursorUsage(
	partial: AssistantMessage,
	model: Model<Api>,
	context: Context,
	sessionInputTokens: number,
	sdkUsage?: { runtime: CursorRuntime; turn?: CursorSdkTurnUsage },
): void {
	// Only local raw turn-ended usage has a captured full-prompt/cache-partition contract.
	// Cloud raw usage remains display-only until its field semantics are independently observed.
	const usage = sdkUsage?.runtime === "local" ? sdkUsage.turn : undefined;
	if (usage && isCursorSdkUsageSafeForPiMessage(usage, model)) {
		applyCursorSdkUsage(partial, usage);
		return;
	}
	applyCursorApproximateUsage(partial, model, context, sessionInputTokens);
}
