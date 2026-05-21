import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { CURSOR_REPLAY_ACTIVITY_TOOL_NAME, getCursorReplayDisplayLabel } from "./cursor-tool-names.js";

const DEFAULT_MAX_TRANSCRIPT_CHARS = 24000;
const DEFAULT_MAX_TRANSCRIPT_LINES = 800;
const DEFAULT_MAX_LIST_ITEMS = 200;
const DEFAULT_READ_TRANSCRIPT_CHARS = 4000;
const DEFAULT_READ_TRANSCRIPT_LINES = 12;
const DEFAULT_NATIVE_READ_DISPLAY_LINES = 20;
const LOCAL_READ_PREVIEW_NOTICE =
	"[local file preview at transcript time; Cursor read result content was unavailable]";

interface TranscriptOptions {
	maxChars?: number;
	maxLines?: number;
	maxListItems?: number;
	cwd?: string;
}

interface PiToolDisplayResult {
	content: Array<{ type: "text"; text: string }>;
	details?: unknown;
}

export interface CursorPiToolDisplay {
	toolName: string;
	args: Record<string, unknown>;
	result: PiToolDisplayResult;
	isError: boolean;
}

interface NormalizedResult {
	status: string | undefined;
	value: unknown;
	error: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function getString(record: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = record?.[key];
	return typeof value === "string" ? value : undefined;
}

function getNumber(record: Record<string, unknown> | undefined, key: string): number | undefined {
	const value = record?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getBoolean(record: Record<string, unknown> | undefined, key: string): boolean | undefined {
	const value = record?.[key];
	return typeof value === "boolean" ? value : undefined;
}

function getRecord(record: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
	return asRecord(record?.[key]);
}

function getArray(record: Record<string, unknown> | undefined, key: string): unknown[] | undefined {
	const value = record?.[key];
	return Array.isArray(value) ? value : undefined;
}

function getToolName(toolCall: unknown): string {
	const record = asRecord(toolCall);
	return getString(record, "name") ?? getString(record, "type") ?? getString(record, "toolName") ?? "unknown";
}

function getToolArgs(toolCall: unknown): Record<string, unknown> {
	const record = asRecord(toolCall);
	return getRecord(record, "args") ?? getRecord(record, "input") ?? {};
}

function getToolResult(toolCall: unknown): unknown {
	const record = asRecord(toolCall);
	return record?.result;
}

function normalizeToolName(name: string): string {
	const normalized = name.replace(/\s+/g, " ").trim();
	const normalizedKey = normalized.toLowerCase();
	switch (normalizedKey) {
		case "read_file":
			return "read";
		case "list_dir":
			return "ls";
		case "run_terminal_cmd":
		case "terminal":
		case "bash":
		case "shell":
			return "shell";
		case "grep_search":
		case "search":
			return "grep";
		case "file_search":
			return "glob";
		case "write_file":
		case "writefile":
			return "write";
		case "strreplace":
		case "str_replace":
		case "str-replace":
		case "edit_file":
		case "editfile":
		case "edit_notebook":
		case "editnotebook":
		case "notebook_edit":
		case "notebookedit":
			return "edit";
		default:
			return normalized || "unknown";
	}
}

function normalizeResult(result: unknown): NormalizedResult {
	const record = asRecord(result);
	const status = getString(record, "status");
	if (status === "success" || status === "error") {
		return { status, value: record?.value, error: record?.error };
	}
	return { status, value: result, error: undefined };
}

function stringifyUnknown(value: unknown): string {
	if (value === undefined) return "";
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}

function limitText(text: string, options: TranscriptOptions = {}, knownTotalLines?: number): string {
	const maxChars = options.maxChars ?? DEFAULT_MAX_TRANSCRIPT_CHARS;
	const maxLines = options.maxLines ?? DEFAULT_MAX_TRANSCRIPT_LINES;
	const lines = text.split("\n");
	let limitedLines = lines.slice(0, maxLines);
	let limited = limitedLines.join("\n");
	let truncatedLines = Math.max((knownTotalLines ?? lines.length) - limitedLines.length, 0);
	let truncatedChars = 0;

	if (limited.length > maxChars) {
		truncatedChars += limited.length - maxChars;
		limited = limited.slice(0, maxChars);
		limitedLines = limited.split("\n");
		truncatedLines = Math.max(truncatedLines, Math.max((knownTotalLines ?? lines.length) - limitedLines.length, 0));
	}
	if (text.length > limited.length) {
		truncatedChars += Math.max(text.length - limited.length - truncatedChars, 0);
	}

	const suffixParts: string[] = [];
	if (truncatedLines > 0) suffixParts.push(`${truncatedLines} more lines`);
	if (truncatedChars > 0 && truncatedLines === 0) suffixParts.push(`${truncatedChars} more chars`);
	return suffixParts.length > 0 ? `${limited}\n... (${suffixParts.join(", ")} truncated)` : limited;
}

function limitItems<T>(items: T[], options: TranscriptOptions = {}): { items: T[]; omitted: number } {
	const maxListItems = options.maxListItems ?? DEFAULT_MAX_LIST_ITEMS;
	return { items: items.slice(0, maxListItems), omitted: Math.max(items.length - maxListItems, 0) };
}

function joinSections(header: string, body?: string): string {
	const trimmedBody = body?.trimEnd();
	return trimmedBody ? `${header}\n\n${trimmedBody}\n` : `${header}\n`;
}

function formatError(error: unknown): string {
	const text = stringifyUnknown(error).trim();
	return text ? `Error: ${text}` : "Error";
}

function formatDisplayPath(path: string, cwd = process.cwd()): string {
	const trimmed = path.trim();
	if (!trimmed) return trimmed;
	if (!isAbsolute(trimmed)) return trimmed;
	const relativePath = relative(cwd, trimmed);
	if (!relativePath || relativePath === "") return ".";
	if (relativePath.startsWith("..") || isAbsolute(relativePath)) return trimmed;
	return relativePath;
}

function formatDiffPath(path: string, cwd = process.cwd()): string {
	if (path === "/dev/null") return path;
	return formatDisplayPath(path, cwd);
}

function formatDiffHeaderLine(line: string, options: TranscriptOptions): string {
	const match = /^(---|\+\+\+)\s+((?:[ab]\/)?)(.+)$/.exec(line);
	if (!match) return line;
	const [, marker, prefix, rawPath] = match;
	if (!prefix && rawPath !== "/dev/null") return line;
	const displayPath = formatDiffPath(rawPath, options.cwd);
	return `${marker} ${prefix}${displayPath}`;
}

function formatDiffString(diff: string | undefined, options: TranscriptOptions): string | undefined {
	return diff
		?.split("\n")
		.map((line) => formatDiffHeaderLine(line, options))
		.join("\n");
}

function resolveFilePath(path: string, cwd = process.cwd()): string {
	return isAbsolute(path) ? path : resolve(cwd, path);
}

function isPathWithinCwd(filePath: string, cwd = process.cwd()): boolean {
	const relativePath = relative(cwd, filePath);
	return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function isSensitivePreviewPath(filePath: string): boolean {
	const segments = filePath.split(/[\\/]+/).map((segment) => segment.toLowerCase());
	const basename = segments.at(-1) ?? "";
	return (
		segments.includes(".ssh") ||
		segments.includes("secrets") ||
		basename === ".env" ||
		basename.startsWith(".env.") ||
		basename === ".npmrc" ||
		basename === ".netrc" ||
		basename === "credentials" ||
		basename === "id_rsa" ||
		basename === "id_ed25519" ||
		/\.(?:pem|key|p12|pfx)$/i.test(basename)
	);
}

function readFilePreview(path: string, options: TranscriptOptions): string | undefined {
	const cwd = options.cwd ?? process.cwd();
	const filePath = resolveFilePath(path, cwd);

	const maxChars = options.maxChars ?? DEFAULT_READ_TRANSCRIPT_CHARS;
	const maxBytes = Math.max(8192, maxChars * 4);
	let fd: number | undefined;
	try {
		const realCwd = realpathSync(cwd);
		const realFilePath = realpathSync(filePath);
		if (!isPathWithinCwd(realFilePath, realCwd) || isSensitivePreviewPath(filePath) || isSensitivePreviewPath(realFilePath)) return undefined;

		const stat = statSync(realFilePath);
		if (!stat.isFile()) return undefined;
		fd = openSync(realFilePath, "r");
		const buffer = Buffer.alloc(Math.min(stat.size, maxBytes));
		const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
		const text = buffer.toString("utf8", 0, bytesRead);
		if (text.includes("\0")) return undefined;
		return text;
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function formatPathArg(args: Record<string, unknown>, options: TranscriptOptions, key = "path"): string | undefined {
	const path = args[key];
	return typeof path === "string" && path.trim() ? formatDisplayPath(path, options.cwd) : undefined;
}

function getReadContent(args: Record<string, unknown>, result: NormalizedResult, options: TranscriptOptions): string {
	const rawPath = typeof args.path === "string" ? args.path : undefined;
	const readOptions = {
		...options,
		maxChars: options.maxChars ?? DEFAULT_READ_TRANSCRIPT_CHARS,
		maxLines: options.maxLines ?? DEFAULT_READ_TRANSCRIPT_LINES,
	};
	const value = asRecord(result.value);
	const resultContent = getString(value, "content");
	if (resultContent && resultContent.length > 0) return resultContent;
	if (!rawPath) return stringifyUnknown(result.value);
	const localPreview = readFilePreview(rawPath, readOptions);
	return localPreview ? `${LOCAL_READ_PREVIEW_NOTICE}\n${localPreview}` : stringifyUnknown(result.value);
}

function formatRead(args: Record<string, unknown>, result: NormalizedResult, options: TranscriptOptions): string {
	const rawPath = typeof args.path === "string" ? args.path : undefined;
	const path = rawPath ? formatDisplayPath(rawPath, options.cwd) : "unknown";
	if (result.status === "error") return joinSections(`read ${path}`, formatError(result.error));

	const value = asRecord(result.value);
	const totalLines = getNumber(value, "totalLines");
	const readOptions = {
		...options,
		maxChars: options.maxChars ?? DEFAULT_READ_TRANSCRIPT_CHARS,
		maxLines: options.maxLines ?? DEFAULT_READ_TRANSCRIPT_LINES,
	};
	return joinSections(`read ${path}`, limitText(getReadContent(args, result, options), readOptions, totalLines));
}

function buildReadDisplayArgs(args: Record<string, unknown>, options: TranscriptOptions): Record<string, unknown> {
	const rawPath = typeof args.path === "string" ? args.path : undefined;
	return rawPath ? { ...args, path: formatDisplayPath(rawPath, options.cwd) } : args;
}

function buildPathDisplayArgs(args: Record<string, unknown>, options: TranscriptOptions): Record<string, unknown> {
	const rawPath = typeof args.path === "string" ? args.path : undefined;
	return rawPath ? { ...args, path: formatDisplayPath(rawPath, options.cwd) } : args;
}

function buildWriteDisplayArgs(args: Record<string, unknown>, options: TranscriptOptions): Record<string, unknown> {
	const displayArgs = buildPathDisplayArgs(args, options);
	const content = getCursorWriteArgContent(args);
	return content === undefined ? displayArgs : { ...displayArgs, content };
}

type NativeEditReplacement = { oldText: string; newText: string };
type NativeEditDisplayArgs = { path: string; edits: NativeEditReplacement[] };

const CURSOR_EDIT_PATH_KEYS = ["path", "filePath", "file_path"] as const;
const CURSOR_EDIT_OLD_TEXT_KEYS = ["oldText", "old_text", "oldString", "old_string", "oldStr", "old_str"] as const;
const CURSOR_EDIT_NEW_TEXT_KEYS = ["newText", "new_text", "newString", "new_string", "newStr", "new_str"] as const;
const CURSOR_NOTEBOOK_EDIT_ARG_KEYS = ["cellId", "cell_id", "cellIndex", "cell_index", "cellType", "cell_type", "notebookPath", "notebook_path"] as const;

function getFirstStringByKeys(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string") return value;
	}
	return undefined;
}

function getCursorEditPathArg(args: Record<string, unknown>): string | undefined {
	const path = getFirstStringByKeys(args, CURSOR_EDIT_PATH_KEYS);
	return path?.trim() ? path : undefined;
}

function isCursorNotebookEditToolName(toolName: string): boolean {
	const normalized = toolName.replace(/[\s_-]+/g, "").toLowerCase();
	return normalized === "editnotebook" || normalized === "notebookedit";
}

function isCursorStrReplaceToolName(toolName: string): boolean {
	const normalized = toolName.replace(/[\s_-]+/g, "").toLowerCase();
	return normalized === "strreplace";
}

function hasAnyKey(record: Record<string, unknown>, keys: readonly string[]): boolean {
	return keys.some((key) => record[key] !== undefined);
}

function isNotebookPath(path: string | undefined): boolean {
	return path?.toLowerCase().endsWith(".ipynb") === true;
}

function isCursorNotebookEditActivity(rawToolName: string, args: Record<string, unknown>): boolean {
	if (isCursorNotebookEditToolName(rawToolName)) return true;
	if (hasAnyKey(args, CURSOR_NOTEBOOK_EDIT_ARG_KEYS)) return true;
	return !isCursorStrReplaceToolName(rawToolName) && isNotebookPath(getCursorEditPathArg(args));
}

function asNativeEditReplacement(value: unknown): NativeEditReplacement | undefined {
	const record = asRecord(value);
	const oldText = record ? getFirstStringByKeys(record, CURSOR_EDIT_OLD_TEXT_KEYS) : undefined;
	const newText = record ? getFirstStringByKeys(record, CURSOR_EDIT_NEW_TEXT_KEYS) : undefined;
	if (typeof oldText !== "string" || oldText.length === 0 || typeof newText !== "string") return undefined;
	return { oldText, newText };
}

function getNativeEditReplacementsFromArgs(args: Record<string, unknown>): NativeEditReplacement[] | undefined {
	const edits = getArray(args, "edits")?.map(asNativeEditReplacement);
	if (edits && edits.length > 0 && edits.every((edit): edit is NativeEditReplacement => edit !== undefined)) return edits;

	const singleEdit = asNativeEditReplacement(args);
	return singleEdit ? [singleEdit] : undefined;
}

function buildNativeEditDisplayArgs(rawToolName: string, args: Record<string, unknown>, options: TranscriptOptions): NativeEditDisplayArgs | undefined {
	if (isCursorNotebookEditActivity(rawToolName, args)) return undefined;
	const rawPath = getCursorEditPathArg(args);
	const edits = getNativeEditReplacementsFromArgs(args);
	if (!rawPath || !edits) return undefined;
	return { path: formatDisplayPath(rawPath, options.cwd), edits };
}

function buildCursorEditActivityDisplayArgs(args: Record<string, unknown>, options: TranscriptOptions): Record<string, unknown> {
	const rawPath = getCursorEditPathArg(args);
	return rawPath ? { ...args, path: formatDisplayPath(rawPath, options.cwd) } : args;
}

function formatNativeReadDisplayContent(args: Record<string, unknown>, result: NormalizedResult, options: TranscriptOptions): string {
	const value = asRecord(result.value);
	const totalLines = getNumber(value, "totalLines");
	const readOptions = {
		...options,
		maxChars: options.maxChars ?? DEFAULT_READ_TRANSCRIPT_CHARS,
		maxLines: options.maxLines ?? DEFAULT_NATIVE_READ_DISPLAY_LINES,
	};
	const content = getReadContent(args, result, readOptions);
	if (totalLines === undefined) return limitText(content, readOptions);

	const maxLines = readOptions.maxLines ?? DEFAULT_NATIVE_READ_DISPLAY_LINES;
	const lines = content.split("\n");
	const visible = lines.slice(0, maxLines).join("\n");
	if (totalLines <= maxLines && lines.length <= maxLines) return visible;
	if (visible.length > (readOptions.maxChars ?? DEFAULT_READ_TRANSCRIPT_CHARS)) return limitText(content, readOptions, totalLines);
	return `${visible}\n\n[${Math.max(totalLines - maxLines, 0)} more lines in file. Use offset=${maxLines + 1} to continue.]`;
}

function getShellOutput(result: NormalizedResult, args: Record<string, unknown> = {}): { text: string; exitCode: number | undefined; timedOut: boolean } {
	const value = asRecord(result.value);
	const stdout = getString(value, "stdout") ?? "";
	const stderr = getString(value, "stderr") ?? "";
	const exitCode = getNumber(value, "exitCode");
	const timeoutMs = getNumber(args, "timeout");
	const executionTimeMs = getNumber(value, "executionTime");
	const timedOut = timeoutMs !== undefined && executionTimeMs !== undefined && executionTimeMs >= timeoutMs;
	const outputParts: string[] = [];
	if (stdout) outputParts.push(stdout.trimEnd());
	if (stderr) outputParts.push(stderr.trimEnd());
	if (exitCode !== undefined && exitCode !== 0) outputParts.push(`Command exited with code ${exitCode}`);
	if (timedOut) outputParts.push(`Command backgrounded after ${(timeoutMs / 1000).toFixed(0)} second timeout`);
	return { text: outputParts.filter(Boolean).join("\n\n") || "(no output)", exitCode, timedOut };
}

function buildShellDisplayArgs(args: Record<string, unknown>): Record<string, unknown> {
	const command = typeof args.command === "string" ? args.command : undefined;
	const timeoutMs = getNumber(args, "timeout");
	const displayArgs: Record<string, unknown> = command ? { command } : { ...args };
	if (timeoutMs !== undefined) {
		displayArgs.timeout = timeoutMs / 1000;
	}
	return displayArgs;
}

function formatShell(args: Record<string, unknown>, result: NormalizedResult, options: TranscriptOptions): string {
	const command = typeof args.command === "string" ? args.command : stringifyUnknown(args).trim();
	if (result.status === "error") return joinSections(`$ ${command || "shell"}`, formatError(result.error));

	const value = asRecord(result.value);
	const executionTime = getNumber(value, "executionTime");
	const outputParts = [getShellOutput(result, args).text];
	if (executionTime !== undefined) outputParts.push(`Took ${(executionTime / 1000).toFixed(1)}s`);
	return joinSections(`$ ${command || "shell"}`, limitText(outputParts.filter(Boolean).join("\n\n"), options));
}

function renderTreeNode(node: unknown, depth = 0, lines: string[] = []): string[] {
	const record = asRecord(node);
	if (!record) return lines;
	const name = getString(record, "name") ?? getString(record, "path") ?? getString(record, "relativePath") ?? "";
	const indent = "  ".repeat(depth);
	if (name) lines.push(`${indent}${name}`);
	const children = getArray(record, "children") ?? getArray(record, "entries") ?? getArray(record, "files") ?? [];
	for (const child of children) renderTreeNode(child, depth + 1, lines);
	return lines;
}

function getLsBody(result: NormalizedResult, options: TranscriptOptions): string {
	const value = asRecord(result.value);
	const root = value?.directoryTreeRoot ?? result.value;
	const treeLines = renderTreeNode(root);
	const body = treeLines.length > 0 ? treeLines.join("\n") : stringifyUnknown(result.value);
	return limitText(body, options);
}

function formatLs(args: Record<string, unknown>, result: NormalizedResult, options: TranscriptOptions): string {
	const path = formatPathArg(args, options) ?? ".";
	if (result.status === "error") return joinSections(`ls ${path}`, formatError(result.error));
	return joinSections(`ls ${path}`, getLsBody(result, options));
}

function formatGlob(args: Record<string, unknown>, result: NormalizedResult, options: TranscriptOptions): string {
	const header = `$ ${synthesizeGlobBashCommand(args, options)}`;
	if (result.status === "error") return joinSections(header, formatError(result.error));
	return joinSections(header, getGlobBody(result, options));
}

function formatSearchCount(totalMatches: number): string {
	return totalMatches === 1 ? "1 match" : `${totalMatches} matches`;
}

function formatSearchFile(file: string): string {
	return file.endsWith(":") ? file.slice(0, -1) : file;
}

function collectSearchResults(value: unknown): string[] {
	const record = asRecord(value);
	const outputs: unknown[] = [];
	const activeEditorResult = record?.activeEditorResult;
	if (activeEditorResult) outputs.push(activeEditorResult);
	const workspaceResults = asRecord(record?.workspaceResults);
	if (workspaceResults) outputs.push(...Object.values(workspaceResults));
	if (outputs.length === 0) outputs.push(value);

	const lines: string[] = [];
	let sawExplicitNoMatches = false;
	for (const outputValue of outputs) {
		const outputRecord = asRecord(outputValue);
		const type = getString(outputRecord, "type");
		const output = getRecord(outputRecord, "output");
		if (type === "content") {
			const matches = getArray(output, "matches") ?? [];
			if (matches.length === 0 && getNumber(output, "totalMatches") === 0) sawExplicitNoMatches = true;
			for (const match of matches) {
				const matchRecord = asRecord(match);
				const file = formatSearchFile(getString(matchRecord, "file") ?? "");
				const lineNumber = getNumber(matchRecord, "lineNumber");
				const line = getString(matchRecord, "line") ?? "";
				if (lineNumber === undefined && !line.trim()) {
					if (file) lines.push(file);
					continue;
				}
				const location = `${file}${lineNumber !== undefined ? `:${lineNumber}` : ""}`;
				lines.push(line ? `${location}: ${line}` : location);
			}
		} else if (type === "files") {
			const files = getArray(output, "files") ?? [];
			if (files.length === 0 && getNumber(output, "totalMatches") === 0) sawExplicitNoMatches = true;
			lines.push(...files.filter((entry): entry is string => typeof entry === "string").map(formatSearchFile));
		} else if (type === "count") {
			const counts = getArray(output, "counts") ?? [];
			if (counts.length === 0 && getNumber(output, "totalMatches") === 0) sawExplicitNoMatches = true;
			for (const count of counts) {
				const countRecord = asRecord(count);
				lines.push(`${getString(countRecord, "file") ?? ""}: ${getNumber(countRecord, "count") ?? 0}`.trim());
			}
		} else {
			const totalMatches = getNumber(outputRecord, "totalMatches");
			if (totalMatches !== undefined) {
				if (totalMatches === 0) {
					sawExplicitNoMatches = true;
					continue;
				}
				lines.push(formatSearchCount(totalMatches));
				continue;
			}
			lines.push(stringifyUnknown(outputValue));
		}
	}

	const topLevelTotalMatches = getNumber(record, "totalMatches");
	if (lines.length === 0 && topLevelTotalMatches !== undefined) {
		return topLevelTotalMatches === 0 ? ["(no matches)"] : [formatSearchCount(topLevelTotalMatches)];
	}
	if (lines.length === 0 && sawExplicitNoMatches) return ["(no matches)"];
	return lines.filter(Boolean);
}

function synthesizeGrepBashCommand(args: Record<string, unknown>, options: TranscriptOptions): string {
	const pattern = typeof args.pattern === "string" ? args.pattern : "";
	const path = typeof args.path === "string" ? formatDisplayPath(args.path, options.cwd) : undefined;
	const glob = typeof args.glob === "string" ? args.glob : undefined;
	return ["grep", pattern && JSON.stringify(pattern), path ?? glob].filter(Boolean).join(" ");
}

function buildGrepDisplayArgs(args: Record<string, unknown>, options: TranscriptOptions): Record<string, unknown> {
	const displayArgs: Record<string, unknown> = {};
	const pattern = typeof args.pattern === "string" ? args.pattern : undefined;
	const path = typeof args.path === "string" ? formatDisplayPath(args.path, options.cwd) : undefined;
	const glob = typeof args.glob === "string" ? args.glob : undefined;
	const ignoreCase = getBoolean(args, "caseInsensitive");
	const context = getNumber(args, "context") ?? getNumber(args, "contextBefore") ?? getNumber(args, "contextAfter");
	const limit = getNumber(args, "headLimit");
	if (pattern !== undefined) displayArgs.pattern = pattern;
	if (path !== undefined) displayArgs.path = path;
	if (glob !== undefined) displayArgs.glob = glob;
	if (ignoreCase !== undefined) displayArgs.ignoreCase = ignoreCase;
	if (context !== undefined) displayArgs.context = context;
	if (limit !== undefined) displayArgs.limit = limit;
	return Object.keys(displayArgs).length > 0 ? displayArgs : args;
}

function getGlobPattern(args: Record<string, unknown>): string {
	return typeof args.globPattern === "string" ? args.globPattern : typeof args.pattern === "string" ? args.pattern : "*";
}

function getGlobTargetDirectory(args: Record<string, unknown>, options: TranscriptOptions): string | undefined {
	const rawPath = typeof args.targetDirectory === "string" ? args.targetDirectory : typeof args.path === "string" ? args.path : undefined;
	return rawPath ? formatDisplayPath(rawPath, options.cwd) : undefined;
}

function synthesizeGlobBashCommand(args: Record<string, unknown>, options: TranscriptOptions): string {
	const pattern = getGlobPattern(args);
	const targetDirectory = getGlobTargetDirectory(args, options);
	return targetDirectory ? `glob ${pattern} in ${targetDirectory}` : `glob ${pattern}`;
}

function buildFindDisplayArgs(args: Record<string, unknown>, options: TranscriptOptions): Record<string, unknown> {
	const displayArgs: Record<string, unknown> = { pattern: getGlobPattern(args) };
	const targetDirectory = getGlobTargetDirectory(args, options);
	const limit = getNumber(args, "limit") ?? getNumber(args, "headLimit");
	if (targetDirectory !== undefined) displayArgs.path = targetDirectory;
	if (limit !== undefined) displayArgs.limit = limit;
	return displayArgs;
}

function getGrepBody(result: NormalizedResult, options: TranscriptOptions): string {
	const lines = collectSearchResults(result.value);
	const limited = limitItems(lines, options);
	const body = limited.omitted > 0 ? `${limited.items.join("\n")}\n... (${limited.omitted} more matches truncated)` : limited.items.join("\n");
	return limitText(body || stringifyUnknown(result.value), options);
}

function getGlobBody(result: NormalizedResult, options: TranscriptOptions): string {
	const value = asRecord(result.value);
	const files = getArray(value, "files")?.filter((entry): entry is string => typeof entry === "string") ?? [];
	if (files.length === 0) {
		const totalMatches = getNumber(value, "totalMatches");
		const totalFiles = getNumber(value, "totalFiles");
		if (totalMatches === 0 || totalFiles === 0) return "No files found matching pattern";
		return stringifyUnknown(result.value);
	}
	const limited = limitItems(files, options);
	const body = limited.omitted > 0 ? `${limited.items.join("\n")}\n... (${limited.omitted} more files truncated)` : limited.items.join("\n");
	return limitText(body, options);
}

function formatGrep(args: Record<string, unknown>, result: NormalizedResult, options: TranscriptOptions): string {
	const header = `$ ${synthesizeGrepBashCommand(args, options)}`;
	if (result.status === "error") return joinSections(header, formatError(result.error));
	return joinSections(header, getGrepBody(result, options));
}

function getCursorWriteArgContent(args: Record<string, unknown>): string | undefined {
	return getString(args, "content") ?? getString(args, "fileContent") ?? getString(args, "contents");
}

function getCursorWriteRecordedContent(args: Record<string, unknown>, resultValue: Record<string, unknown> | undefined): string | undefined {
	return getCursorWriteArgContent(args) ?? getString(resultValue, "fileContentAfterWrite");
}

function formatWrite(args: Record<string, unknown>, result: NormalizedResult, options: TranscriptOptions): string {
	const path = formatPathArg(args, options) ?? "unknown";
	if (result.status === "error") return joinSections(`write ${path}`, formatError(result.error));

	const value = asRecord(result.value);
	const linesCreated = getNumber(value, "linesCreated");
	const fileSize = getNumber(value, "fileSize");
	const fileContentAfterWrite = getCursorWriteRecordedContent(args, value);
	const parts = [
		linesCreated !== undefined ? `Created ${linesCreated} lines` : undefined,
		fileSize !== undefined ? `File size: ${fileSize} bytes` : undefined,
		fileContentAfterWrite ? limitText(fileContentAfterWrite, options) : undefined,
	].filter((part): part is string => Boolean(part));
	return joinSections(`write ${path}`, parts.join("\n\n") || stringifyUnknown(result.value));
}

function formatEdit(args: Record<string, unknown>, result: NormalizedResult, options: TranscriptOptions): string {
	const path = formatPathArg(args, options) ?? "unknown";
	if (result.status === "error") return joinSections(`edit ${path}`, formatError(result.error));

	const value = asRecord(result.value);
	const diff = formatDiffString(getString(value, "diffString") ?? getString(value, "diff") ?? getString(value, "unifiedDiff"), options);
	const linesAdded = getNumber(value, "linesAdded");
	const linesRemoved = getNumber(value, "linesRemoved");
	const stats = [
		linesAdded !== undefined ? `+${linesAdded}` : undefined,
		linesRemoved !== undefined ? `-${linesRemoved}` : undefined,
	].filter(Boolean).join(" ");
	const body = [stats, diff ? limitText(diff, options) : undefined].filter((part): part is string => Boolean(part)).join("\n\n");
	return joinSections(`edit ${path}`, body || stringifyUnknown(result.value));
}

function formatDelete(args: Record<string, unknown>, result: NormalizedResult, options: TranscriptOptions): string {
	const path = formatPathArg(args, options) ?? "unknown";
	if (result.status === "error") return joinSections(`delete ${path}`, formatError(result.error));
	const value = asRecord(result.value);
	const fileSize = getNumber(value, "fileSize");
	return joinSections(`delete ${path}`, fileSize !== undefined ? `Deleted ${fileSize} bytes` : stringifyUnknown(result.value));
}

function getReadLintPaths(args: Record<string, unknown>, result: NormalizedResult, options: TranscriptOptions): string[] {
	const explicitPaths = Array.isArray(args.paths)
		? args.paths.filter((entry): entry is string => typeof entry === "string")
		: typeof args.path === "string"
			? [args.path]
			: [];
	const resultPaths = (getArray(asRecord(result.value), "fileDiagnostics") ?? [])
		.map((file) => getString(asRecord(file), "path"))
		.filter((entry): entry is string => Boolean(entry));
	return [...new Set([...explicitPaths, ...resultPaths].map((entry) => formatDisplayPath(entry, options.cwd)))];
}

function getReadLintDiagnostics(result: NormalizedResult, options: TranscriptOptions): string[] {
	const value = asRecord(result.value);
	const files = getArray(value, "fileDiagnostics") ?? [];
	const lines: string[] = [];
	for (const file of files) {
		const fileRecord = asRecord(file);
		const pathValue = getString(fileRecord, "path");
		const path = pathValue ? formatDisplayPath(pathValue, options.cwd) : "unknown";
		const diagnostics = getArray(fileRecord, "diagnostics") ?? [];
		for (const diagnostic of diagnostics) {
			const diagnosticRecord = asRecord(diagnostic);
			const severity = getString(diagnosticRecord, "severity") ?? "diagnostic";
			const message = getString(diagnosticRecord, "message") ?? "";
			const source = getString(diagnosticRecord, "source");
			lines.push(`${path}: ${severity}${source ? ` ${source}` : ""}: ${message}`);
		}
	}
	return lines;
}

function formatReadLints(args: Record<string, unknown>, result: NormalizedResult, options: TranscriptOptions): string {
	const paths = getReadLintPaths(args, result, options);
	const header = `readLints${paths.length > 0 ? ` ${paths.join(" ")}` : ""}`;
	if (result.status === "error") return joinSections(header, formatError(result.error));

	const lines = getReadLintDiagnostics(result, options);
	if (lines.length === 0 && paths.length > 0) return joinSections(header, `No diagnostics in ${paths.join(", ")}`);
	return joinSections(header, limitText(lines.join("\n") || stringifyUnknown(result.value), options));
}

function getTodoItems(args: Record<string, unknown>, result: NormalizedResult): Array<{ content: string; status?: string }> {
	const value = asRecord(result.value);
	const rawTodos = getArray(value, "todos") ?? getArray(args, "todos") ?? [];
	const todos: Array<{ content: string; status?: string }> = [];
	for (const todo of rawTodos) {
		const record = asRecord(todo);
		const content = getString(record, "content");
		if (!content) continue;
		const status = getString(record, "status");
		todos.push(status ? { content, status } : { content });
	}
	return todos;
}

function getTodoTotalCount(args: Record<string, unknown>, result: NormalizedResult, todos: Array<{ content: string; status?: string }>): number {
	return getNumber(asRecord(result.value), "totalCount") ?? getNumber(args, "totalCount") ?? todos.length;
}

function summarizeTodos(args: Record<string, unknown>, result: NormalizedResult): string {
	const todos = getTodoItems(args, result);
	const total = getTodoTotalCount(args, result, todos);
	const completed = todos.filter((todo) => todo.status === "completed").length;
	const inProgress = todos.filter((todo) => todo.status === "inProgress").length;
	const pending = todos.filter((todo) => todo.status === "pending").length;
	const parts = [`${completed}/${total} completed`];
	if (inProgress > 0) parts.push(`${inProgress} in progress`);
	if (pending > 0) parts.push(`${pending} pending`);
	return parts.join(", ");
}

function formatTodoStatus(status: string | undefined): string {
	if (status === "completed") return "✓";
	if (status === "inProgress") return "…";
	if (status === "pending") return "○";
	return "•";
}

function formatTodos(args: Record<string, unknown>, result: NormalizedResult, options: TranscriptOptions, header: string): string {
	if (result.status === "error") return joinSections(header, formatError(result.error));
	const todos = getTodoItems(args, result);
	if (todos.length === 0) return joinSections(header, limitText(stringifyUnknown(result.value), options));
	const lines = todos.map((todo) => `${formatTodoStatus(todo.status)} ${todo.content}${todo.status ? ` (${todo.status})` : ""}`);
	return joinSections(header, limitText(lines.join("\n"), options));
}

export function getCursorCreatePlanText(toolCall: unknown): string | undefined {
	const name = normalizeToolName(getToolName(toolCall));
	if (name !== "createPlan") return undefined;
	const args = getToolArgs(toolCall);
	const result = normalizeResult(getToolResult(toolCall));
	const plan = getString(args, "plan") ?? getString(asRecord(result.value), "plan");
	const trimmed = plan?.trim();
	return trimmed || undefined;
}

function summarizePlan(args: Record<string, unknown>, result: NormalizedResult): string {
	const planText = getString(args, "plan") ?? getString(asRecord(result.value), "plan");
	const firstLine = planText ? firstNonEmptyLine(planText) : undefined;
	return firstLine ? truncateArg(firstLine, 160) : summarizeTodos(args, result);
}

function formatPlan(args: Record<string, unknown>, result: NormalizedResult, options: TranscriptOptions): string {
	if (result.status === "error") return joinSections("createPlan", formatError(result.error));
	const planText = getString(args, "plan") ?? getString(asRecord(result.value), "plan");
	if (planText?.trim()) return joinSections("createPlan", limitText(planText, options));
	return formatTodos(args, result, options, "createPlan");
}

function getTaskDescription(args: Record<string, unknown>, result: NormalizedResult): string {
	return getString(args, "description") ?? getString(asRecord(result.value), "description") ?? "task";
}

function getNestedRecord(record: Record<string, unknown> | undefined, ...keys: string[]): Record<string, unknown> | undefined {
	let current = record;
	for (const key of keys) {
		current = getRecord(current, key);
		if (!current) return undefined;
	}
	return current;
}

function collectTaskText(result: NormalizedResult): string {
	const value = asRecord(result.value);
	const success = getNestedRecord(value, "result", "success");
	const command = getString(success, "command");
	const stdout = getString(success, "stdout");
	const interleavedOutput = getString(success, "interleavedOutput");
	const assistantMessages = (getArray(value, "conversationSteps") ?? [])
		.map((step) => getString(getRecord(asRecord(step), "assistantMessage"), "text"))
		.filter((entry): entry is string => Boolean(entry));
	const parts = [command ? `$ ${command}` : undefined, stdout || interleavedOutput, ...assistantMessages].filter((part): part is string => Boolean(part));
	return parts.join("\n");
}

function formatTask(args: Record<string, unknown>, result: NormalizedResult, options: TranscriptOptions): string {
	const description = getTaskDescription(args, result);
	if (result.status === "error") return joinSections(`task ${description}`, formatError(result.error));
	const taskText = collectTaskText(result);
	return joinSections(`task ${description}`, limitText(taskText || stringifyUnknown(result.value), options));
}

function summarizeTask(description: string, taskText: string): string {
	const firstLine = firstNonEmptyLine(taskText);
	if (!firstLine) return truncateArg(description);
	if (description === "task" || description === firstLine) return truncateArg(firstLine);
	return truncateArg(`${description}: ${firstLine}`, 160);
}

function getGenerateImageValue(result: NormalizedResult): Record<string, unknown> | undefined {
	return asRecord(result.value);
}

function getGenerateImagePath(args: Record<string, unknown>, result: NormalizedResult): string | undefined {
	const value = getGenerateImageValue(result);
	return getString(value, "filePath") ?? getString(args, "filePath") ?? getString(args, "path");
}

function getGenerateImageDisplayPath(args: Record<string, unknown>, result: NormalizedResult, options: TranscriptOptions): string | undefined {
	const path = getGenerateImagePath(args, result);
	return path ? formatDisplayPath(path, options.cwd) : undefined;
}

function inferImageMimeType(path: string | undefined): string | undefined {
	const lower = path?.toLowerCase();
	if (!lower) return undefined;
	if (lower.endsWith(".png")) return "image/png";
	if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
	if (lower.endsWith(".gif")) return "image/gif";
	if (lower.endsWith(".webp")) return "image/webp";
	return undefined;
}

function formatGenerateImage(args: Record<string, unknown>, result: NormalizedResult, options: TranscriptOptions): string {
	const prompt = getString(args, "prompt") ?? getString(args, "description") ?? "image";
	if (result.status === "error") return joinSections(`generateImage ${prompt}`, formatError(result.error));
	const value = getGenerateImageValue(result);
	const displayPath = getGenerateImageDisplayPath(args, result, options);
	const hasImageData = typeof value?.imageData === "string" && value.imageData.length > 0;
	const lines = [displayPath ? `Saved image: ${displayPath}` : undefined, hasImageData ? "Image data returned by Cursor SDK." : undefined].filter(
		(line): line is string => Boolean(line),
	);
	if (lines.length > 0) return joinSections(`generateImage ${prompt}`, lines.join("\n"));
	return joinSections(`generateImage ${prompt}`, limitText(stringifyUnknown(result.value), options));
}

function getMcpContentText(entry: unknown): string | undefined {
	const record = asRecord(entry);
	const directText = getString(record, "text");
	if (directText) return directText;
	const nestedText = getRecord(record, "text");
	return getString(nestedText, "text");
}

function formatMcp(args: Record<string, unknown>, result: NormalizedResult, options: TranscriptOptions): string {
	const toolName = typeof args.toolName === "string" ? args.toolName : "mcp";
	if (result.status === "error") return joinSections(toolName, formatError(result.error));

	const value = asRecord(result.value);
	const isError = getBoolean(value, "isError");
	const content = getArray(value, "content") ?? [];
	const text = content
		.map((entry) => getMcpContentText(entry))
		.filter((entry): entry is string => Boolean(entry))
		.join("\n");
	const body = `${isError ? "[tool error]\n" : ""}${text || stringifyUnknown(result.value)}`;
	return joinSections(toolName, limitText(body, options));
}

function formatFallback(name: string, args: Record<string, unknown>, result: NormalizedResult, options: TranscriptOptions): string {
	const header = name === "unknown" ? "Cursor tool" : name;
	if (result.status === "error") return joinSections(header, formatError(result.error));
	const argsText = Object.keys(args).length > 0 ? `${stringifyUnknown(args)}\n\n` : "";
	return joinSections(header, limitText(`${argsText}${stringifyUnknown(result.value)}`.trim(), options));
}

export function formatCursorToolTranscript(toolCall: unknown, options: TranscriptOptions = {}): string {
	const name = normalizeToolName(getToolName(toolCall));
	const args = getToolArgs(toolCall);
	const result = normalizeResult(getToolResult(toolCall));

	switch (name) {
		case "read":
			return formatRead(args, result, options);
		case "shell":
			return formatShell(args, result, options);
		case "ls":
			return formatLs(args, result, options);
		case "glob":
			return formatGlob(args, result, options);
		case "grep":
			return formatGrep(args, result, options);
		case "write":
			return formatWrite(args, result, options);
		case "edit":
			return formatEdit(args, result, options);
		case "delete":
			return formatDelete(args, result, options);
		case "readLints":
			return formatReadLints(args, result, options);
		case "updateTodos":
			return formatTodos(args, result, options, "updateTodos");
		case "createPlan":
			return formatPlan(args, result, options);
		case "task":
			return formatTask(args, result, options);
		case "generateImage":
			return formatGenerateImage(args, result, options);
		case "mcp":
			return formatMcp(args, result, options);
		default:
			return formatFallback(name, args, result, options);
	}
}

function textToolResult(text: string, details?: unknown): PiToolDisplayResult {
	return { content: [{ type: "text", text }], details };
}

function buildGenericPiToolDisplay(name: string, args: Record<string, unknown>, result: NormalizedResult, options: TranscriptOptions): CursorPiToolDisplay {
	const isError = result.status === "error";
	return {
		toolName: name,
		args,
		result: textToolResult(isError ? formatError(result.error) : limitText(stringifyUnknown(result.value), options)),
		isError,
	};
}

function firstNonEmptyLine(text: string): string | undefined {
	return text.split("\n").find((line) => line.trim())?.trim();
}

function buildReplaySummaryDisplay(
	toolName: string,
	args: Record<string, unknown>,
	result: NormalizedResult,
	contentText: string,
	details: Record<string, unknown>,
): CursorPiToolDisplay {
	const isError = result.status === "error";
	const summary = isError ? formatError(result.error) : firstNonEmptyLine(contentText);
	return {
		toolName,
		args,
		result: textToolResult(contentText, {
			...details,
			summary: details.summary ?? summary,
			expandedText: details.expandedText ?? contentText,
		}),
		isError,
	};
}

function truncateArg(value: string, maxLength = 120): string {
	return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
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

export function buildCursorPiToolDisplay(toolCall: unknown, options: TranscriptOptions = {}): CursorPiToolDisplay {
	const rawName = getToolName(toolCall);
	const name = normalizeToolName(rawName);
	const args = getToolArgs(toolCall);
	const result = normalizeResult(getToolResult(toolCall));

	if (name === "read") {
		const isError = result.status === "error";
		return {
			toolName: "read",
			args: buildReadDisplayArgs(args, options),
			result: textToolResult(isError ? formatError(result.error) : formatNativeReadDisplayContent(args, result, options)),
			isError,
		};
	}

	if (name === "shell") {
		const shellOutput = getShellOutput(result, args);
		const isError = result.status === "error" || shellOutput.timedOut || (shellOutput.exitCode !== undefined && shellOutput.exitCode !== 0);
		return {
			toolName: "bash",
			args: buildShellDisplayArgs(args),
			result: textToolResult(result.status === "error" ? formatError(result.error) : limitText(shellOutput.text, options)),
			isError,
		};
	}

	if (name === "grep") {
		const isError = result.status === "error";
		const outputText = isError ? formatError(result.error) : getGrepBody(result, options);
		return {
			toolName: "grep",
			args: buildGrepDisplayArgs(args, options),
			result: textToolResult(outputText),
			isError,
		};
	}

	if (name === "glob") {
		const isError = result.status === "error";
		return {
			toolName: "find",
			args: buildFindDisplayArgs(args, options),
			result: textToolResult(isError ? formatError(result.error) : getGlobBody(result, options)),
			isError,
		};
	}

	if (name === "ls") {
		return {
			toolName: "ls",
			args,
			result: textToolResult(result.status === "error" ? formatError(result.error) : getLsBody(result, options).trim()),
			isError: result.status === "error",
		};
	}

	if (name === "edit") {
		const value = asRecord(result.value);
		const rawDiff = getString(value, "diffString") ?? getString(value, "diff") ?? getString(value, "unifiedDiff");
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

	if (name === "write") {
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

	if (name === "delete") {
		const value = asRecord(result.value);
		const displayPath = typeof args.path === "string" ? formatDisplayPath(args.path, options.cwd) : undefined;
		const activityTitle = getCursorReplayDisplayLabel("cursor_delete");
		const contentText = formatDelete(args, result, options).trimEnd();
		return buildReplaySummaryDisplay(
			CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
			buildCursorActivityDisplayArgs(displayPath ? { path: displayPath } : {}, activityTitle, displayPath ?? "file"),
			result,
			contentText,
			{
				cursorToolName: "delete",
				title: activityTitle,
				path: displayPath,
				summary: result.status === "error" ? undefined : displayPath ? `deleted ${displayPath}` : "deleted file",
				fileSize: getNumber(value, "fileSize"),
			},
		);
	}

	if (name === "readLints") {
		const paths = getReadLintPaths(args, result, options);
		const diagnosticCount = getReadLintDiagnostics(result, options).length;
		const activityTitle = getCursorReplayDisplayLabel("cursor_read_lints");
		const diagnosticSummary = `${diagnosticCount} diagnostic${diagnosticCount === 1 ? "" : "s"}${paths.length > 0 ? ` in ${paths.join(", ")}` : ""}`;
		const contentText = formatReadLints(args, result, options).trimEnd();
		return buildReplaySummaryDisplay(
			CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
			buildCursorActivityDisplayArgs({ paths, diagnosticCount }, activityTitle, diagnosticSummary),
			result,
			contentText,
			{
				cursorToolName: "readLints",
				title: activityTitle,
				summary: result.status === "error" ? undefined : diagnosticSummary,
			},
		);
	}

	if (name === "updateTodos") {
		const todos = getTodoItems(args, result);
		const totalCount = getTodoTotalCount(args, result, todos);
		const activityTitle = getCursorReplayDisplayLabel("cursor_update_todos");
		const todoSummary = summarizeTodos(args, result);
		const contentText = formatTodos(args, result, options, "updateTodos").trimEnd();
		return buildReplaySummaryDisplay(
			CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
			buildCursorActivityDisplayArgs({ totalCount }, activityTitle, todoSummary),
			result,
			contentText,
			{
				cursorToolName: "updateTodos",
				title: activityTitle,
				summary: result.status === "error" ? undefined : todoSummary,
			},
		);
	}

	if (name === "createPlan") {
		const todos = getTodoItems(args, result);
		const totalCount = getTodoTotalCount(args, result, todos);
		const activityTitle = getCursorReplayDisplayLabel("cursor_create_plan");
		const planSummary = summarizePlan(args, result);
		const contentText = formatPlan(args, result, options).trimEnd();
		return buildReplaySummaryDisplay(
			CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
			buildCursorActivityDisplayArgs({ totalCount }, activityTitle, planSummary),
			result,
			contentText,
			{
				cursorToolName: "createPlan",
				title: activityTitle,
				summary: result.status === "error" ? undefined : planSummary,
			},
		);
	}

	if (name === "task") {
		const description = getTaskDescription(args, result);
		const contentText = formatTask(args, result, options).trimEnd();
		const taskText = collectTaskText(result);
		const activityTitle = getCursorReplayDisplayLabel("cursor_task");
		const taskSummary = summarizeTask(description, taskText);
		return buildReplaySummaryDisplay(
			CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
			buildCursorActivityDisplayArgs({ description: truncateArg(description) }, activityTitle, taskSummary),
			result,
			contentText,
			{
				cursorToolName: "task",
				title: activityTitle,
				summary: result.status === "error" ? undefined : taskSummary,
			},
		);
	}

	if (name === "generateImage") {
		const prompt = getString(args, "prompt") ?? getString(args, "description") ?? "image";
		const contentText = formatGenerateImage(args, result, options).trimEnd();
		const imagePath = getGenerateImagePath(args, result);
		const imageDisplayPath = getGenerateImageDisplayPath(args, result, options);
		const activityTitle = getCursorReplayDisplayLabel("cursor_generate_image");
		return buildReplaySummaryDisplay(
			CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
			buildCursorActivityDisplayArgs({ prompt: truncateArg(prompt) }, activityTitle, imageDisplayPath ?? truncateArg(prompt)),
			result,
			contentText,
			{
				cursorToolName: "generateImage",
				title: activityTitle,
				summary: result.status === "error" ? undefined : imageDisplayPath ? `saved ${imageDisplayPath}` : "image generated",
				imagePath,
				imageDisplayPath,
				imageMimeType: inferImageMimeType(imagePath),
			},
		);
	}

	if (name === "mcp") {
		const toolName = getString(args, "toolName") ?? "mcp";
		const activityTitle = getCursorReplayDisplayLabel("cursor_mcp");
		const contentText = formatMcp(args, result, options).trimEnd();
		return buildReplaySummaryDisplay(
			CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
			buildCursorActivityDisplayArgs({ toolName: truncateArg(toolName) }, activityTitle, truncateArg(toolName)),
			result,
			contentText,
			{
				cursorToolName: "mcp",
				title: activityTitle,
				summary: result.status === "error" ? undefined : firstNonEmptyLine(contentText) ?? "MCP result captured",
			},
		);
	}

	return buildGenericPiToolDisplay(name, args, result, options);
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
