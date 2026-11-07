import {
	CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
	getCursorReplayCallSummary,
	getCursorToolActivityTitle,
	getCursorToolActivityReplaySpec,
	getCursorToolGenerateImageReplaySpec,
	type CursorNormalizedToolName,
	type CursorReplayActivityToolName,
} from "./cursor-tool-presentation-registry.js";
import { resolveCursorEditDiff } from "./cursor-edit-diff.js";
import {
	assembleCursorReplayActivityDetails,
	assembleCursorReplayGenerateImageDetails,
	CURSOR_REPLAY_UNREGISTERED_ACTIVITY_TOOL_NAME,
	type CursorReplayToolDetails,
} from "./cursor-replay-tool-details.js";
import { asRecord, getNumber, getString } from "./cursor-record-utils.js";
import {
	firstNonEmptyLine,
	formatDisplayPath,
	formatDiffString,
	formatError,
	limitText,
	truncateArg,
	type CursorPiToolDisplay,
	type NormalizedResult,
	type PiToolDisplayResult,
	type TranscriptOptions,
} from "./cursor-transcript-utils.js";
import {
	buildCursorEditActivityDisplayArgs,
	buildFindDisplayArgs,
	buildGrepDisplayArgs,
	buildNativeEditDisplayArgs,
	buildReadDisplayArgs,
	buildShellDisplayArgs,
	buildWriteDisplayArgs,
	formatDelete,
	formatEdit,
	formatFallback,
	formatGenerateImage,
	formatGlob,
	formatGrep,
	formatLs,
	formatMcp,
	formatWebFetch,
	formatWebSearch,
	formatPlan,
	formatRecordScreen,
	formatSemSearch,
	formatRead,
	formatReadLints,
	formatShell,
	formatTask,
	formatTodos,
	formatWrite,
	formatNativeReadDisplayContent,
	getCursorWriteArgContent,
	getGlobBody,
	getGrepBody,
	getLsBody,
	getShellOutput,
	usesLocalReadPreview,
} from "./cursor-transcript-tool-formatters.js";
export interface ToolDisplayContext {
	rawName: string;
	name: string;
	args: Record<string, unknown>;
	result: NormalizedResult;
	options: TranscriptOptions;
}

type NeutralActivityReplayToolName = Exclude<CursorReplayActivityToolName, "edit" | "write" | "generateImage">;

interface ToolDisplaySpec {
	formatTranscript: (context: ToolDisplayContext) => string;
	buildPiToolDisplay: (context: ToolDisplayContext) => CursorPiToolDisplay;
}

function textToolResult(text: string, details?: unknown): PiToolDisplayResult {
	return { content: [{ type: "text", text }], details };
}

function buildCursorActivityDisplayArgs(
	args: Record<string, unknown>,
	activityTitle: string,
	activitySummary: string | undefined,
): Record<string, unknown> {
	const trimmedSummary = activitySummary?.trim();
	return {
		...args,
		activityTitle,
		...(trimmedSummary ? { activitySummary: trimmedSummary } : {}),
	};
}

function buildReplaySummaryDisplay(
	toolName: string,
	args: Record<string, unknown>,
	result: NormalizedResult,
	contentText: string,
	details: CursorReplayToolDetails,
): CursorPiToolDisplay {
	const isError = result.status === "error";
	const expandedText = details.expandedText ?? contentText;
	const summary = details.summary;
	return {
		toolName,
		args,
		result: textToolResult(contentText, {
			...details,
			summary,
			expandedText,
		}),
		isError,
	};
}

function buildActivityReplayDisplay(
	sourceToolName: NeutralActivityReplayToolName,
	context: ToolDisplayContext,
): CursorPiToolDisplay {
	const spec = TOOL_DISPLAY_IMPLEMENTATIONS[sourceToolName];
	const activity = getCursorToolActivityReplaySpec(sourceToolName);
	if (!activity) throw new Error(`Missing activity replay spec for ${sourceToolName}`);
	const activityTitle = getCursorToolActivityTitle(sourceToolName);
	const replayArgs = activity.buildActivityArgs(context);
	const activitySummary = getCursorReplayCallSummary(sourceToolName, replayArgs);
	const activityArgs = buildCursorActivityDisplayArgs({ ...replayArgs }, activityTitle, activitySummary);
	const contentText = spec.formatTranscript(context).trimEnd();
	const activityFields = activity.buildDetails(context, contentText);
	const details = assembleCursorReplayActivityDetails(
		sourceToolName,
		activityTitle,
		activityFields,
		contentText,
		context.result.status === "error",
		activitySummary,
	);
	return buildReplaySummaryDisplay(CURSOR_REPLAY_ACTIVITY_TOOL_NAME, activityArgs, context.result, contentText, details);
}

