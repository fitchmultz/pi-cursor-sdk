import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	getLanguageFromPath,
	highlightCode,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Image, Text, type Component } from "@earendil-works/pi-tui";
import { Type, type TSchema } from "typebox";
import { getCursorSessionCwd } from "./cursor-session-cwd.js";
import {
	CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
	CURSOR_REPLAY_LEGACY_TOOL_NAMES,
	getCursorReplayDisplayLabel,
	getCursorReplaySourceToolName,
	isCursorReplayToolName,
	type CursorReplayToolName,
} from "./cursor-tool-names.js";
import type { CursorPiToolDisplay } from "./cursor-tool-transcript.js";

const CURSOR_MODEL_ACTIVE_REPLAY_TOOL_NAMES = [CURSOR_REPLAY_ACTIVITY_TOOL_NAME] as const;
const CURSOR_REPLAY_TOOL_NAMES = [CURSOR_REPLAY_ACTIVITY_TOOL_NAME, ...CURSOR_REPLAY_LEGACY_TOOL_NAMES] as const;
const NATIVE_CURSOR_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls", ...CURSOR_REPLAY_TOOL_NAMES] as const;
type NativeCursorToolName = (typeof NATIVE_CURSOR_TOOL_NAMES)[number];
const NATIVE_CURSOR_TOOL_DISPLAY_ENV = "PI_CURSOR_NATIVE_TOOL_DISPLAY";
// Registration-only kill switch for users who want transcript fallback without shadowing read/bash/ls.
const NATIVE_CURSOR_TOOL_REGISTRATION_ENV = "PI_CURSOR_REGISTER_NATIVE_TOOLS";
const CURSOR_REPLAY_COLLAPSED_PREVIEW_LINES = 8;
const cursorReplayToolSchema = Type.Object({}, { additionalProperties: true });

export interface CursorNativeToolDisplayItem extends CursorPiToolDisplay {
	id: string;
	terminate?: boolean;
}

const registeredNativeToolNames = new Set<NativeCursorToolName>();
const nativeToolResults = new Map<string, CursorNativeToolDisplayItem>();

function readBooleanEnv(name: string): boolean | undefined {
	const value = process.env[name]?.trim().toLowerCase();
	if (value === "1" || value === "true" || value === "yes" || value === "on") return true;
	if (value === "0" || value === "false" || value === "no" || value === "off") return false;
	return undefined;
}

function isCursorNativeToolDisplayRequested(): boolean {
	const override = readBooleanEnv(NATIVE_CURSOR_TOOL_DISPLAY_ENV);
	if (override !== undefined) return override;
	return process.stdout.isTTY === true;
}

function isNativeCursorToolName(toolName: string): toolName is NativeCursorToolName {
	return NATIVE_CURSOR_TOOL_NAMES.some((nativeToolName) => nativeToolName === toolName);
}


function isCursorNativeToolRegistrationRequested(): boolean {
	return readBooleanEnv(NATIVE_CURSOR_TOOL_REGISTRATION_ENV) !== false && isCursorNativeToolDisplayRequested();
}

export function isCursorNativeToolDisplayEnabled(): boolean {
	return registeredNativeToolNames.size > 0;
}

export function isCursorNativeToolDisplayRuntimeEnabled(): boolean {
	return isCursorNativeToolDisplayRequested() && registeredNativeToolNames.size > 0;
}

export function canRenderCursorToolNatively(toolName: string): boolean {
	return isNativeCursorToolName(toolName) && registeredNativeToolNames.has(toolName);
}

export function recordCursorNativeToolDisplay(item: CursorNativeToolDisplayItem): boolean {
	if (!canRenderCursorToolNatively(item.toolName)) return false;
	nativeToolResults.set(item.id, item);
	return true;
}

export function deleteCursorNativeToolDisplay(id: string): void {
	nativeToolResults.delete(id);
}

function consumeCursorNativeToolDisplay(id: string): CursorNativeToolDisplayItem | undefined {
	const item = nativeToolResults.get(id);
	if (item) nativeToolResults.delete(id);
	return item;
}

function isCursorReplayToolCallId(toolCallId: string): boolean {
	return toolCallId.startsWith("cursor-replay-");
}

function isCursorFileMutationToolName(toolName: string): toolName is "edit" | "write" {
	return toolName === "edit" || toolName === "write";
}

