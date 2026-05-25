import { CURSOR_REPLAY_ACTIVITY_TOOL_NAME, getCursorReplayDisplayLabel, type CursorReplayLegacyToolName } from "./cursor-tool-names.js";
import { resolveCursorEditDiff } from "./cursor-edit-diff.js";
import {
	asRecord,
	firstNonEmptyLine,
	formatDisplayPath,
	formatDiffString,
	formatError,
	getNumber,
	getString,
	limitText,
	stringifyUnknown,
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
	collectTaskText,
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
	getGenerateImageDisplayPath,
	getGenerateImagePath,
	getGlobBody,
	getGrepBody,
	getLsBody,
	getReadLintDiagnostics,
	getReadLintPaths,
	getShellOutput,
	getTaskDescription,
	getTodoItems,
	getTodoTotalCount,
	inferImageMimeType,
	summarizePlan,
	summarizeMcp,
	summarizeRecordScreen,
	summarizeSemSearch,
	summarizeTask,
	summarizeTodos,
	usesLocalReadPreview,
} from "./cursor-transcript-tool-formatters.js";
import { extractWebFetchTarget, extractWebSearchQuery } from "./cursor-web-tool-activity.js";

export interface ToolDisplayContext {
	rawName: string;
	name: string;
	args: Record<string, unknown>;
	result: NormalizedResult;
	options: TranscriptOptions;
}

interface ActivityReplaySpec {
	labelKey: CursorReplayLegacyToolName;
	buildActivityArgs: (context: ToolDisplayContext) => Record<string, unknown>;
	buildActivitySummary: (context: ToolDisplayContext) => string | undefined;
	buildDetails: (context: ToolDisplayContext, contentText: string) => Record<string, unknown>;
}

interface ToolDisplaySpec {
	formatTranscript: (context: ToolDisplayContext) => string;
	buildPiToolDisplay: (context: ToolDisplayContext) => CursorPiToolDisplay;
	activityReplay?: ActivityReplaySpec;
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
	details: Record<string, unknown>,
): CursorPiToolDisplay {
	const isError = result.status === "error";
	const summary = isError ? details.summary : (details.summary ?? firstNonEmptyLine(contentText));
	return {
		toolName,
		args,
		result: textToolResult(contentText, {
			...details,
			summary,
			expandedText: details.expandedText ?? contentText,
		}),
		isError,
	};
}

function buildActivityReplayDisplay(cursorToolName: string, spec: ToolDisplaySpec, context: ToolDisplayContext): CursorPiToolDisplay {
	const activity = spec.activityReplay;
	if (!activity) throw new Error(`Missing activity replay spec for ${cursorToolName}`);
	const activityTitle = getCursorReplayDisplayLabel(activity.labelKey);
	const activitySummary = activity.buildActivitySummary(context);
	const activityArgs = buildCursorActivityDisplayArgs(
		activity.buildActivityArgs(context),
		activityTitle,
		activitySummary,
	);
	const contentText = spec.formatTranscript(context).trimEnd();
	const details = activity.buildDetails(context, contentText);
	return buildReplaySummaryDisplay(
		CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
		activityArgs,
		context.result,
		contentText,
		{
			cursorToolName,
			title: activityTitle,
			summary: context.result.status === "error" ? undefined : details.summary ?? activitySummary,
			...details,
		},
	);
}

function buildGenericUnknownToolActivityTitle(displayName: string): string {
	if (displayName === "unknown") return "Cursor tool";
	return `Cursor ${truncateArg(displayName)}`;
}

function buildGenericPiToolDisplay(context: ToolDisplayContext): CursorPiToolDisplay {
	const { rawName, name, args, result, options } = context;
	const displayName = rawName.trim() || name;
	const activityTitle = buildGenericUnknownToolActivityTitle(displayName);
	const contentText = formatFallback(name, args, result, options);
	const fallbackBody = contentText.includes("\n\n") ? contentText.slice(contentText.indexOf("\n\n") + 2) : "";
	const activitySummary =
		result.status === "error" ? undefined : firstNonEmptyLine(fallbackBody);
	const activityArgs = buildCursorActivityDisplayArgs(
		{ cursorToolName: displayName === "unknown" ? "tool" : displayName },
		activityTitle,
		activitySummary,
	);
	const summary =
		result.status === "error"
			? undefined
			: activitySummary ?? truncateArg(displayName === "unknown" ? "tool" : displayName);
	return buildReplaySummaryDisplay(CURSOR_REPLAY_ACTIVITY_TOOL_NAME, activityArgs, result, contentText, {
		cursorToolName: name,
		title: activityTitle,
		summary,
		expandedText: contentText,
	});
}