function buildGenerateImageReplayDisplay(context: ToolDisplayContext): CursorPiToolDisplay {
	const spec = TOOL_DISPLAY_IMPLEMENTATIONS.generateImage;
	const replay = getCursorToolGenerateImageReplaySpec("generateImage");
	if (!replay) throw new Error("Missing generate image replay spec");
	const activityTitle = getCursorToolActivityTitle("generateImage");
	const replayArgs = replay.buildActivityArgs(context);
	const activitySummary = getCursorReplayCallSummary("generateImage", replayArgs);
	const activityArgs = buildCursorActivityDisplayArgs({ ...replayArgs }, activityTitle, activitySummary);
	const contentText = spec.formatTranscript(context).trimEnd();
	const details = assembleCursorReplayGenerateImageDetails(
		replay.buildDetails(context, contentText),
		contentText,
		context.result.status === "error",
		activitySummary,
	);
	return buildReplaySummaryDisplay(CURSOR_REPLAY_ACTIVITY_TOOL_NAME, activityArgs, context.result, contentText, details);
}

function buildGenericPiToolDisplay(context: ToolDisplayContext): CursorPiToolDisplay {
	const { rawName, name, args, result, options } = context;
	const displayName = rawName.trim() || name;
	const activityTitle = getCursorToolActivityTitle(displayName);
	const contentText = formatFallback(name, args, result, options);
	const fallbackBody = contentText.includes("\n\n") ? contentText.slice(contentText.indexOf("\n\n") + 2) : "";
	const activitySummary =
		result.status === "error" ? undefined : firstNonEmptyLine(fallbackBody);
	const activityArgs = buildCursorActivityDisplayArgs({}, activityTitle, activitySummary);
	const summary =
		result.status === "error"
			? undefined
			: activitySummary ?? truncateArg(displayName === "unknown" ? "tool" : displayName);
	return buildReplaySummaryDisplay(
		CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
		activityArgs,
		result,
		contentText,
		assembleCursorReplayActivityDetails(
			CURSOR_REPLAY_UNREGISTERED_ACTIVITY_TOOL_NAME,
			activityTitle,
			{ summary, expandedText: contentText },
			contentText,
			result.status === "error",
			activitySummary,
		),
	);
}

function buildEditActivitySummary(
	displayPath: string | undefined,
	value: Record<string, unknown>,
): string | undefined {
	const path = displayPath ?? "replayed";
	const linesAdded = getNumber(value, "linesAdded");
	const linesRemoved = getNumber(value, "linesRemoved");
	const parts = [
		linesAdded ? `added ${linesAdded} line${linesAdded === 1 ? "" : "s"}` : undefined,
		linesRemoved ? `removed ${linesRemoved} line${linesRemoved === 1 ? "" : "s"}` : undefined,
	].filter((part): part is string => Boolean(part));
	if (parts.length > 0) return `${path} ${parts.join(", ")}`;
	return path;
}