export const __testUtils = {
	nativeToolResultCount: () => nativeToolResults.size,
	reset(): void {
		registeredNativeToolNames.clear();
		nativeToolResults.clear();
	},
};

function wrapNativeCursorTool<TParams extends TSchema, TDetails, TState>(
	definition: ToolDefinition<TParams, TDetails, TState>,
	getCurrentDefinition: () => ToolDefinition<TParams, TDetails, TState>,
): ToolDefinition<TParams, TDetails, TState> {
	return {
		...definition,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const cursorDisplay = consumeCursorNativeToolDisplay(toolCallId);
			if (cursorDisplay) {
				if (cursorDisplay.isError) {
					const text = cursorDisplay.result.content
						.map((entry) => (entry.type === "text" ? entry.text : undefined))
						.filter((entry): entry is string => Boolean(entry))
						.join("\n");
					throw new Error(text || "Cursor tool replay failed");
				}
				return {
					content: cursorDisplay.result.content,
					details: cursorDisplay.result.details as TDetails,
					terminate: cursorDisplay.terminate ?? true,
				};
			}
			if (isCursorFileMutationToolName(definition.name) && isCursorReplayToolCallId(toolCallId)) {
				throw new Error(`No recorded Cursor ${definition.name} result was available. This replay-only call does not execute file mutations.`);
			}
			return getCurrentDefinition().execute(toolCallId, params, signal, onUpdate, ctx);
		},
		renderCall(args, theme, context) {
			if (isCursorFileMutationToolName(definition.name) && isCursorReplayToolCallId(context.toolCallId)) {
				return renderNativeLookingCursorFileMutationCall(definition.name, args as Record<string, unknown>, theme, context.isPartial);
			}
			const currentRenderCall = getCurrentDefinition().renderCall;
			return currentRenderCall ? currentRenderCall(args, theme, context) : new Text("", 0, 0);
		},
		renderResult(result, options, theme, context) {
			const details = asCursorReplayToolDetails(result.details);
			if (isCursorFileMutationToolName(definition.name) && details?.cursorToolName === definition.name) {
				return renderCursorReplayResult(result, options, theme, context, context.isError);
			}
			const currentRenderResult = getCurrentDefinition().renderResult;
			return currentRenderResult ? currentRenderResult(result, options, theme, context) : new Text("", 0, 0);
		},
	};
}

interface CursorReplayToolDetails {
	cursorToolName?: string;
	title?: string;
	summary?: string;
	path?: string;
	imagePath?: string;
	imageDisplayPath?: string;
	imageMimeType?: string;
	linesAdded?: number;
	linesRemoved?: number;
	linesCreated?: number;
	fileSize?: number;
	fileContentAfterWrite?: string;
	diffString?: string;
	diff?: string;
	firstChangedLine?: number;
	expandedText?: string;
}

function asCursorReplayToolDetails(value: unknown): CursorReplayToolDetails | undefined {
	return value && typeof value === "object" ? (value as CursorReplayToolDetails) : undefined;
}

function inferImageMimeTypeFromPath(path: string | undefined): string | undefined {
	switch (extname(path ?? "").toLowerCase()) {
		case ".png":
			return "image/png";
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".gif":
			return "image/gif";
		case ".webp":
			return "image/webp";
		default:
			return undefined;
	}
}

function readImageFileForReplay(path: string | undefined): string | undefined {
	if (!path) return undefined;
	try {
		const stat = statSync(path);
		if (!stat.isFile() || stat.size <= 0 || stat.size > 25 * 1024 * 1024) return undefined;
		return readFileSync(path).toString("base64");
	} catch {
		return undefined;
	}
}

function buildImageReplayComponent(text: string, imageData: string, mimeType: string, filename: string, theme: CursorReplayRenderTheme): Component {
	const textComponent = new Text(text, 0, 0);
	const imageComponent = new Image(imageData, mimeType, { fallbackColor: (value) => theme.fg("muted", value) }, { filename, maxWidthCells: 40, maxHeightCells: 16 });
	return {
		render(width: number): string[] {
			return [...textComponent.render(width), ...imageComponent.render(width)];
		},
		invalidate(): void {
			textComponent.invalidate();
			imageComponent.invalidate();
		},
	};
}

