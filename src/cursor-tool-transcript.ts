import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";

const DEFAULT_MAX_TRANSCRIPT_CHARS = 24000;
const DEFAULT_MAX_TRANSCRIPT_LINES = 800;
const DEFAULT_MAX_LIST_ITEMS = 200;
const DEFAULT_READ_TRANSCRIPT_CHARS = 4000;
const DEFAULT_READ_TRANSCRIPT_LINES = 12;
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
	switch (normalized) {
		case "read_file":
			return "read";
		case "list_dir":
			return "ls";
		case "run_terminal_cmd":
		case "terminal":
		case "bash":
			return "shell";
		case "grep_search":
		case "search":
			return "grep";
		case "file_search":
		case "glob_file_search":
			return "glob";
		case "codebase_search":
		case "semantic_search":
		case "ripgrep":
			return "grep";
		case "web_search":
		case "run_terminal_command":
			return "shell";
		case "apply_patch":
		case "search_replace":
			return "edit";
		default:
			return normalized || "unknown";
	}
}

/** Pi tool name used for native replay registration and TUI cards. */
export function resolveCursorReplayPiToolName(normalizedName: string): string {
	switch (normalizedName) {
		case "read":
			return "read";
		case "shell":
			return "bash";
		case "ls":
			return "ls";
		case "grep":
			return "grep";
		case "glob":
			return "find";
		case "edit":
			return "cursor_edit";
		case "write":
			return "cursor_write";
		case "delete":
			return "cursor_delete";
		case "readLints":
			return "cursor_read_lints";
		case "mcp":
			return "cursor_mcp";
		default:
			return "cursor_tool";
	}
}

export interface CursorReplayToolDetails {
	cursorToolName: string;
	path?: string;
	mcpToolName?: string;
	linesAdded?: number;
	linesRemoved?: number;
	linesCreated?: number;
	fileSize?: number;
	diffString?: string;
}

