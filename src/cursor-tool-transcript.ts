import {
	asRecord,
	getString,
	getToolArgs,
	getToolName,
	getToolResult,
	normalizeResult,
	normalizeToolName,
	type CursorPiToolDisplay,
	type TranscriptOptions,
} from "./cursor-transcript-utils.js";
import {
	buildCursorPiToolDisplayFromSpec,
	formatCursorToolTranscriptFromSpec,
	type ToolDisplayContext,
} from "./cursor-transcript-tool-specs.js";
import { resolveTranscriptToolName } from "./cursor-web-tool-activity.js";

export type { CursorPiToolDisplay } from "./cursor-transcript-utils.js";

export function getCursorCreatePlanText(toolCall: unknown): string | undefined {
	const name = normalizeToolName(getToolName(toolCall));
	if (name !== "createPlan") return undefined;
	const args = getToolArgs(toolCall);
	const result = normalizeResult(getToolResult(toolCall));
	const plan = getString(args, "plan") ?? getString(asRecord(result.value), "plan");
	const trimmed = plan?.trim();
	return trimmed || undefined;
}

function buildToolDisplayContext(toolCall: unknown, options: TranscriptOptions): ToolDisplayContext {
	const rawName = getToolName(toolCall);
	const args = getToolArgs(toolCall);
	return {
		rawName,
		name: resolveTranscriptToolName(rawName, args),
		args,
		result: normalizeResult(getToolResult(toolCall)),
		options,
	};
}

export function formatCursorToolTranscript(toolCall: unknown, options: TranscriptOptions = {}): string {
	return formatCursorToolTranscriptFromSpec(buildToolDisplayContext(toolCall, options));
}

export function buildCursorPiToolDisplay(toolCall: unknown, options: TranscriptOptions = {}): CursorPiToolDisplay {
	return buildCursorPiToolDisplayFromSpec(buildToolDisplayContext(toolCall, options));
}

export function mergeCursorToolCalls(startedToolCall: unknown, completedToolCall: unknown): unknown {
	const started = asRecord(startedToolCall);
	const completed = asRecord(completedToolCall);
	if (!started) return completedToolCall;
	if (!completed) return startedToolCall;
	return {
		...started,
		...completed,
		name: completed.name ?? started.name,
		type: completed.type ?? started.type,
		args: completed.args ?? started.args,
		input: completed.input ?? started.input,
		result: completed.result ?? started.result,
	};
}