function getCursorReplayToolLabel(toolName: CursorReplayToolName): string {
	if (toolName === "cursor_edit") return "edit";
	if (toolName === "cursor_write") return "write";
	return getCursorReplayDisplayLabel(toolName);
}

function getCursorReplayPath(args: Record<string, unknown> | undefined, details: CursorReplayToolDetails | undefined): string {
	const argPath = args?.path;
	return details?.path ?? (typeof argPath === "string" && argPath.trim() ? argPath : "unknown");
}

type CursorReplayRenderCall = NonNullable<ToolDefinition<typeof cursorReplayToolSchema, unknown>["renderCall"]>;
type CursorReplayRenderResult = NonNullable<ToolDefinition<typeof cursorReplayToolSchema, unknown>["renderResult"]>;
type CursorReplayRenderTheme = Parameters<CursorReplayRenderCall>[1];

function parseUnifiedDiffHunkHeader(line: string): { oldLine: number; newLine: number } | undefined {
	const match = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(line);
	if (!match) return undefined;
	return { oldLine: Number(match[1]), newLine: Number(match[2]) };
}

function replaceCursorReplayTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

function formatCursorReplayDiffLine(prefix: string, lineNumber: number, content: string, theme: CursorReplayRenderTheme): string {
	const rendered = `${prefix}${lineNumber} ${replaceCursorReplayTabs(content)}`;
	if (prefix === "+") return theme.fg("toolDiffAdded", rendered);
	if (prefix === "-") return theme.fg("toolDiffRemoved", rendered);
	return theme.fg("toolDiffContext", rendered);
}

function formatCursorReplayDiff(diff: string, theme: CursorReplayRenderTheme, maxLines: number): string {
	const lines = diff.split("\n");
	const oldFileIsNull = lines.some((line) => line === "--- /dev/null");
	const newFileIsNull = lines.some((line) => line === "+++ /dev/null");
	const rendered: string[] = [];
	let oldLine = 1;
	let newLine = 1;

	for (const line of lines) {
		if (!line || line.startsWith("--- ") || line.startsWith("+++ ")) continue;
		const hunk = parseUnifiedDiffHunkHeader(line);
		if (hunk) {
			oldLine = hunk.oldLine;
			newLine = hunk.newLine;
			continue;
		}

		if (line.startsWith("+")) {
			if (newFileIsNull) continue;
			rendered.push(formatCursorReplayDiffLine("+", newLine, line.slice(1), theme));
			newLine += 1;
		} else if (line.startsWith("-")) {
			if (oldFileIsNull && line === "-") continue;
			rendered.push(formatCursorReplayDiffLine("-", oldLine, line.slice(1), theme));
			oldLine += 1;
		} else if (line.startsWith(" ")) {
			rendered.push(formatCursorReplayDiffLine(" ", newLine, line.slice(1), theme));
			oldLine += 1;
			newLine += 1;
		} else {
			rendered.push(theme.fg("toolDiffContext", replaceCursorReplayTabs(line)));
		}
	}

	const visible = rendered.slice(0, maxLines);
	if (rendered.length > maxLines) visible.push(theme.fg("muted", `... (${rendered.length - maxLines} more diff lines; expand for full diff)`));
	return visible.join("\n");
}

function stripCursorReplayHeader(text: string): string {
	const lines = text.trimEnd().split("\n");
	return lines.length > 2 && lines[1]?.trim() === "" ? lines.slice(2).join("\n") : lines.join("\n");
}

function formatMutedBlock(text: string, theme: CursorReplayRenderTheme): string {
	return text.split("\n").map((line) => theme.fg("muted", line)).join("\n");
}

function formatCursorReplayPreview(
	text: string,
	theme: CursorReplayRenderTheme,
	maxLines = CURSOR_REPLAY_COLLAPSED_PREVIEW_LINES,
	stripHeader = true,
): string | undefined {
	const body = (stripHeader ? stripCursorReplayHeader(text) : text).trimEnd();
	if (!body) return undefined;
	const lines = body.split("\n");
	const visible = lines.slice(0, maxLines);
	if (lines.length > maxLines) visible.push(`... (${lines.length - maxLines} more lines; expand for full details)`);
	return formatMutedBlock(visible.join("\n"), theme);
}

