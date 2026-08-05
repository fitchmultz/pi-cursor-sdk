import type { ModelThinkingLevel } from "@earendil-works/pi-ai/compat";
import { asRecord } from "./cursor-record-utils.js";

export interface CursorCustomSubagentConfig {
	description: string;
	prompt: string;
	/** pi Cursor model id such as `grok-4.5` or `claude-opus-5@300k`, or `inherit` for the parent model. */
	model?: string;
	thinking?: ModelThinkingLevel;
	fast?: boolean;
}

export type CursorCustomSubagents = Record<string, CursorCustomSubagentConfig>;

// Config keys become Cursor subagent type names, so they stay word-safe and bounded instead of
// accepting arbitrary keys. README documents this rule because unusable names are skipped silently.
const SUBAGENT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
// Exhaustive by construction so a new pi thinking level fails the build instead of being rejected at runtime.
const THINKING_LEVELS: Record<ModelThinkingLevel, true> = {
	off: true,
	minimal: true,
	low: true,
	medium: true,
	high: true,
	xhigh: true,
	max: true,
};

function isCursorSubagentName(value: string): boolean {
	return SUBAGENT_NAME_PATTERN.test(value);
}

function isCursorSubagentThinkingLevel(value: unknown): value is ModelThinkingLevel {
	return typeof value === "string" && Object.hasOwn(THINKING_LEVELS, value);
}

function parseRequiredText(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}

function parseSubagentEntry(value: unknown): CursorCustomSubagentConfig | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const description = parseRequiredText(record.description);
	const prompt = parseRequiredText(record.prompt);
	if (!description || !prompt) return undefined;
	const model = parseRequiredText(record.model);
	return {
		description,
		prompt,
		...(model ? { model } : {}),
		...(isCursorSubagentThinkingLevel(record.thinking) ? { thinking: record.thinking } : {}),
		...(typeof record.fast === "boolean" ? { fast: record.fast } : {}),
	};
}

/**
 * Parses configured custom subagents, dropping entries that Cursor could not address (unusable name,
 * missing description/prompt) instead of rejecting the whole config file. Returns undefined when no
 * usable entry remains so an empty or fully invalid block does not shadow a lower-precedence layer.
 */
export function parseCursorCustomSubagents(value: unknown): CursorCustomSubagents | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const parsed: CursorCustomSubagents = {};
	for (const [name, entry] of Object.entries(record)) {
		if (!isCursorSubagentName(name)) continue;
		const subagent = parseSubagentEntry(entry);
		if (subagent) parsed[name] = subagent;
	}
	return Object.keys(parsed).length > 0 ? parsed : undefined;
}