function buildEditPiToolDisplay(context: ToolDisplayContext): CursorPiToolDisplay {
	const { rawName, args, result, options } = context;
	const value = asRecord(result.value);
	const rawDiff = resolveCursorEditDiff(value);
	const normalizedDiff = formatDiffString(rawDiff, options);
	const nativeEditArgs = buildNativeEditDisplayArgs(rawName, args, options);
	const baseActivityArgs = buildCursorEditActivityDisplayArgs(args, options);
	const displayPath = typeof baseActivityArgs.path === "string" ? baseActivityArgs.path : undefined;
	const activityTitle = getCursorReplayDisplayLabel("cursor_edit");
	const activityArgs = buildCursorActivityDisplayArgs(baseActivityArgs, activityTitle, displayPath);
	const contentText = formatEdit(activityArgs, result, options);
	const details = {
		cursorToolName: "edit",
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
		{
			...details,
			title: activityTitle,
			summary: result.status === "error" ? undefined : displayPath ?? "replayed",
		},
	);
}

function buildWritePiToolDisplay(context: ToolDisplayContext): CursorPiToolDisplay {
	const { args, result, options } = context;
	const value = asRecord(result.value);
	const content = getCursorWriteArgContent(args);
	const displayArgs = buildWriteDisplayArgs(args, options);
	const displayPath = typeof args.path === "string" ? formatDisplayPath(args.path, options.cwd) : undefined;
	const contentText = formatWrite(args, result, options).trimEnd();
	const details = {
		cursorToolName: "write",
		path: displayPath,
		linesCreated: getNumber(value, "linesCreated"),
		fileSize: getNumber(value, "fileSize"),
		fileContentAfterWrite: getString(value, "fileContentAfterWrite"),
		expandedText: contentText,
	};
	if (content === undefined) {
		const activityTitle = getCursorReplayDisplayLabel("cursor_write");
		return buildReplaySummaryDisplay(
			CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
			buildCursorActivityDisplayArgs(displayArgs, activityTitle, displayPath ?? "file"),
			result,
			contentText,
			{
				...details,
				title: activityTitle,
				summary: result.status === "error" ? undefined : displayPath ?? "wrote file",
			},
		);
	}
	return {
		toolName: "write",
		args: displayArgs,
		result: textToolResult(contentText, details),
		isError: result.status === "error",
	};
}