function safeHighlightCursorReplayCode(text: string, path: string | undefined): string[] | undefined {
	const lang = path ? getLanguageFromPath(path) : undefined;
	if (!lang) return undefined;
	try {
		return highlightCode(replaceCursorReplayTabs(text), lang);
	} catch {
		return undefined;
	}
}

function formatCursorReplayFilePreview(
	text: string,
	path: string | undefined,
	theme: CursorReplayRenderTheme,
	maxLines = CURSOR_REPLAY_COLLAPSED_PREVIEW_LINES,
	stripHeader = true,
): string | undefined {
	const body = (stripHeader ? stripCursorReplayHeader(text) : text).trimEnd();
	if (!body) return undefined;
	const rawLines = body.split("\n");
	const highlightedLines = safeHighlightCursorReplayCode(body, path);
	const renderedLines = highlightedLines ?? rawLines.map((line) => theme.fg("toolOutput", replaceCursorReplayTabs(line)));
	const visible = renderedLines.slice(0, maxLines);
	if (rawLines.length > maxLines) visible.push(theme.fg("muted", `... (${rawLines.length - maxLines} more lines; expand for full details)`));
	return visible.join("\n");
}

function getCursorReplayActivityTitle(toolName: CursorReplayToolName, args: Record<string, unknown> | undefined): string {
	if (toolName === CURSOR_REPLAY_ACTIVITY_TOOL_NAME && typeof args?.activityTitle === "string" && args.activityTitle.trim()) {
		return args.activityTitle.trim();
	}
	return getCursorReplayToolLabel(toolName);
}

function getCursorReplayCallSummary(toolName: CursorReplayToolName, args: Record<string, unknown> | undefined): string | undefined {
	const activitySummary = typeof args?.activitySummary === "string" && args.activitySummary.trim() ? args.activitySummary.trim() : undefined;
	if (toolName === CURSOR_REPLAY_ACTIVITY_TOOL_NAME && activitySummary) return activitySummary;

	const path = typeof args?.path === "string" ? args.path : undefined;
	const description = typeof args?.description === "string" ? args.description : undefined;
	const prompt = typeof args?.prompt === "string" ? args.prompt : undefined;
	const totalCount = typeof args?.totalCount === "number" ? args.totalCount : undefined;
	const diagnosticCount = typeof args?.diagnosticCount === "number" ? args.diagnosticCount : undefined;
	const paths = Array.isArray(args?.paths) ? args.paths.filter((entry): entry is string => typeof entry === "string") : [];

	if (toolName === "cursor_edit" || toolName === "cursor_write" || toolName === "cursor_delete") return path ?? "unknown";
	if (toolName === "cursor_read_lints") {
		const target = paths.length > 0 ? paths.join(" ") : path;
		if (target && diagnosticCount !== undefined) return `${target} · ${diagnosticCount} diagnostic${diagnosticCount === 1 ? "" : "s"}`;
		return target;
	}
	if (toolName === "cursor_update_todos" || toolName === "cursor_create_plan") {
		return totalCount !== undefined ? `${totalCount} item${totalCount === 1 ? "" : "s"}` : undefined;
	}
	if (toolName === "cursor_task") return description;
	if (toolName === "cursor_generate_image") return prompt;
	if (toolName === "cursor_mcp") return typeof args?.toolName === "string" ? args.toolName : undefined;
	if (toolName === CURSOR_REPLAY_ACTIVITY_TOOL_NAME) {
		if (typeof args?.path === "string") return args.path;
		if (typeof args?.toolName === "string") return args.toolName;
	}
	return undefined;
}

function renderCursorReplayCall(
	toolName: CursorReplayToolName,
	args: Record<string, unknown> | undefined,
	theme: CursorReplayRenderTheme,
	isPartial: boolean,
): Text {
	if (!isPartial) return new Text("", 0, 0);
	let text = theme.fg("toolTitle", theme.bold(`${getCursorReplayActivityTitle(toolName, args)} `));
	const summary = getCursorReplayCallSummary(toolName, args);
	if (summary) text += theme.fg("accent", summary);
	return new Text(text.trimEnd(), 0, 0);
}

function countDisplayLines(text: string): number {
	const withoutFinalNewline = text.endsWith("\n") ? text.slice(0, -1) : text;
	return withoutFinalNewline ? withoutFinalNewline.split("\n").length : 0;
}

