import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { getLanguageFromPath, highlightCode, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Image, Text, type Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { resolveCursorEditDiff } from "./cursor-edit-diff.js";
import {
	CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
	getCursorReplayDisplayLabel,
	getCursorReplaySourceToolName,
	type CursorReplayToolName,
} from "./cursor-tool-names.js";

export const CURSOR_REPLAY_COLLAPSED_PREVIEW_LINES = 8;
export const CURSOR_REPLAY_PREVIEW_MAX_CHARS = 4000;
export const CURSOR_REPLAY_PREVIEW_MAX_LINE_CHARS = 240;
const CURSOR_REPLAY_HIGHLIGHT_MAX_CHARS = 12000;
export const cursorReplayToolSchema = Type.Object({}, { additionalProperties: true });

export interface CursorReplayToolDetails {
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

export function asCursorReplayToolDetails(value: unknown): CursorReplayToolDetails | undefined {
	return value && typeof value === "object" ? (value as CursorReplayToolDetails) : undefined;
}

type CursorReplayRenderCall = NonNullable<ToolDefinition<typeof cursorReplayToolSchema, unknown>["renderCall"]>;
type CursorReplayRenderResult = NonNullable<ToolDefinition<typeof cursorReplayToolSchema, unknown>["renderResult"]>;
export type CursorReplayRenderTheme = Parameters<CursorReplayRenderCall>[1];

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

export function getCursorReplayPath(args: Record<string, unknown> | undefined, details: CursorReplayToolDetails | undefined): string {
	const argPath = args?.path;
	return details?.path ?? (typeof argPath === "string" && argPath.trim() ? argPath : "unknown");
}

function parseUnifiedDiffHunkHeader(line: string): { oldLine: number; newLine: number } | undefined {
	const match = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(line);
	if (!match) return undefined;
	return { oldLine: Number(match[1]), newLine: Number(match[2]) };
}

function replaceCursorReplayTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

function truncateCursorReplayLine(text: string, maxChars = CURSOR_REPLAY_PREVIEW_MAX_LINE_CHARS): string {
	return text.length > maxChars ? `${text.slice(0, Math.max(maxChars - 1, 0))}…` : text;
}

interface CursorReplayPreviewSlice {
	text: string;
	omittedLines: number;
	omittedChars: number;
}

function sliceCursorReplayPreview(
	text: string,
	maxLines: number,
	maxChars = CURSOR_REPLAY_PREVIEW_MAX_CHARS,
): CursorReplayPreviewSlice {
	const lines = text.split("\n");
	const visible: string[] = [];
	let usedChars = 0;
	let omittedChars = 0;
	for (const line of lines) {
		if (visible.length >= maxLines) {
			omittedChars += line.length + 1;
			continue;
		}
		const normalizedLine = replaceCursorReplayTabs(line);
		const lineBudget = Math.max(Math.min(CURSOR_REPLAY_PREVIEW_MAX_LINE_CHARS, maxChars - usedChars), 0);
		if (lineBudget <= 0) {
			omittedChars += normalizedLine.length + 1;
			continue;
		}
		const truncatedLine = truncateCursorReplayLine(normalizedLine, lineBudget);
		visible.push(truncatedLine);
		usedChars += truncatedLine.length + 1;
		omittedChars += Math.max(normalizedLine.length - truncatedLine.length, 0);
	}
	return {
		text: visible.join("\n"),
		omittedLines: Math.max(lines.length - visible.length, 0),
		omittedChars,
	};
}

function formatCursorReplayOmission(slice: CursorReplayPreviewSlice): string | undefined {
	const parts = [];
	if (slice.omittedLines > 0) parts.push(`${slice.omittedLines} more lines`);
	if (slice.omittedChars > 0) parts.push(`${slice.omittedChars} more chars`);
	return parts.length > 0 ? `... (${parts.join(", ")} truncated)` : undefined;
}

function formatCursorReplayDiffLine(prefix: string, lineNumber: number, content: string, theme: CursorReplayRenderTheme): string {
	const rendered = `${prefix}${lineNumber} ${truncateCursorReplayLine(replaceCursorReplayTabs(content))}`;
	if (prefix === "+") return theme.fg("toolDiffAdded", rendered);
	if (prefix === "-") return theme.fg("toolDiffRemoved", rendered);
	return theme.fg("toolDiffContext", rendered);
}

export function formatCursorReplayDiff(diff: string, theme: CursorReplayRenderTheme, maxLines: number): string {
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
	if (rendered.length > maxLines) visible.push(theme.fg("muted", `... (${rendered.length - maxLines} more diff lines hidden)`));
	return visible.join("\n");
}

function stripCursorReplayHeader(text: string): string {
	const lines = text.trimEnd().split("\n");
	return lines.length > 2 && lines[1]?.trim() === "" ? lines.slice(2).join("\n") : lines.join("\n");
}

function formatMutedBlock(text: string, theme: CursorReplayRenderTheme): string {
	return text.split("\n").map((line) => theme.fg("muted", line)).join("\n");
}

export function formatCursorReplayPreview(
	text: string,
	theme: CursorReplayRenderTheme,
	maxLines = CURSOR_REPLAY_COLLAPSED_PREVIEW_LINES,
	stripHeader = true,
): string | undefined {
	const body = (stripHeader ? stripCursorReplayHeader(text) : text).trimEnd();
	if (!body) return undefined;
	const slice = sliceCursorReplayPreview(body, maxLines);
	const omission = formatCursorReplayOmission(slice);
	const preview = omission ? `${slice.text}\n${omission}` : slice.text;
	return formatMutedBlock(preview, theme);
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

export function formatCursorReplayFilePreview(
	text: string,
	path: string | undefined,
	theme: CursorReplayRenderTheme,
	maxLines = CURSOR_REPLAY_COLLAPSED_PREVIEW_LINES,
	stripHeader = true,
): string | undefined {
	const body = (stripHeader ? stripCursorReplayHeader(text) : text).trimEnd();
	if (!body) return undefined;
	const slice = sliceCursorReplayPreview(body, maxLines);
	const highlightedLines = slice.text.length <= CURSOR_REPLAY_HIGHLIGHT_MAX_CHARS ? safeHighlightCursorReplayCode(slice.text, path) : undefined;
	const renderedLines = highlightedLines ?? slice.text.split("\n").map((line) => theme.fg("toolOutput", line));
	const omission = formatCursorReplayOmission(slice);
	if (omission) renderedLines.push(theme.fg("muted", omission));
	return renderedLines.join("\n");
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
	if (toolName === "cursor_sem_search") return typeof args?.query === "string" ? args.query : undefined;
	if (toolName === "cursor_record_screen") {
		if (typeof args?.path === "string") return args.path;
		if (typeof args?.mode === "string") return args.mode;
	}
	if (toolName === CURSOR_REPLAY_ACTIVITY_TOOL_NAME) {
		if (typeof args?.path === "string") return args.path;
		if (typeof args?.toolName === "string") return args.toolName;
	}
	return undefined;
}

export function renderCursorReplayCall(
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

export function renderNativeLookingCursorFileMutationCall(
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
	return resolveCursorEditDiff(details);
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

export function renderCursorReplayResult(
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

export function createCursorReplayOnlyToolDefinition(toolName: CursorReplayToolName): ToolDefinition<typeof cursorReplayToolSchema, unknown> {
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