const TOOL_DISPLAY_SPECS: Record<string, ToolDisplaySpec> = {
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
		buildPiToolDisplay: (context) => buildActivityReplayDisplay("delete", TOOL_DISPLAY_SPECS.delete, context),
		activityReplay: {
			labelKey: "cursor_delete",
			buildActivityArgs: ({ args, options }) => {
				const displayPath = typeof args.path === "string" ? formatDisplayPath(args.path, options.cwd) : undefined;
				return displayPath ? { path: displayPath } : {};
			},
			buildActivitySummary: ({ args, options }) => {
				const displayPath = typeof args.path === "string" ? formatDisplayPath(args.path, options.cwd) : undefined;
				return displayPath ?? "file";
			},
			buildDetails: ({ args, result, options }) => {
				const displayPath = typeof args.path === "string" ? formatDisplayPath(args.path, options.cwd) : undefined;
				const value = asRecord(result.value);
				return {
					path: displayPath,
					fileSize: getNumber(value, "fileSize"),
					summary: result.status === "error" ? undefined : displayPath ? `deleted ${displayPath}` : "deleted file",
				};
			},
		},
	},
	readLints: {
		formatTranscript: ({ args, result, options }) => formatReadLints(args, result, options),
		buildPiToolDisplay: (context) => buildActivityReplayDisplay("readLints", TOOL_DISPLAY_SPECS.readLints, context),
		activityReplay: {
			labelKey: "cursor_read_lints",
			buildActivityArgs: ({ args, result, options }) => {
				const paths = getReadLintPaths(args, result, options);
				const diagnosticCount = getReadLintDiagnostics(result, options).length;
				return { paths, diagnosticCount };
			},
			buildActivitySummary: ({ args, result, options }) => {
				const paths = getReadLintPaths(args, result, options);
				const diagnosticCount = getReadLintDiagnostics(result, options).length;
				return `${diagnosticCount} diagnostic${diagnosticCount === 1 ? "" : "s"}${paths.length > 0 ? ` in ${paths.join(", ")}` : ""}`;
			},
			buildDetails: () => ({}),
		},
	},
	updateTodos: {
		formatTranscript: ({ args, result, options }) => formatTodos(args, result, options, "updateTodos"),
		buildPiToolDisplay: (context) => buildActivityReplayDisplay("updateTodos", TOOL_DISPLAY_SPECS.updateTodos, context),
		activityReplay: {
			labelKey: "cursor_update_todos",
			buildActivityArgs: ({ args, result }) => {
				const todos = getTodoItems(args, result);
				return { totalCount: getTodoTotalCount(args, result, todos) };
			},
			buildActivitySummary: ({ args, result }) => summarizeTodos(args, result),
			buildDetails: () => ({}),
		},
	},
	createPlan: {
		formatTranscript: ({ args, result, options }) => formatPlan(args, result, options),
		buildPiToolDisplay: (context) => buildActivityReplayDisplay("createPlan", TOOL_DISPLAY_SPECS.createPlan, context),
		activityReplay: {
			labelKey: "cursor_create_plan",
			buildActivityArgs: ({ args, result }) => {
				const todos = getTodoItems(args, result);
				return { totalCount: getTodoTotalCount(args, result, todos) };
			},
			buildActivitySummary: ({ args, result }) => summarizePlan(args, result),
			buildDetails: () => ({}),
		},
	},
	task: {
		formatTranscript: ({ args, result, options }) => formatTask(args, result, options),
		buildPiToolDisplay: (context) => buildActivityReplayDisplay("task", TOOL_DISPLAY_SPECS.task, context),
		activityReplay: {
			labelKey: "cursor_task",
			buildActivityArgs: ({ args, result }) => {
				const description = getTaskDescription(args, result);
				return { description: truncateArg(description) };
			},
			buildActivitySummary: ({ args, result }) => {
				const description = getTaskDescription(args, result);
				return summarizeTask(description, collectTaskText(result));
			},
			buildDetails: () => ({}),
		},
	},
	generateImage: {
		formatTranscript: ({ args, result, options }) => formatGenerateImage(args, result, options),
		buildPiToolDisplay: (context) => buildActivityReplayDisplay("generateImage", TOOL_DISPLAY_SPECS.generateImage, context),
		activityReplay: {
			labelKey: "cursor_generate_image",
			buildActivityArgs: ({ args }) => {
				const prompt = getString(args, "prompt") ?? getString(args, "description") ?? "image";
				return { prompt: truncateArg(prompt) };
			},
			buildActivitySummary: ({ args, result, options }) => {
				const prompt = getString(args, "prompt") ?? getString(args, "description") ?? "image";
				const imageDisplayPath = getGenerateImageDisplayPath(args, result, options);
				return imageDisplayPath ?? truncateArg(prompt);
			},
			buildDetails: ({ args, result, options }, contentText) => {
				const imagePath = getGenerateImagePath(args, result);
				const imageDisplayPath = getGenerateImageDisplayPath(args, result, options);
				return {
					imagePath,
					imageDisplayPath,
					imageMimeType: inferImageMimeType(imagePath),
					summary: result.status === "error" ? undefined : imageDisplayPath ? `saved ${imageDisplayPath}` : "image generated",
					expandedText: contentText,
				};
			},
		},
	},
	mcp: {
		formatTranscript: ({ args, result, options }) => formatMcp(args, result, options),
		buildPiToolDisplay: (context) => buildActivityReplayDisplay("mcp", TOOL_DISPLAY_SPECS.mcp, context),
		activityReplay: {
			labelKey: "cursor_mcp",
			buildActivityArgs: ({ args }) => {
				const toolName = getString(args, "toolName") ?? "mcp";
				return { toolName: truncateArg(toolName) };
			},
			buildActivitySummary: ({ args, result }) => summarizeMcp(args, result),
			buildDetails: ({ args, result }) => ({
				summary: result.status === "error" ? undefined : summarizeMcp(args, result),
			}),
		},
	},
	semSearch: {
		formatTranscript: ({ args, result, options }) => formatSemSearch(args, result, options),
		buildPiToolDisplay: (context) => buildActivityReplayDisplay("semSearch", TOOL_DISPLAY_SPECS.semSearch, context),
		activityReplay: {
			labelKey: "cursor_sem_search",
			buildActivityArgs: ({ args }) => {
				const query = getString(args, "query") ?? "semantic search";
				return { query: truncateArg(query) };
			},
			buildActivitySummary: ({ args }) => summarizeSemSearch(args),
			buildDetails: ({ result }, contentText) => ({
				summary: result.status === "error" ? undefined : firstNonEmptyLine(contentText) ?? "semantic search results captured",
			}),
		},
	},
	recordScreen: {
		formatTranscript: ({ args, result, options }) => formatRecordScreen(args, result, options),
		buildPiToolDisplay: (context) => buildActivityReplayDisplay("recordScreen", TOOL_DISPLAY_SPECS.recordScreen, context),
		activityReplay: {
			labelKey: "cursor_record_screen",
			buildActivityArgs: ({ args, result, options }) => {
				const mode = getString(args, "mode");
				const path = getString(asRecord(result.value), "path");
				return {
					...(mode ? { mode } : {}),
					...(path ? { path: formatDisplayPath(path, options.cwd) } : {}),
				};
			},
			buildActivitySummary: ({ args, result, options }) => summarizeRecordScreen(args, result, options),
			buildDetails: ({ args, result, options }, contentText) => ({
				summary:
					result.status === "error"
						? undefined
						: summarizeRecordScreen(args, result, options) ?? firstNonEmptyLine(contentText) ?? "screen recording updated",
			}),
		},
	},
	webSearch: {
		formatTranscript: ({ args, result, options }) => formatWebSearch(args, result, options),
		buildPiToolDisplay: (context) => buildActivityReplayDisplay("webSearch", TOOL_DISPLAY_SPECS.webSearch, context),
		activityReplay: {
			labelKey: "cursor_web_search",
			buildActivityArgs: ({ args }) => {
				const query = extractWebSearchQuery(args);
				return query ? { query: truncateArg(query) } : {};
			},
			buildActivitySummary: ({ args }) => truncateArg(extractWebSearchQuery(args) ?? "web search"),
			buildDetails: ({ result }, contentText) => ({
				summary: result.status === "error" ? undefined : firstNonEmptyLine(contentText) ?? "web search result captured",
			}),
		},
	},
	webFetch: {
		formatTranscript: ({ args, result, options }) => formatWebFetch(args, result, options),
		buildPiToolDisplay: (context) => buildActivityReplayDisplay("webFetch", TOOL_DISPLAY_SPECS.webFetch, context),
		activityReplay: {
			labelKey: "cursor_web_fetch",
			buildActivityArgs: ({ args }) => {
				const target = extractWebFetchTarget(args);
				return target ? { url: truncateArg(target) } : {};
			},
			buildActivitySummary: ({ args }) => truncateArg(extractWebFetchTarget(args) ?? "web fetch"),
			buildDetails: ({ result }, contentText) => ({
				summary: result.status === "error" ? undefined : firstNonEmptyLine(contentText) ?? "web fetch result captured",
			}),
		},
	},
};

export function formatCursorToolTranscriptFromSpec(context: ToolDisplayContext): string {
	const spec = TOOL_DISPLAY_SPECS[context.name];
	if (spec) return spec.formatTranscript(context);
	return formatFallback(context.name, context.args, context.result, context.options);
}

export function buildCursorPiToolDisplayFromSpec(context: ToolDisplayContext): CursorPiToolDisplay {
	const spec = TOOL_DISPLAY_SPECS[context.name];
	if (spec) return spec.buildPiToolDisplay(context);
	return buildGenericPiToolDisplay(context);
}