function buildEditPiToolDisplay(context: ToolDisplayContext): CursorPiToolDisplay {
	const { rawName, args, result, options } = context;
	const value = asRecord(result.value);
	const rawDiff = resolveCursorEditDiff(value);
	const normalizedDiff = formatDiffString(rawDiff, options);
	const nativeEditArgs = buildNativeEditDisplayArgs(rawName, args, options);
	const baseActivityArgs = buildCursorEditActivityDisplayArgs(args, options);
	const displayPath = typeof baseActivityArgs.path === "string" ? baseActivityArgs.path : undefined;
	const activityTitle = getCursorToolActivityTitle("edit");
	const activityArgs = buildCursorActivityDisplayArgs(baseActivityArgs, activityTitle, displayPath);
	const contentText = formatEdit(activityArgs, result, options);
	const details: CursorReplayToolDetails = {
		variant: "nativeEdit",
		path: displayPath,
		linesAdded: getNumber(value, "linesAdded"),
		linesRemoved: getNumber(value, "linesRemoved"),
		diffString: normalizedDiff,
		diff: normalizedDiff,
		firstChangedLine: getNumber(value, "firstChangedLine"),
	};
	if (nativeEditArgs) {
		return {
			toolName: "edit",
			args: nativeEditArgs,
			result: textToolResult(contentText, details),
			isError: result.status === "error",
		};
	}
	return buildReplaySummaryDisplay(
		CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
		activityArgs,
		result,
		contentText.trimEnd(),
		assembleCursorReplayActivityDetails(
			"edit",
			activityTitle,
			{
				path: displayPath,
				summary: result.status === "error" ? undefined : buildEditActivitySummary(displayPath, value ?? {}),
				expandedText: contentText.trimEnd(),
				diffString: normalizedDiff,
				diff: normalizedDiff,
				linesAdded: getNumber(value, "linesAdded"),
				linesRemoved: getNumber(value, "linesRemoved"),
			},
			contentText.trimEnd(),
			result.status === "error",
			displayPath,
		),
	);
}

function buildWritePiToolDisplay(context: ToolDisplayContext): CursorPiToolDisplay {
	const { args, result, options } = context;
	const value = asRecord(result.value);
	const content = getCursorWriteArgContent(args);
	const displayArgs = buildWriteDisplayArgs(args, options);
	const displayPath = typeof args.path === "string" ? formatDisplayPath(args.path, options.cwd) : undefined;
	const contentText = formatWrite(args, result, options).trimEnd();
	const details: CursorReplayToolDetails = {
		variant: "nativeWrite",
		path: displayPath,
		linesCreated: getNumber(value, "linesCreated"),
		fileSize: getNumber(value, "fileSize"),
		fileContentAfterWrite: getString(value, "fileContentAfterWrite"),
		expandedText: contentText,
	};
	if (content === undefined) {
		const activityTitle = getCursorToolActivityTitle("write");
		return buildReplaySummaryDisplay(
			CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
			buildCursorActivityDisplayArgs(displayArgs, activityTitle, displayPath ?? "file"),
			result,
			contentText,
			assembleCursorReplayActivityDetails(
				"write",
				activityTitle,
				{
					path: displayPath,
					summary: result.status === "error" ? undefined : displayPath ?? "wrote file",
					expandedText: contentText,
					fileContentAfterWrite: getString(value, "fileContentAfterWrite"),
				},
				contentText,
				result.status === "error",
				displayPath ?? "file",
			),
		);
	}
	return {
		toolName: "write",
		args: displayArgs,
		result: textToolResult(contentText, details),
		isError: result.status === "error",
	};
}