function renderNativeLookingCursorFileMutationCall(
	toolName: "edit" | "write",
	args: Record<string, unknown> | undefined,
	theme: CursorReplayRenderTheme,
	isPartial: boolean,
): Text {
	if (!isPartial) return new Text("", 0, 0);
	let text = theme.fg("toolTitle", theme.bold(`${toolName} `));
	const path = typeof args?.path === "string" && args.path.trim() ? args.path : "unknown";
	text += theme.fg("accent", path);
	if (toolName === "write" && typeof args?.content === "string" && args.content.length > 0) {
		const lineCount = countDisplayLines(args.content);
		text += theme.fg("dim", ` (${pluralize(lineCount, "line")})`);
	}
	return new Text(text.trimEnd(), 0, 0);
}

function pluralize(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function getCursorEditDiff(details: CursorReplayToolDetails): string | undefined {
	return details.diffString ?? details.diff;
}

function hasCursorEditChanges(details: CursorReplayToolDetails): boolean {
	return Boolean(getCursorEditDiff(details)) || Boolean(details.linesAdded) || Boolean(details.linesRemoved);
}

function classifyCursorEditOperation(details: CursorReplayToolDetails): "created" | "deleted" | "updated" | "unchanged" {
	if (!hasCursorEditChanges(details)) return "unchanged";
	const diff = getCursorEditDiff(details);
	if (diff?.startsWith("--- /dev/null")) return "created";
	if (diff?.includes("\n+++ /dev/null")) return "deleted";
	return "updated";
}

function formatCursorEditSummary(details: CursorReplayToolDetails): string {
	const operation = classifyCursorEditOperation(details);
	if (operation === "unchanged") return "no changes needed";
	if (operation === "created" && details.linesAdded !== undefined) return `created ${pluralize(details.linesAdded, "line")}`;
	if (operation === "deleted" && details.linesRemoved !== undefined) return `deleted ${pluralize(details.linesRemoved, "line")}`;
	const parts = [
		details.linesAdded ? `added ${pluralize(details.linesAdded, "line")}` : undefined,
		details.linesRemoved ? `removed ${pluralize(details.linesRemoved, "line")}` : undefined,
	].filter((part): part is string => Boolean(part));
	return parts.length > 0 ? parts.join(", ") : "updated file";
}

function firstContentText(result: Parameters<CursorReplayRenderResult>[0]): string {
	const content = result.content[0];
	return content?.type === "text" ? content.text : "";
}

function renderExpandableCursorReplayResult(
	title: string,
	result: Parameters<CursorReplayRenderResult>[0],
	options: Parameters<CursorReplayRenderResult>[1],
	theme: Parameters<CursorReplayRenderResult>[2],
	context: Parameters<CursorReplayRenderResult>[3],
	isError: boolean,
): Component {
	const details = asCursorReplayToolDetails(result.details);
	const text = firstContentText(result);
	const summary = details?.summary ?? text.split("\n").find((line) => line.trim()) ?? "completed";
	let rendered = `${theme.fg("toolTitle", theme.bold(title))} ${theme.fg(isError ? "error" : "success", summary)}`;
	const expandedText = details?.expandedText ?? (text.includes("\n") ? text : undefined);
	if (expandedText) {
		const preview = options.expanded ? formatMutedBlock(expandedText, theme) : formatCursorReplayPreview(expandedText, theme);
		if (preview) rendered += `\n${preview}`;
	}
	if (details?.cursorToolName === "generateImage" && !isError && context.showImages) {
		const imageData = readImageFileForReplay(details.imagePath);
		const mimeType = details.imageMimeType ?? inferImageMimeTypeFromPath(details.imagePath);
		if (imageData && mimeType) return buildImageReplayComponent(rendered, imageData, mimeType, basename(details.imagePath ?? "generated-image"), theme);
	}
	return new Text(rendered, 0, 0);
}

function renderCursorGenerateImageResult(
	result: Parameters<CursorReplayRenderResult>[0],
	options: Parameters<CursorReplayRenderResult>[1],
	theme: Parameters<CursorReplayRenderResult>[2],
	context: Parameters<CursorReplayRenderResult>[3],
	isError: boolean,
): Component {
	return renderExpandableCursorReplayResult("Cursor generateImage", result, options, theme, context, isError);
}

function renderCursorReplayResult(
	result: Parameters<CursorReplayRenderResult>[0],
	options: Parameters<CursorReplayRenderResult>[1],
	theme: Parameters<CursorReplayRenderResult>[2],
	context: Parameters<CursorReplayRenderResult>[3],
	isError: boolean,
): Component {
	if (options.isPartial) return new Text(theme.fg("warning", "Replaying Cursor tool result..."), 0, 0);
	const details = asCursorReplayToolDetails(result.details);
	const text = firstContentText(result);
	if (isError && !details?.title) return new Text(theme.fg("error", text.split("\n")[0] || "Cursor replay failed"), 0, 0);

	if (details?.cursorToolName === "edit" && hasCursorEditChanges(details)) {
		const summary = formatCursorEditSummary(details);
		const title = details.title ?? "edit";
		let rendered = `${theme.fg("toolTitle", theme.bold(title))} ${theme.fg("accent", getCursorReplayPath(undefined, details))} ${theme.fg("success", summary)}`;
		const diff = getCursorEditDiff(details);
		if (diff) rendered += `\n${formatCursorReplayDiff(diff, theme, options.expanded ? 40 : CURSOR_REPLAY_COLLAPSED_PREVIEW_LINES)}`;
		return new Text(rendered, 0, 0);
	}

	if (details?.cursorToolName === "write") {
		const parts = [
			details.linesCreated !== undefined ? `${details.linesCreated} line${details.linesCreated === 1 ? "" : "s"}` : undefined,
			details.fileSize !== undefined ? `${details.fileSize} bytes` : undefined,
		].filter(Boolean);
		const summary = parts.length > 0 ? parts.join(", ") : "written";
		let rendered = `${theme.fg("toolTitle", theme.bold("write"))} ${theme.fg("accent", getCursorReplayPath(undefined, details))} ${theme.fg("success", summary)}`;
		const previewSource = details.fileContentAfterWrite ?? details.expandedText ?? text;
		const preview = formatCursorReplayFilePreview(
			previewSource,
			getCursorReplayPath(undefined, details),
			theme,
			CURSOR_REPLAY_COLLAPSED_PREVIEW_LINES,
			details.fileContentAfterWrite === undefined,
		);
		if (preview) rendered += `\n${preview}`;
		return new Text(rendered, 0, 0);
	}

	if (details?.cursorToolName === "generateImage") return renderCursorGenerateImageResult(result, options, theme, context, isError);
	if (details?.title) return renderExpandableCursorReplayResult(details.title, result, options, theme, context, isError);
	return new Text(text || theme.fg("success", "Cursor tool result replayed"), 0, 0);
}

function createCursorReplayOnlyToolDefinition(toolName: CursorReplayToolName): ToolDefinition<typeof cursorReplayToolSchema, unknown> {
	const cursorToolName = toolName === CURSOR_REPLAY_ACTIVITY_TOOL_NAME ? "activity" : getCursorReplaySourceToolName(toolName);
	const sideEffectDescription = toolName === "cursor_edit" || toolName === "cursor_write" || toolName === CURSOR_REPLAY_ACTIVITY_TOOL_NAME ? "file mutations" : "real tool work";
	return {
		name: toolName,
		label: getCursorReplayToolLabel(toolName),
		description: `Replay display for a Cursor SDK ${cursorToolName} operation. This tool only returns recorded Cursor results and never executes ${sideEffectDescription} directly.`,
		promptSnippet: `Render a recorded Cursor SDK ${cursorToolName} operation without executing ${sideEffectDescription}.`,
		promptGuidelines: [
			`Use this tool only for replaying Cursor SDK ${cursorToolName} results that were already produced by Cursor; it does not execute ${sideEffectDescription}.`,
		],
		parameters: cursorReplayToolSchema,
		async execute() {
			throw new Error(`No recorded Cursor ${cursorToolName} result was available. This replay-only tool does not execute ${sideEffectDescription}.`);
		},
		renderCall(args, theme, context) {
			return renderCursorReplayCall(toolName, args as Record<string, unknown>, theme, context.isPartial);
		},
		renderResult(result, options, theme, context) {
			return renderCursorReplayResult(result, options, theme, context, context.isError);
		},
	};
}

function createNativeCursorToolDefinition(toolName: NativeCursorToolName, cwd: string): ToolDefinition<TSchema, unknown, unknown> {
	if (toolName === "read") return createReadToolDefinition(cwd) as ToolDefinition<TSchema, unknown, unknown>;
	if (toolName === "bash") return createBashToolDefinition(cwd) as ToolDefinition<TSchema, unknown, unknown>;
	if (toolName === "edit") return createEditToolDefinition(cwd) as ToolDefinition<TSchema, unknown, unknown>;
	if (toolName === "write") return createWriteToolDefinition(cwd) as ToolDefinition<TSchema, unknown, unknown>;
	if (toolName === "grep") return createGrepToolDefinition(cwd) as ToolDefinition<TSchema, unknown, unknown>;
	if (toolName === "find") return createFindToolDefinition(cwd) as ToolDefinition<TSchema, unknown, unknown>;
	if (toolName === "ls") return createLsToolDefinition(cwd) as ToolDefinition<TSchema, unknown, unknown>;
	if (isCursorReplayToolName(toolName)) return createCursorReplayOnlyToolDefinition(toolName) as ToolDefinition<TSchema, unknown, unknown>;
	throw new Error(`Unsupported Cursor native replay tool: ${toolName}`);
}

function registerNativeCursorTool(pi: ExtensionAPI, toolName: NativeCursorToolName): void {
	const definition = createNativeCursorToolDefinition(toolName, getCursorSessionCwd());
	pi.registerTool(wrapNativeCursorTool(definition, () => createNativeCursorToolDefinition(toolName, getCursorSessionCwd())));
}

function hasNonBuiltinTool(pi: ExtensionAPI, toolName: NativeCursorToolName): boolean {
	const existingTool = pi.getAllTools().find((tool) => tool.name === toolName);
	return existingTool !== undefined && existingTool.sourceInfo.source !== "builtin";
}

type NativeRegistrationContext = { hasUI: boolean; ui: Pick<ExtensionContext["ui"], "notify">; model?: ExtensionContext["model"] };

function isCursorModel(model: ExtensionContext["model"]): boolean {
	return model?.provider === "cursor" || model?.api === "cursor-sdk";
}

function syncRegisteredNativeCursorToolsForModel(pi: ExtensionAPI, model: ExtensionContext["model"]): void {
	if (registeredNativeToolNames.size === 0) return;
	const activeToolNames = new Set(pi.getActiveTools());
	let changed = false;
	if (isCursorModel(model)) {
		for (const toolName of registeredNativeToolNames) {
			if (isCursorReplayToolName(toolName) && !CURSOR_MODEL_ACTIVE_REPLAY_TOOL_NAMES.some((activeReplayToolName) => activeReplayToolName === toolName)) continue;
			if (activeToolNames.has(toolName)) continue;
			activeToolNames.add(toolName);
			changed = true;
		}
	} else {
		for (const toolName of CURSOR_REPLAY_TOOL_NAMES) {
			if (!activeToolNames.delete(toolName)) continue;
			changed = true;
		}
	}
	if (changed) pi.setActiveTools([...activeToolNames]);
}

function registerAvailableNativeCursorTools(pi: ExtensionAPI, ctx: NativeRegistrationContext): void {
	if (!isCursorNativeToolRegistrationRequested()) {
		registeredNativeToolNames.clear();
		return;
	}

	const skippedToolNames: string[] = [];
	for (const toolName of NATIVE_CURSOR_TOOL_NAMES) {
		if (registeredNativeToolNames.has(toolName)) continue;
		if (hasNonBuiltinTool(pi, toolName)) {
			skippedToolNames.push(toolName);
			continue;
		}
		registerNativeCursorTool(pi, toolName);
		registeredNativeToolNames.add(toolName);
	}

	syncRegisteredNativeCursorToolsForModel(pi, ctx.model);

	if (skippedToolNames.length > 0 && readBooleanEnv(NATIVE_CURSOR_TOOL_DISPLAY_ENV) === true && ctx.hasUI) {
		ctx.ui.notify(
			`Cursor native tool replay skipped for ${skippedToolNames.join(", ")} because another extension already provides ${skippedToolNames.length === 1 ? "that tool" : "those tools"}. Cursor will use scrubbed activity transcripts for skipped tools.`,
			"warning",
		);
	}
}

export function registerCursorNativeToolDisplay(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		registerAvailableNativeCursorTools(pi, ctx);
	});
	pi.on("model_select", (event) => {
		syncRegisteredNativeCursorToolsForModel(pi, event.model);
	});
}
