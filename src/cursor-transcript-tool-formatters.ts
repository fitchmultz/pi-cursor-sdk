import { resolveCursorEditDiff } from "./cursor-edit-diff.js";
import { getFirstStringByKeys } from "./cursor-record-utils.js";
import {
	asRecord,
	formatDisplayPath,
	formatDiffHeaderLine,
	formatDiffString,
	formatError,
	formatPathArg,
	getArray,
	getBoolean,
	getNumber,
	getRecord,
	getString,
	joinSections,
	limitItems,
	limitText,
	LOCAL_READ_PREVIEW_NOTICE,
	DEFAULT_READ_TRANSCRIPT_CHARS,
	DEFAULT_READ_TRANSCRIPT_LINES,
	DEFAULT_NATIVE_READ_DISPLAY_LINES,
	readFilePreview,
	stringifyUnknown,
	firstNonEmptyLine,
	truncateArg,
	type NormalizedResult,
	type TranscriptOptions,
} from "./cursor-transcript-utils.js";

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

export function formatRead(args: Record<string, unknown>, result: NormalizedResult, options: TranscriptOptions): string {
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

export function buildReadDisplayArgs(args: Record<string, unknown>, options: TranscriptOptions): Record<string, unknown> {
	const rawPath = typeof args.path === "string" ? args.path : undefined;
	return rawPath ? { ...args, path: formatDisplayPath(rawPath, options.cwd) } : args;
}

function buildPathDisplayArgs(args: Record<string, unknown>, options: TranscriptOptions): Record<string, unknown> {
	const rawPath = typeof args.path === "string" ? args.path : undefined;
	return rawPath ? { ...args, path: formatDisplayPath(rawPath, options.cwd) } : args;
}

export function buildWriteDisplayArgs(args: Record<string, unknown>, options: TranscriptOptions): Record<string, unknown> {
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

export function buildNativeEditDisplayArgs(rawToolName: string, args: Record<string, unknown>, options: TranscriptOptions): NativeEditDisplayArgs | undefined {
	if (isCursorNotebookEditActivity(rawToolName, args)) return undefined;
	const rawPath = getCursorEditPathArg(args);
	const edits = getNativeEditReplacementsFromArgs(args);
	if (!rawPath || !edits) return undefined;
	return { path: formatDisplayPath(rawPath, options.cwd), edits };
}

export function buildCursorEditActivityDisplayArgs(args: Record<string, unknown>, options: TranscriptOptions): Record<string, unknown> {
	const rawPath = getCursorEditPathArg(args);
	return rawPath ? { ...args, path: formatDisplayPath(rawPath, options.cwd) } : args;
}

export function formatNativeReadDisplayContent(args: Record<string, unknown>, result: NormalizedResult, options: TranscriptOptions): string {
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

export function getShellOutput(result: NormalizedResult, args: Record<string, unknown> = {}): { text: string; exitCode: number | undefined; timedOut: boolean } {
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

export function buildShellDisplayArgs(args: Record<string, unknown>): Record<string, unknown> {
	const command = typeof args.command === "string" ? args.command : undefined;
	const timeoutMs = getNumber(args, "timeout");
	const displayArgs: Record<string, unknown> = command ? { command } : { ...args };
	if (timeoutMs !== undefined) {
		displayArgs.timeout = timeoutMs / 1000;
	}
	return displayArgs;
}

export function formatShell(args: Record<string, unknown>, result: NormalizedResult, options: TranscriptOptions): string {
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

export function getLsBody(result: NormalizedResult, options: TranscriptOptions): string {
	const value = asRecord(result.value);
	const root = value?.directoryTreeRoot ?? result.value;
	const treeLines = renderTreeNode(root);
	const body = treeLines.length > 0 ? treeLines.join("\n") : stringifyUnknown(result.value);
	return limitText(body, options);
}

export function formatLs(args: Record<string, unknown>, result: NormalizedResult, options: TranscriptOptions): string {
	const path = formatPathArg(args, options) ?? ".";
	if (result.status === "error") return joinSections(`ls ${path}`, formatError(result.error));
	return joinSections(`ls ${path}`, getLsBody(result, options));
}

export function formatGlob(args: Record<string, unknown>, result: NormalizedResult, options: TranscriptOptions): string {
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

export function buildGrepDisplayArgs(args: Record<string, unknown>, options: TranscriptOptions): Record<string, unknown> {
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

export function buildFindDisplayArgs(args: Record<string, unknown>, options: TranscriptOptions): Record<string, unknown> {
	const displayArgs: Record<string, unknown> = { pattern: getGlobPattern(args) };
	const targetDirectory = getGlobTargetDirectory(args, options);
	const limit = getNumber(args, "limit") ?? getNumber(args, "headLimit");
	if (targetDirectory !== undefined) displayArgs.path = targetDirectory;
	if (limit !== undefined) displayArgs.limit = limit;
	return displayArgs;
}

export function getGrepBody(result: NormalizedResult, options: TranscriptOptions): string {
	const lines = collectSearchResults(result.value);
	const limited = limitItems(lines, options);
	const body = limited.omitted > 0 ? `${limited.items.join("\n")}\n... (${limited.omitted} more matches truncated)` : limited.items.join("\n");
	return limitText(body || stringifyUnknown(result.value), options);
}

export function getGlobBody(result: NormalizedResult, options: TranscriptOptions): string {
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

export function formatGrep(args: Record<string, unknown>, result: NormalizedResult, options: TranscriptOptions): string {
	const header = `$ ${synthesizeGrepBashCommand(args, options)}`;
	if (result.status === "error") return joinSections(header, formatError(result.error));
	return joinSections(header, getGrepBody(result, options));
}

export function getCursorWriteArgContent(args: Record<string, unknown>): string | undefined {
	return getString(args, "content") ?? getString(args, "fileContent") ?? getString(args, "contents");
}

function getCursorWriteRecordedContent(args: Record<string, unknown>, resultValue: Record<string, unknown> | undefined): string | undefined {
	return getCursorWriteArgContent(args) ?? getString(resultValue, "fileContentAfterWrite");
}

export function formatWrite(args: Record<string, unknown>, result: NormalizedResult, options: TranscriptOptions): string {
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

export function formatEdit(args: Record<string, unknown>, result: NormalizedResult, options: TranscriptOptions): string {
	const path = formatPathArg(args, options) ?? "unknown";
	if (result.status === "error") return joinSections(`edit ${path}`, formatError(result.error));

	const value = asRecord(result.value);
	const diff = formatDiffString(resolveCursorEditDiff(value), options);
	const linesAdded = getNumber(value, "linesAdded");
	const linesRemoved = getNumber(value, "linesRemoved");
	const stats = [
		linesAdded !== undefined ? `+${linesAdded}` : undefined,
		linesRemoved !== undefined ? `-${linesRemoved}` : undefined,
	].filter(Boolean).join(" ");
	const body = [stats, diff ? limitText(diff, options) : undefined].filter((part): part is string => Boolean(part)).join("\n\n");
	return joinSections(`edit ${path}`, body || stringifyUnknown(result.value));
}

export function formatDelete(args: Record<string, unknown>, result: NormalizedResult, options: TranscriptOptions): string {
	const path = formatPathArg(args, options) ?? "unknown";
	if (result.status === "error") return joinSections(`delete ${path}`, formatError(result.error));
	const value = asRecord(result.value);
	const fileSize = getNumber(value, "fileSize");
	return joinSections(`delete ${path}`, fileSize !== undefined ? `Deleted ${fileSize} bytes` : stringifyUnknown(result.value));
}

export function getReadLintPaths(args: Record<string, unknown>, result: NormalizedResult, options: TranscriptOptions): string[] {
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

export function getReadLintDiagnostics(result: NormalizedResult, options: TranscriptOptions): string[] {
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

export function formatReadLints(args: Record<string, unknown>, result: NormalizedResult, options: TranscriptOptions): string {
	const paths = getReadLintPaths(args, result, options);
	const header = `readLints${paths.length > 0 ? ` ${paths.join(" ")}` : ""}`;
	if (result.status === "error") return joinSections(header, formatError(result.error));

	const lines = getReadLintDiagnostics(result, options);
	if (lines.length === 0 && paths.length > 0) return joinSections(header, `No diagnostics in ${paths.join(", ")}`);
	return joinSections(header, limitText(lines.join("\n") || stringifyUnknown(result.value), options));
}

export function getTodoItems(args: Record<string, unknown>, result: NormalizedResult): Array<{ content: string; status?: string }> {
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

export function getTodoTotalCount(args: Record<string, unknown>, result: NormalizedResult, todos: Array<{ content: string; status?: string }>): number {
	return getNumber(asRecord(result.value), "totalCount") ?? getNumber(args, "totalCount") ?? todos.length;
}

export function summarizeTodos(args: Record<string, unknown>, result: NormalizedResult): string {
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

export function formatTodos(args: Record<string, unknown>, result: NormalizedResult, options: TranscriptOptions, header: string): string {
	if (result.status === "error") return joinSections(header, formatError(result.error));
	const todos = getTodoItems(args, result);
	if (todos.length === 0) return joinSections(header, limitText(stringifyUnknown(result.value), options));
	const lines = todos.map((todo) => `${formatTodoStatus(todo.status)} ${todo.content}${todo.status ? ` (${todo.status})` : ""}`);
	return joinSections(header, limitText(lines.join("\n"), options));
}

export function summarizePlan(args: Record<string, unknown>, result: NormalizedResult): string {
	const planText = getString(args, "plan") ?? getString(asRecord(result.value), "plan");
	const firstLine = planText ? firstNonEmptyLine(planText) : undefined;
	return firstLine ? truncateArg(firstLine, 160) : summarizeTodos(args, result);
}

export function formatPlan(args: Record<string, unknown>, result: NormalizedResult, options: TranscriptOptions): string {
	if (result.status === "error") return joinSections("createPlan", formatError(result.error));
	const planText = getString(args, "plan") ?? getString(asRecord(result.value), "plan");
	if (planText?.trim()) return joinSections("createPlan", limitText(planText, options));
	return formatTodos(args, result, options, "createPlan");
}

export function getTaskDescription(args: Record<string, unknown>, result: NormalizedResult): string {
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

export function collectTaskText(result: NormalizedResult): string {
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

export function formatTask(args: Record<string, unknown>, result: NormalizedResult, options: TranscriptOptions): string {
	const description = getTaskDescription(args, result);
	if (result.status === "error") return joinSections(`task ${description}`, formatError(result.error));
	const taskText = collectTaskText(result);
	return joinSections(`task ${description}`, limitText(taskText || stringifyUnknown(result.value), options));
}

export function summarizeTask(description: string, taskText: string): string {
	const firstLine = firstNonEmptyLine(taskText);
	if (!firstLine) return truncateArg(description);
	if (description === "task" || description === firstLine) return truncateArg(firstLine);
	return truncateArg(`${description}: ${firstLine}`, 160);
}

function getGenerateImageValue(result: NormalizedResult): Record<string, unknown> | undefined {
	return asRecord(result.value);
}

export function getGenerateImagePath(args: Record<string, unknown>, result: NormalizedResult): string | undefined {
	const value = getGenerateImageValue(result);
	return getString(value, "filePath") ?? getString(args, "filePath") ?? getString(args, "path");
}

export function getGenerateImageDisplayPath(args: Record<string, unknown>, result: NormalizedResult, options: TranscriptOptions): string | undefined {
	const path = getGenerateImagePath(args, result);
	return path ? formatDisplayPath(path, options.cwd) : undefined;
}

export function inferImageMimeType(path: string | undefined): string | undefined {
	const lower = path?.toLowerCase();
	if (!lower) return undefined;
	if (lower.endsWith(".png")) return "image/png";
	if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
	if (lower.endsWith(".gif")) return "image/gif";
	if (lower.endsWith(".webp")) return "image/webp";
	return undefined;
}

export function formatGenerateImage(args: Record<string, unknown>, result: NormalizedResult, options: TranscriptOptions): string {
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

function describeNonTextMcpContent(entry: unknown): string {
	const record = asRecord(entry);
	const type = getString(record, "type") ?? "content";
	if (type === "image") {
		const mimeType = getString(record, "mimeType") ?? getString(record, "mime") ?? getString(record, "mediaType");
		return `[image${mimeType ? ` ${mimeType}` : ""} omitted]`;
	}
	if (type === "audio") return "[audio omitted]";
	if (type === "resource") return "[resource omitted]";
	return `[${type} omitted]`;
}

export function summarizeSemSearch(args: Record<string, unknown>): string {
	const query = getString(args, "query") ?? "semantic search";
	const targetDirectories = getArray(args, "targetDirectories");
	const dirHint =
		targetDirectories && targetDirectories.length > 0
			? ` (${targetDirectories.length} dir${targetDirectories.length === 1 ? "" : "s"})`
			: "";
	return truncateArg(`${query}${dirHint}`);
}

export function formatSemSearch(args: Record<string, unknown>, result: NormalizedResult, options: TranscriptOptions): string {
	const query = getString(args, "query") ?? "semantic search";
	const header = `semSearch ${truncateArg(query)}`;
	if (result.status === "error") return joinSections(header, formatError(result.error));

	const value = asRecord(result.value);
	const results = getString(value, "results");
	const targetDirectories = getArray(args, "targetDirectories");
	const explanation = getString(args, "explanation");
	const lines: string[] = [];
	if (explanation?.trim()) lines.push(`Explanation: ${explanation.trim()}`);
	if (targetDirectories && targetDirectories.length > 0) {
		const dirs = targetDirectories
			.map((entry) => (typeof entry === "string" ? entry : stringifyUnknown(entry)))
			.join(", ");
		lines.push(`Scope: ${dirs}`);
	}
	if (results?.trim()) lines.push(results.trim());
	const body = lines.length > 0 ? lines.join("\n\n") : stringifyUnknown(result.value);
	return joinSections(header, limitText(body, options));
}

function formatRecordScreenMode(mode: string | undefined): string {
	switch (mode) {
		case "START_RECORDING":
			return "start recording";
		case "SAVE_RECORDING":
			return "save recording";
		case "DISCARD_RECORDING":
			return "discard recording";
		default:
			return mode ?? "record screen";
	}
}

function formatRecordingDurationMs(ms: number | undefined): string | undefined {
	if (ms === undefined || !Number.isFinite(ms) || ms < 0) return undefined;
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const seconds = ms / 1000;
	return seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

export function summarizeRecordScreen(
	args: Record<string, unknown>,
	result: NormalizedResult,
	options: TranscriptOptions,
): string {
	const mode = getString(args, "mode");
	if (result.status === "error") return formatRecordScreenMode(mode);
	const value = asRecord(result.value);
	const path = getString(value, "path");
	const displayPath = path ? formatDisplayPath(path, options.cwd) : undefined;
	const duration = formatRecordingDurationMs(getNumber(value, "recordingDurationMs"));
	const modeLabel = formatRecordScreenMode(mode);
	if (displayPath && duration) return `${displayPath} · ${duration}`;
	if (displayPath) return displayPath;
	if (duration) return `${modeLabel} · ${duration}`;
	return modeLabel;
}

export function formatRecordScreen(args: Record<string, unknown>, result: NormalizedResult, options: TranscriptOptions): string {
	const mode = getString(args, "mode");
	const header = `recordScreen ${formatRecordScreenMode(mode)}`;
	if (result.status === "error") return joinSections(header, formatError(result.error));

	const value = asRecord(result.value);
	const path = getString(value, "path");
	const displayPath = path ? formatDisplayPath(path, options.cwd) : undefined;
	const duration = formatRecordingDurationMs(getNumber(value, "recordingDurationMs"));
	const wasCancelled = getBoolean(value, "wasPriorRecordingCancelled");
	const lines: string[] = [];
	if (displayPath) lines.push(`Recording: ${displayPath}`);
	if (duration) lines.push(`Duration: ${duration}`);
	if (wasCancelled === true) lines.push("Prior recording cancelled.");
	if (lines.length === 0) {
		if (mode === "START_RECORDING") lines.push("Recording started.");
		else if (mode === "DISCARD_RECORDING") lines.push("Recording discarded.");
		else lines.push("Screen recording updated.");
	}
	return joinSections(header, lines.join("\n"));
}

export function formatMcp(args: Record<string, unknown>, result: NormalizedResult, options: TranscriptOptions): string {
	const toolName = typeof args.toolName === "string" ? args.toolName : "mcp";
	if (result.status === "error") return joinSections(toolName, formatError(result.error));

	const value = asRecord(result.value);
	const isError = getBoolean(value, "isError");
	const content = getArray(value, "content") ?? [];
	const text = content
		.map((entry) => getMcpContentText(entry))
		.filter((entry): entry is string => Boolean(entry))
		.join("\n");
	const contentSummary = content.length > 0 ? content.map(describeNonTextMcpContent).join("\n") : stringifyUnknown(result.value);
	const body = `${isError ? "[tool error]\n" : ""}${text || contentSummary}`;
	return joinSections(toolName, limitText(body, options));
}

export function formatFallback(name: string, args: Record<string, unknown>, result: NormalizedResult, options: TranscriptOptions): string {
	const header = name === "unknown" ? "Cursor tool" : name;
	if (result.status === "error") return joinSections(header, formatError(result.error));
	const argsText = Object.keys(args).length > 0 ? `${stringifyUnknown(args)}\n\n` : "";
	return joinSections(header, limitText(`${argsText}${stringifyUnknown(result.value)}`.trim(), options));
}