const TOOL_DISPLAY_IMPLEMENTATIONS: Record<CursorNormalizedToolName, ToolDisplaySpec> = {
	read: {
		formatTranscript: ({ args, result, options }) => formatRead(args, result, options),
		buildPiToolDisplay: ({ args, result, options }) => {
			const isError = result.status === "error";
			const usesLocalPreview = !isError && usesLocalReadPreview(args, result, options);
			return {
				toolName: "read",
				args: buildReadDisplayArgs(args, options, result),
				result: textToolResult(
					isError ? formatError(result.error) : formatNativeReadDisplayContent(args, result, options),
					usesLocalPreview ? { localReadPreview: true } : undefined,
				),
				isError,
			};
		},
	},
	shell: {
		formatTranscript: ({ args, result, options }) => formatShell(args, result, options),
		buildPiToolDisplay: ({ args, result, options }) => {
			const shellOutput = getShellOutput(result, args);
			const isError = result.status === "error" || shellOutput.timedOut || (shellOutput.exitCode !== undefined && shellOutput.exitCode !== 0);
			return {
				toolName: "bash",
				args: buildShellDisplayArgs(args),
				result: textToolResult(result.status === "error" ? formatError(result.error) : limitText(shellOutput.text, options)),
				isError,
			};
		},
	},
	grep: {
		formatTranscript: ({ args, result, options }) => formatGrep(args, result, options),
		buildPiToolDisplay: ({ args, result, options }) => {
			const isError = result.status === "error";
			return {
				toolName: "grep",
				args: buildGrepDisplayArgs(args, options),
				result: textToolResult(isError ? formatError(result.error) : getGrepBody(result, options)),
				isError,
			};
		},
	},
	glob: {
		formatTranscript: ({ args, result, options }) => formatGlob(args, result, options),
		buildPiToolDisplay: ({ args, result, options }) => {
			const isError = result.status === "error";
			return {
				toolName: "find",
				args: buildFindDisplayArgs(args, options),
				result: textToolResult(isError ? formatError(result.error) : getGlobBody(result, options)),
				isError,
			};
		},
	},
	ls: {
		formatTranscript: ({ args, result, options }) => formatLs(args, result, options),
		buildPiToolDisplay: ({ args, result, options }) => ({
			toolName: "ls",
			args,
			result: textToolResult(result.status === "error" ? formatError(result.error) : getLsBody(result, options).trim()),
			isError: result.status === "error",
		}),
	},
	edit: {
		formatTranscript: ({ args, result, options }) => formatEdit(args, result, options),
		buildPiToolDisplay: buildEditPiToolDisplay,
	},
	write: {
		formatTranscript: ({ args, result, options }) => formatWrite(args, result, options),
		buildPiToolDisplay: buildWritePiToolDisplay,
	},
	delete: {
		formatTranscript: ({ args, result, options }) => formatDelete(args, result, options),
		buildPiToolDisplay: (context) => buildActivityReplayDisplay("delete", context),
	},
	readLints: {
		formatTranscript: ({ args, result, options }) => formatReadLints(args, result, options),
		buildPiToolDisplay: (context) => buildActivityReplayDisplay("readLints", context),
	},
	updateTodos: {
		formatTranscript: ({ args, result, options }) => formatTodos(args, result, options, "updateTodos"),
		buildPiToolDisplay: (context) => buildActivityReplayDisplay("updateTodos", context),
	},
	createPlan: {
		formatTranscript: ({ args, result, options }) => formatPlan(args, result, options),
		buildPiToolDisplay: (context) => buildActivityReplayDisplay("createPlan", context),
	},
	task: {
		formatTranscript: ({ args, result, options }) => formatTask(args, result, options),
		buildPiToolDisplay: (context) => buildActivityReplayDisplay("task", context),
	},
	generateImage: {
		formatTranscript: ({ args, result, options }) => formatGenerateImage(args, result, options),
		buildPiToolDisplay: (context) => buildGenerateImageReplayDisplay(context),
	},
	mcp: {
		formatTranscript: ({ args, result, options }) => formatMcp(args, result, options),
		buildPiToolDisplay: (context) => buildActivityReplayDisplay("mcp", context),
	},
	semSearch: {
		formatTranscript: ({ args, result, options }) => formatSemSearch(args, result, options),
		buildPiToolDisplay: (context) => buildActivityReplayDisplay("semSearch", context),
	},
	recordScreen: {
		formatTranscript: ({ args, result, options }) => formatRecordScreen(args, result, options),
		buildPiToolDisplay: (context) => buildActivityReplayDisplay("recordScreen", context),
	},
	webSearch: {
		formatTranscript: ({ args, result, options }) => formatWebSearch(args, result, options),
		buildPiToolDisplay: (context) => buildActivityReplayDisplay("webSearch", context),
	},
	webFetch: {
		formatTranscript: ({ args, result, options }) => formatWebFetch(args, result, options),
		buildPiToolDisplay: (context) => buildActivityReplayDisplay("webFetch", context),
	},
};

function getToolDisplaySpec(name: string): ToolDisplaySpec | undefined {
	if (Object.hasOwn(TOOL_DISPLAY_IMPLEMENTATIONS, name)) return TOOL_DISPLAY_IMPLEMENTATIONS[name as CursorNormalizedToolName];
	return undefined;
}

export function formatCursorToolTranscriptFromSpec(context: ToolDisplayContext): string {
	const spec = getToolDisplaySpec(context.name);
	if (spec) return spec.formatTranscript(context);
	return formatFallback(context.name, context.args, context.result, context.options);
}

export function buildCursorPiToolDisplayFromSpec(context: ToolDisplayContext): CursorPiToolDisplay {
	const spec = getToolDisplaySpec(context.name);
	if (spec) return spec.buildPiToolDisplay(context);
	return buildGenericPiToolDisplay(context);
}