function withCursorToolLabel(args: Record<string, unknown>, normalizedName: string): Record<string, unknown> {
	return { ...args, __cursorToolLabel: normalizedName };
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

function normalizeBashCommandForDisplay(command: string, cwd = process.cwd()): string {
	const absCwd = resolve(cwd);
	const cwdPrefix = absCwd.endsWith("/") ? absCwd : `${absCwd}/`;
	let normalized = command;
	if (normalized.includes(cwdPrefix)) {
		normalized = normalized.split(cwdPrefix).join("");
	}
	if (normalized.includes(absCwd)) {
		normalized = normalized.replaceAll(absCwd, ".");
	}
	return normalized.replace(/\s+/g, " ").trim();
}

function normalizeReadDisplayArgs(args: Record<string, unknown>, options: TranscriptOptions = {}): Record<string, unknown> {
	const path = args.path;
	if (typeof path !== "string") return args;
	return { ...args, path: formatDisplayPath(path, options.cwd) };
}

function normalizeLsDisplayArgs(args: Record<string, unknown>, options: TranscriptOptions = {}): Record<string, unknown> {
	const path = args.path ?? args.target_directory;
	if (typeof path !== "string") return args;
	const displayPath = formatDisplayPath(path, options.cwd);
	if (args.path !== undefined) return { ...args, path: displayPath };
	return { ...args, target_directory: displayPath };
}

function normalizeBashDisplayArgs(args: Record<string, unknown>, options: TranscriptOptions = {}): Record<string, unknown> {
	const { timeout: _timeout, ...rest } = args;
	const command = rest.command;
	if (typeof command !== "string") return rest;
	return { ...rest, command: normalizeBashCommandForDisplay(command, options.cwd) };
}

function normalizeGrepDisplayArgs(args: Record<string, unknown>, options: TranscriptOptions = {}): Record<string, unknown> {
	const normalized = { ...args };
	if (typeof normalized.path === "string") normalized.path = formatDisplayPath(normalized.path, options.cwd);
	return normalized;
}

function mapGlobArgsToFindArgs(args: Record<string, unknown>, options: TranscriptOptions = {}): Record<string, unknown> {
	const pattern =
		typeof args.globPattern === "string" ? args.globPattern : typeof args.pattern === "string" ? args.pattern : "*";
	const searchPath =
		typeof args.targetDirectory === "string"
			? formatDisplayPath(args.targetDirectory, options.cwd)
			: typeof args.path === "string"
				? formatDisplayPath(args.path, options.cwd)
				: ".";
	return { pattern, path: searchPath, limit: args.limit };
}

function normalizeEditWriteDisplayArgs(args: Record<string, unknown>, options: TranscriptOptions = {}): Record<string, unknown> {
	const path = args.path;
	if (typeof path !== "string") return args;
	return { ...args, path: formatDisplayPath(path, options.cwd) };
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

function formatNativeReadToolResultText(content: string, totalLines?: number): string {
	if (!content) return content;
	const truncation = truncateHead(content, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	if (truncation.firstLineExceedsLimit) {
		return `[First line exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit]`;
	}
	if (!truncation.truncated) return truncation.content;
	const endLine = truncation.outputLines;
	const total = totalLines ?? content.split("\n").length;
	if (truncation.truncatedBy === "lines") {
		return `${truncation.content}\n\n[Showing lines 1-${endLine} of ${total}. Use offset=${endLine + 1} to continue.]`;
	}
	return `${truncation.content}\n\n[Showing lines 1-${endLine} of ${total} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${endLine + 1} to continue.]`;
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

function getShellOutput(result: NormalizedResult): { text: string; exitCode: number | undefined } {
	const value = asRecord(result.value);
	const stdout = getString(value, "stdout") ?? "";
	const stderr = getString(value, "stderr") ?? "";
	const exitCode = getNumber(value, "exitCode");
	const outputParts: string[] = [];
	if (stdout) outputParts.push(stdout.trimEnd());
	if (stderr) outputParts.push(stderr.trimEnd());
	if (exitCode !== undefined && exitCode !== 0) outputParts.push(`Command exited with code ${exitCode}`);
	return { text: outputParts.filter(Boolean).join("\n\n") || "(no output)", exitCode };
}

function formatShell(args: Record<string, unknown>, result: NormalizedResult, options: TranscriptOptions): string {
	const command = typeof args.command === "string" ? args.command : stringifyUnknown(args).trim();
	if (result.status === "error") return joinSections(`$ ${command || "shell"}`, formatError(result.error));

	const value = asRecord(result.value);
	const executionTime = getNumber(value, "executionTime");
	const outputParts = [getShellOutput(result).text];
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
	const pattern = typeof args.globPattern === "string" ? args.globPattern : "*";
	const targetDirectory = typeof args.targetDirectory === "string" ? formatDisplayPath(args.targetDirectory, options.cwd) : undefined;
	const header = targetDirectory ? `glob ${pattern} in ${targetDirectory}` : `glob ${pattern}`;
	if (result.status === "error") return joinSections(header, formatError(result.error));

	const value = asRecord(result.value);
	const files = getArray(value, "files")?.filter((entry): entry is string => typeof entry === "string") ?? [];
	if (files.length === 0) return joinSections(header, stringifyUnknown(result.value));
	const limited = limitItems(files, options);
	const body = limited.omitted > 0 ? `${limited.items.join("\n")}\n... (${limited.omitted} more files truncated)` : limited.items.join("\n");
	return joinSections(header, body);
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
	for (const outputValue of outputs) {
		const outputRecord = asRecord(outputValue);
		const type = getString(outputRecord, "type");
		const output = getRecord(outputRecord, "output");
		if (type === "content") {
			const matches = getArray(output, "matches") ?? [];
			for (const match of matches) {
				const matchRecord = asRecord(match);
				const file = getString(matchRecord, "file") ?? "";
				const lineNumber = getNumber(matchRecord, "lineNumber");
				const line = getString(matchRecord, "line") ?? "";
				lines.push(`${file}${lineNumber !== undefined ? `:${lineNumber}` : ""}: ${line}`.trim());
			}
		} else if (type === "files") {
			const files = getArray(output, "files") ?? [];
			lines.push(...files.filter((entry): entry is string => typeof entry === "string"));
		} else if (type === "count") {
			const counts = getArray(output, "counts") ?? [];
			for (const count of counts) {
				const countRecord = asRecord(count);
				lines.push(`${getString(countRecord, "file") ?? ""}: ${getNumber(countRecord, "count") ?? 0}`.trim());
			}
		} else {
			lines.push(stringifyUnknown(outputValue));
		}
	}
	return lines.filter(Boolean);
}

function formatGrep(args: Record<string, unknown>, result: NormalizedResult, options: TranscriptOptions): string {
	const pattern = typeof args.pattern === "string" ? args.pattern : "";
	const path = typeof args.path === "string" ? formatDisplayPath(args.path, options.cwd) : undefined;
	const glob = typeof args.glob === "string" ? args.glob : undefined;
	const header = ["grep", pattern && JSON.stringify(pattern), path ?? glob].filter(Boolean).join(" ");
	if (result.status === "error") return joinSections(header, formatError(result.error));

	const lines = collectSearchResults(result.value);
	const limited = limitItems(lines, options);
	const body = limited.omitted > 0 ? `${limited.items.join("\n")}\n... (${limited.omitted} more matches truncated)` : limited.items.join("\n");
	return joinSections(header, limitText(body || stringifyUnknown(result.value), options));
}

function formatWrite(args: Record<string, unknown>, result: NormalizedResult, options: TranscriptOptions): string {
	const path = formatPathArg(args, options) ?? "unknown";
	if (result.status === "error") return joinSections(`write ${path}`, formatError(result.error));

	const value = asRecord(result.value);
	const linesCreated = getNumber(value, "linesCreated");
	const fileSize = getNumber(value, "fileSize");
	const fileContentAfterWrite = getString(value, "fileContentAfterWrite");
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
	const diff = getString(value, "diffString");
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

function formatReadLints(args: Record<string, unknown>, result: NormalizedResult, options: TranscriptOptions): string {
	const paths = Array.isArray(args.paths)
		? args.paths.filter((entry): entry is string => typeof entry === "string").map((entry) => formatDisplayPath(entry, options.cwd))
		: [];
	const header = `readLints${paths.length > 0 ? ` ${paths.join(" ")}` : ""}`;
	if (result.status === "error") return joinSections(header, formatError(result.error));

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
	return joinSections(header, limitText(lines.join("\n") || stringifyUnknown(result.value), options));
}

function formatMcp(args: Record<string, unknown>, result: NormalizedResult, options: TranscriptOptions): string {
	const toolName = typeof args.toolName === "string" ? args.toolName : "mcp";
	if (result.status === "error") return joinSections(toolName, formatError(result.error));

	const value = asRecord(result.value);
	const isError = getBoolean(value, "isError");
	const content = getArray(value, "content") ?? [];
	const text = content
		.map((entry) => getString(asRecord(entry), "text"))
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
		case "mcp":
			return formatMcp(args, result, options);
		default:
			return formatFallback(name, args, result, options);
	}
}

function textToolResult(text: string, details?: unknown): PiToolDisplayResult {
	return { content: [{ type: "text", text }], details };
}

function buildTranscriptReplayPiToolDisplay(
	normalizedName: string,
	args: Record<string, unknown>,
	result: NormalizedResult,
	options: TranscriptOptions,
	body: string,
	details: CursorReplayToolDetails,
): CursorPiToolDisplay {
	return {
		toolName: resolveCursorReplayPiToolName(normalizedName),
		args: withCursorToolLabel(args, normalizedName),
		result: textToolResult(body, details),
		isError: result.status === "error",
	};
}

export function buildCursorPiToolDisplay(toolCall: unknown, options: TranscriptOptions = {}): CursorPiToolDisplay {
	const name = normalizeToolName(getToolName(toolCall));
	const args = getToolArgs(toolCall);
	const result = normalizeResult(getToolResult(toolCall));

	if (name === "read") {
		const isError = result.status === "error";
		const value = asRecord(result.value);
		const totalLines = getNumber(value, "totalLines");
		const readBody = isError ? formatError(result.error) : formatNativeReadToolResultText(getReadContent(args, result, options), totalLines);
		return {
			toolName: "read",
			args: normalizeReadDisplayArgs(args, options),
			result: textToolResult(readBody),
			isError,
		};
	}

	if (name === "shell") {
		const shellOutput = getShellOutput(result);
		const isError = result.status === "error" || (shellOutput.exitCode !== undefined && shellOutput.exitCode !== 0);
		return {
			toolName: "bash",
			args: normalizeBashDisplayArgs(args, options),
			result: textToolResult(result.status === "error" ? formatError(result.error) : limitText(shellOutput.text, options)),
			isError,
		};
	}

	if (name === "ls") {
		return {
			toolName: "ls",
			args: normalizeLsDisplayArgs(args, options),
			result: textToolResult(result.status === "error" ? formatError(result.error) : getLsBody(result, options).trim()),
			isError: result.status === "error",
		};
	}

	if (name === "grep") {
		return {
			toolName: "grep",
			args: normalizeGrepDisplayArgs(args, options),
			result: textToolResult(
				result.status === "error" ? formatError(result.error) : limitText(collectSearchResults(result.value).join("\n") || stringifyUnknown(result.value), options),
			),
			isError: result.status === "error",
		};
	}

	if (name === "glob") {
		const value = asRecord(result.value);
		const files = getArray(value, "files")?.filter((entry): entry is string => typeof entry === "string") ?? [];
		const limited = limitItems(files, options);
		const body =
			limited.omitted > 0
				? `${limited.items.join("\n")}\n... (${limited.omitted} more files truncated)`
				: limited.items.join("\n");
		return {
			toolName: "find",
			args: mapGlobArgsToFindArgs(args, options),
			result: textToolResult(result.status === "error" ? formatError(result.error) : limitText(body || stringifyUnknown(result.value), options)),
			isError: result.status === "error",
		};
	}

	if (name === "edit") {
		const value = asRecord(result.value);
		return {
			toolName: "cursor_edit",
			args: normalizeEditWriteDisplayArgs(args, options),
			result: textToolResult(formatEdit(args, result, options), {
				cursorToolName: "edit",
				path: typeof args.path === "string" ? formatDisplayPath(args.path, options.cwd) : undefined,
				linesAdded: getNumber(value, "linesAdded"),
				linesRemoved: getNumber(value, "linesRemoved"),
				diffString: getString(value, "diffString"),
			}),
			isError: result.status === "error",
		};
	}

	if (name === "write") {
		const value = asRecord(result.value);
		return {
			toolName: "cursor_write",
			args: normalizeEditWriteDisplayArgs(args, options),
			result: textToolResult(formatWrite(args, result, options), {
				cursorToolName: "write",
				path: typeof args.path === "string" ? formatDisplayPath(args.path, options.cwd) : undefined,
				linesCreated: getNumber(value, "linesCreated"),
				fileSize: getNumber(value, "fileSize"),
			}),
			isError: result.status === "error",
		};
	}

	if (name === "delete") {
		const displayArgs = normalizeEditWriteDisplayArgs(args, options);
		const path = typeof displayArgs.path === "string" ? displayArgs.path : undefined;
		const value = asRecord(result.value);
		const fileSize = getNumber(value, "fileSize");
		const body =
			result.status === "error"
				? formatError(result.error)
				: fileSize !== undefined
					? `Deleted ${fileSize} bytes`
					: stringifyUnknown(result.value);
		return buildTranscriptReplayPiToolDisplay(name, displayArgs, result, options, body, {
			cursorToolName: "delete",
			path,
			fileSize,
		});
	}

	if (name === "readLints") {
		const paths = Array.isArray(args.paths)
			? args.paths.filter((entry): entry is string => typeof entry === "string").map((entry) => formatDisplayPath(entry, options.cwd))
			: [];
		const value = asRecord(result.value);
		const files = getArray(value, "fileDiagnostics") ?? [];
		let diagnosticCount = 0;
		for (const file of files) {
			const fileRecord = asRecord(file);
			diagnosticCount += getArray(fileRecord, "diagnostics")?.length ?? 0;
		}
		const body =
			result.status === "error"
				? formatError(result.error)
				: limitText(
						files
							.flatMap((file) => {
								const fileRecord = asRecord(file);
								const pathValue = getString(fileRecord, "path");
								const pathLabel = pathValue ? formatDisplayPath(pathValue, options.cwd) : "unknown";
								const diagnostics = getArray(fileRecord, "diagnostics") ?? [];
								return diagnostics.map((diagnostic) => {
									const diagnosticRecord = asRecord(diagnostic);
									const severity = getString(diagnosticRecord, "severity") ?? "diagnostic";
									const message = getString(diagnosticRecord, "message") ?? "";
									const source = getString(diagnosticRecord, "source");
									return `${pathLabel}: ${severity}${source ? ` ${source}` : ""}: ${message}`;
								});
							})
							.join("\n") || stringifyUnknown(result.value),
						options,
					);
		return buildTranscriptReplayPiToolDisplay(name, args, result, options, body, {
			cursorToolName: "readLints",
			path: paths.join(" "),
		});
	}

	if (name === "mcp") {
		const mcpToolName = typeof args.toolName === "string" ? args.toolName : "mcp";
		const value = asRecord(result.value);
		const isError = getBoolean(value, "isError");
		const content = getArray(value, "content") ?? [];
		const text = content
			.map((entry) => getString(asRecord(entry), "text"))
			.filter((entry): entry is string => Boolean(entry))
			.join("\n");
		const body =
			result.status === "error"
				? formatError(result.error)
				: limitText(`${isError ? "[tool error]\n" : ""}${text || stringifyUnknown(result.value)}`, options);
		return buildTranscriptReplayPiToolDisplay(name, args, result, options, body, {
			cursorToolName: "mcp",
			mcpToolName,
		});
	}

	const body =
		result.status === "error"
			? formatError(result.error)
			: limitText(
					`${Object.keys(args).length > 0 ? `${stringifyUnknown(args)}\n\n` : ""}${stringifyUnknown(result.value)}`.trim(),
					options,
				);
	return buildTranscriptReplayPiToolDisplay(name, args, result, options, body, { cursorToolName: name });
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
