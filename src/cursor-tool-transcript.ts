import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

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
	switch (normalized) {
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
				const file = getString(matchRecord, "file") ?? "";
				const lineNumber = getNumber(matchRecord, "lineNumber");
				const line = getString(matchRecord, "line") ?? "";
				lines.push(`${file}${lineNumber !== undefined ? `:${lineNumber}` : ""}: ${line}`.trim());
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

function buildGenericPiToolDisplay(name: string, args: Record<string, unknown>, result: NormalizedResult, options: TranscriptOptions): CursorPiToolDisplay {
	const isError = result.status === "error";
	return {
		toolName: name,
		args,
		result: textToolResult(isError ? formatError(result.error) : limitText(stringifyUnknown(result.value), options)),
		isError,
	};
}

export function buildCursorPiToolDisplay(toolCall: unknown, options: TranscriptOptions = {}): CursorPiToolDisplay {
	const name = normalizeToolName(getToolName(toolCall));
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
		return {
			toolName: "grep",
			args: buildGrepDisplayArgs(args, options),
			result: textToolResult(isError ? formatError(result.error) : getGrepBody(result, options)),
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
		return {
			toolName: "cursor_edit",
			args,
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
			args,
			result: textToolResult(formatWrite(args, result, options), {
				cursorToolName: "write",
				path: typeof args.path === "string" ? formatDisplayPath(args.path, options.cwd) : undefined,
				linesCreated: getNumber(value, "linesCreated"),
				fileSize: getNumber(value, "fileSize"),
			}),
			isError: result.status === "error",
		};
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
