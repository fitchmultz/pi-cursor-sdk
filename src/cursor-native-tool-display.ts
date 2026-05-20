import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import {
	createBashToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Image, Text, type Component } from "@earendil-works/pi-tui";
import { Type, type TSchema } from "typebox";
import { getCursorSessionCwd } from "./cursor-session-cwd.js";
import type { CursorPiToolDisplay } from "./cursor-tool-transcript.js";

const CURSOR_REPLAY_ONLY_TOOL_NAMES = [
	"cursor_edit",
	"cursor_write",
	"cursor_read_lints",
	"cursor_delete",
	"cursor_update_todos",
	"cursor_task",
	"cursor_create_plan",
	"cursor_generate_image",
	"cursor_mcp",
] as const;
type CursorReplayOnlyToolName = (typeof CURSOR_REPLAY_ONLY_TOOL_NAMES)[number];
const NATIVE_CURSOR_TOOL_NAMES = ["read", "bash", "grep", "find", "ls", ...CURSOR_REPLAY_ONLY_TOOL_NAMES] as const;
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

function isCursorReplayOnlyToolName(toolName: NativeCursorToolName): toolName is CursorReplayOnlyToolName {
	return CURSOR_REPLAY_ONLY_TOOL_NAMES.some((replayToolName) => replayToolName === toolName);
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
			return getCurrentDefinition().execute(toolCallId, params, signal, onUpdate, ctx);
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
	diffString?: string;
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

function getCursorReplaySourceToolName(toolName: CursorReplayOnlyToolName): string {
	switch (toolName) {
		case "cursor_edit":
			return "edit";
		case "cursor_write":
			return "write";
		case "cursor_read_lints":
			return "readLints";
		case "cursor_delete":
			return "delete";
		case "cursor_update_todos":
			return "updateTodos";
		case "cursor_task":
			return "task";
		case "cursor_create_plan":
			return "createPlan";
		case "cursor_generate_image":
			return "generateImage";
		case "cursor_mcp":
			return "mcp";
	}
}

function getCursorReplayToolLabel(toolName: CursorReplayOnlyToolName): string {
	return `Cursor ${getCursorReplaySourceToolName(toolName)}`;
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

function formatCursorReplayDiffLine(prefix: string, lineNumber: number, content: string, theme: CursorReplayRenderTheme): string {
	const rendered = `${prefix}${lineNumber} ${content}`;
	if (prefix === "+") return theme.fg("success", rendered);
	if (prefix === "-") return theme.fg("error", rendered);
	return theme.fg("muted", rendered);
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
			rendered.push(theme.fg("muted", line));
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

function formatCursorReplayPreview(text: string, theme: CursorReplayRenderTheme, maxLines = CURSOR_REPLAY_COLLAPSED_PREVIEW_LINES): string | undefined {
	const body = stripCursorReplayHeader(text).trimEnd();
	if (!body) return undefined;
	const lines = body.split("\n");
	const visible = lines.slice(0, maxLines);
	if (lines.length > maxLines) visible.push(`... (${lines.length - maxLines} more lines; expand for full details)`);
	return formatMutedBlock(visible.join("\n"), theme);
}

function getCursorReplayCallSummary(toolName: CursorReplayOnlyToolName, args: Record<string, unknown> | undefined): string | undefined {
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
	return undefined;
}

function renderCursorReplayCall(
	toolName: CursorReplayOnlyToolName,
	args: Record<string, unknown> | undefined,
	theme: CursorReplayRenderTheme,
	isPartial: boolean,
): Text {
	if (!isPartial) return new Text("", 0, 0);
	let text = theme.fg("toolTitle", theme.bold(`${getCursorReplayToolLabel(toolName)} `));
	const summary = getCursorReplayCallSummary(toolName, args);
	if (summary) text += theme.fg("accent", summary);
	return new Text(text.trimEnd(), 0, 0);
}

function pluralize(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function hasCursorEditChanges(details: CursorReplayToolDetails): boolean {
	return Boolean(details.diffString) || Boolean(details.linesAdded) || Boolean(details.linesRemoved);
}

function classifyCursorEditOperation(details: CursorReplayToolDetails): "created" | "deleted" | "updated" | "unchanged" {
	if (!hasCursorEditChanges(details)) return "unchanged";
	if (details.diffString?.startsWith("--- /dev/null")) return "created";
	if (details.diffString?.includes("\n+++ /dev/null")) return "deleted";
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

	if (details?.cursorToolName === "edit") {
		const summary = formatCursorEditSummary(details);
		let rendered = `${theme.fg("toolTitle", theme.bold(`Cursor ${classifyCursorEditOperation(details)}`))} ${theme.fg("accent", getCursorReplayPath(undefined, details))} ${theme.fg("success", summary)}`;
		if (details.diffString) rendered += `\n${formatCursorReplayDiff(details.diffString, theme, options.expanded ? 40 : CURSOR_REPLAY_COLLAPSED_PREVIEW_LINES)}`;
		return new Text(rendered, 0, 0);
	}

	if (details?.cursorToolName === "write") {
		const parts = [
			details.linesCreated !== undefined ? `${details.linesCreated} line${details.linesCreated === 1 ? "" : "s"}` : undefined,
			details.fileSize !== undefined ? `${details.fileSize} bytes` : undefined,
		].filter(Boolean);
		const summary = parts.length > 0 ? parts.join(", ") : "written";
		let rendered = `${theme.fg("toolTitle", theme.bold("Cursor write"))} ${theme.fg("accent", getCursorReplayPath(undefined, details))} ${theme.fg("success", summary)}`;
		const preview = formatCursorReplayPreview(details.expandedText ?? text, theme);
		if (preview) rendered += `\n${preview}`;
		return new Text(rendered, 0, 0);
	}

	if (details?.cursorToolName === "generateImage") return renderCursorGenerateImageResult(result, options, theme, context, isError);
	if (details?.title) return renderExpandableCursorReplayResult(details.title, result, options, theme, context, isError);
	return new Text(text || theme.fg("success", "Cursor tool result replayed"), 0, 0);
}

function createCursorReplayOnlyToolDefinition(toolName: CursorReplayOnlyToolName): ToolDefinition<typeof cursorReplayToolSchema, unknown> {
	const cursorToolName = getCursorReplaySourceToolName(toolName);
	const sideEffectDescription = toolName === "cursor_edit" || toolName === "cursor_write" ? "file mutations" : "real tool work";
	return {
		name: toolName,
		label: getCursorReplayToolLabel(toolName),
		description: `Replay display for a Cursor SDK ${cursorToolName} operation. This tool only returns recorded Cursor results and never executes ${sideEffectDescription} directly.`,
		promptSnippet: `Render a recorded Cursor SDK ${cursorToolName} operation without executing ${sideEffectDescription}.`,
		promptGuidelines: [
			`Use ${toolName} only for replaying Cursor SDK ${cursorToolName} results that were already produced by Cursor; ${toolName} does not execute ${sideEffectDescription}.`,
		],
		parameters: cursorReplayToolSchema,
		renderShell: "self",
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
	if (toolName === "grep") return createGrepToolDefinition(cwd) as ToolDefinition<TSchema, unknown, unknown>;
	if (toolName === "find") return createFindToolDefinition(cwd) as ToolDefinition<TSchema, unknown, unknown>;
	if (toolName === "ls") return createLsToolDefinition(cwd) as ToolDefinition<TSchema, unknown, unknown>;
	if (isCursorReplayOnlyToolName(toolName)) return createCursorReplayOnlyToolDefinition(toolName) as ToolDefinition<TSchema, unknown, unknown>;
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
			if (activeToolNames.has(toolName)) continue;
			activeToolNames.add(toolName);
			changed = true;
		}
	} else {
		for (const toolName of CURSOR_REPLAY_ONLY_TOOL_NAMES) {
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
