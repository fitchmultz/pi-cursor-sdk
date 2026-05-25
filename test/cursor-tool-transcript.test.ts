import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CURSOR_REPLAY_ACTIVITY_TOOL_NAME, isExcludedFromCursorBridgeExposure } from "../src/cursor-tool-names.js";
import { buildCursorPiToolDisplay, formatCursorToolTranscript, getCursorCreatePlanText, mergeCursorToolCalls } from "../src/cursor-tool-transcript.js";

describe("formatCursorToolTranscript", () => {
	it("defines shared bridge exclusions for neutral and legacy Cursor replay activity names", () => {
		expect(isExcludedFromCursorBridgeExposure("cursor")).toBe(true);
		expect(isExcludedFromCursorBridgeExposure("cursor_edit")).toBe(true);
		expect(isExcludedFromCursorBridgeExposure("cursor_write")).toBe(true);
		expect(isExcludedFromCursorBridgeExposure("cursor_mcp")).toBe(true);
		expect(isExcludedFromCursorBridgeExposure("cursor_sem_search")).toBe(true);
		expect(isExcludedFromCursorBridgeExposure("cursor_record_screen")).toBe(true);
		expect(isExcludedFromCursorBridgeExposure("cursor_web_search")).toBe(true);
		expect(isExcludedFromCursorBridgeExposure("cursor_web_fetch")).toBe(true);
		expect(isExcludedFromCursorBridgeExposure("bash")).toBe(false);
	});

	it("formats Cursor read results as a pi-like read transcript", () => {
		const transcript = formatCursorToolTranscript({
			name: "read",
			args: { path: "README.md" },
			result: {
				status: "success",
				value: { content: "# pi-cursor-sdk\n\nA pi provider extension", totalLines: 3, fileSize: 42 },
			},
		});

		expect(transcript).toBe("read README.md\n\n# pi-cursor-sdk\n\nA pi provider extension\n");
	});

	it("formats Cursor createPlan args as visible plan text", () => {
		const plan = "Plan:\n1. Build a calculator UI.\n2. Add arithmetic operations.";
		const toolCall = {
			name: "createPlan",
			args: { plan },
			result: { status: "success", value: {} },
		};

		expect(getCursorCreatePlanText(toolCall)).toBe(plan);
		expect(formatCursorToolTranscript(toolCall)).toBe(`createPlan\n\n${plan}\n`);

		const display = buildCursorPiToolDisplay(toolCall);
		expect(display).toMatchObject({
			toolName: CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
			args: { totalCount: 0, activityTitle: "Cursor plan", activitySummary: "Plan:" },
			result: { details: { cursorToolName: "createPlan", title: "Cursor plan", summary: "Plan:" } },
			isError: false,
		});
		expect(display.result.content[0].text).toContain("Build a calculator UI");
	});

	it("labels empty Cursor read result local file previews", () => {
		const dir = mkdtempSync(join(tmpdir(), "cursor-tool-transcript-"));
		try {
			writeFileSync(join(dir, "README.md"), "# Local title\n\nLocal body\n");

			const transcript = formatCursorToolTranscript(
				{
					name: "read",
					args: { path: join(dir, "README.md") },
					result: { status: "success", value: { content: "", totalLines: 3, fileSize: 26 } },
				},
				{ cwd: dir },
			);

			expect(transcript).toContain("read README.md");
			expect(transcript).toContain("[local file preview at transcript time; Cursor read result content was unavailable]");
			expect(transcript).toContain("# Local title");
			expect(transcript).toContain("Local body");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not fill empty Cursor read results from sensitive or out-of-workspace files", () => {
		const dir = mkdtempSync(join(tmpdir(), "cursor-tool-transcript-"));
		const outsideDir = mkdtempSync(join(tmpdir(), "cursor-tool-transcript-outside-"));
		try {
			writeFileSync(join(dir, ".env"), "API_KEY=do-not-show\n");
			writeFileSync(join(outsideDir, "notes.txt"), "outside content\n");

			const sensitiveTranscript = formatCursorToolTranscript(
				{
					name: "read",
					args: { path: join(dir, ".env") },
					result: { status: "success", value: { content: "", totalLines: 1, fileSize: 20 } },
				},
				{ cwd: dir },
			);
			const outsideTranscript = formatCursorToolTranscript(
				{
					name: "read",
					args: { path: join(outsideDir, "notes.txt") },
					result: { status: "success", value: { content: "", totalLines: 1, fileSize: 16 } },
				},
				{ cwd: dir },
			);

			expect(sensitiveTranscript).not.toContain("do-not-show");
			expect(outsideTranscript).not.toContain("outside content");
		} finally {
			rmSync(dir, { recursive: true, force: true });
			rmSync(outsideDir, { recursive: true, force: true });
		}
	});

	it("does not fill empty Cursor read results through sensitive workspace symlink names", () => {
		const dir = mkdtempSync(join(tmpdir(), "cursor-tool-transcript-"));
		try {
			writeFileSync(join(dir, "safe-target.txt"), "API_KEY=do-not-show\n");
			symlinkSync(join(dir, "safe-target.txt"), join(dir, ".env"));

			const transcript = formatCursorToolTranscript(
				{
					name: "read",
					args: { path: join(dir, ".env") },
					result: { status: "success", value: { content: "", totalLines: 1, fileSize: 20 } },
				},
				{ cwd: dir },
			);

			expect(transcript).toContain("read .env");
			expect(transcript).not.toContain("do-not-show");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not fill empty Cursor read results through workspace symlinks to outside files", () => {
		const dir = mkdtempSync(join(tmpdir(), "cursor-tool-transcript-"));
		const outsideDir = mkdtempSync(join(tmpdir(), "cursor-tool-transcript-outside-"));
		try {
			writeFileSync(join(outsideDir, "secret.txt"), "outside secret content\n");
			symlinkSync(join(outsideDir, "secret.txt"), join(dir, "linked-secret.txt"));

			const transcript = formatCursorToolTranscript(
				{
					name: "read",
					args: { path: join(dir, "linked-secret.txt") },
					result: { status: "success", value: { content: "", totalLines: 1, fileSize: 23 } },
				},
				{ cwd: dir },
			);

			expect(transcript).toContain("read linked-secret.txt");
			expect(transcript).not.toContain("outside secret content");
		} finally {
			rmSync(dir, { recursive: true, force: true });
			rmSync(outsideDir, { recursive: true, force: true });
		}
	});

	it("shortens absolute workspace paths to relative paths", () => {
		const transcript = formatCursorToolTranscript(
			{
				name: "read",
				args: { path: "/repo/README.md" },
				result: { status: "success", value: { content: "# Title" } },
			},
			{ cwd: "/repo" },
		);

		expect(transcript).toContain("read README.md");
		expect(transcript).not.toContain("/repo/README.md");
	});

	it("formats Cursor shell results as a pi-like bash transcript", () => {
		const transcript = formatCursorToolTranscript({
			name: "shell",
			args: { command: "date" },
			result: {
				status: "success",
				value: { stdout: "Sat May  9 10:48:38 MDT 2026\n", stderr: "", exitCode: 0, executionTime: 12 },
			},
		});

		expect(transcript).toContain("$ date\n\nSat May  9 10:48:38 MDT 2026");
		expect(transcript).toContain("Took 0.0s");
	});

	it("builds native pi display data for Cursor ls calls without parsing formatted transcript headers", () => {
		const display = buildCursorPiToolDisplay({
			name: "ls",
			args: { path: "." },
			result: {
				status: "success",
				value: {
					directoryTreeRoot: {
						name: "root",
						children: [{ name: "src" }, { name: "test" }],
					},
				},
			},
		});

		expect(display).toMatchObject({
			toolName: "ls",
			args: { path: "." },
			result: { content: [{ type: "text", text: "root\n  src\n  test" }] },
			isError: false,
		});
		expect(display.result.content[0].text).not.toContain("ls .");
	});

	it("uses native edit replay only when Cursor edit args can truthfully satisfy pi edit schema", () => {
		const editDisplay = buildCursorPiToolDisplay({
			name: "edit",
			args: { path: "src/index.ts", oldText: "old line\n", newText: "new line\n" },
			result: { status: "success", value: { linesAdded: 1, linesRemoved: 1, diffString: "--- a/src/index.ts\n+++ b/src/index.ts" } },
		});
		const writeDisplay = buildCursorPiToolDisplay({
			name: "write",
			args: { path: "new.txt", content: "hello\n" },
			result: { status: "success", value: { linesCreated: 1, fileSize: 6, fileContentAfterWrite: "hello\n" } },
		});

		expect(editDisplay).toMatchObject({
			toolName: "edit",
			args: { path: "src/index.ts", edits: [{ oldText: "old line\n", newText: "new line\n" }] },
			result: { details: { cursorToolName: "edit", diff: "--- a/src/index.ts\n+++ b/src/index.ts" } },
			isError: false,
		});
		expect(editDisplay.toolName).not.toContain("cursor");
		expect(editDisplay.result.content[0].text).toContain("edit src/index.ts");
		expect(editDisplay.result.content[0].text).toContain("+1 -1");
		expect(writeDisplay).toMatchObject({
			toolName: "write",
			args: { path: "new.txt", content: "hello\n" },
			result: { details: { cursorToolName: "write", fileContentAfterWrite: "hello\n" } },
			isError: false,
		});
		expect(writeDisplay.toolName).not.toContain("cursor");
		expect(writeDisplay.result.content[0].text).toContain("write new.txt");
		expect(writeDisplay.result.content[0].text).toContain("Created 1 lines");
		expect(writeDisplay.result.content[0].text).toContain("hello");
	});

	it("falls back path-only Cursor edit replay to neutral cursor activity", () => {
		const editDisplay = buildCursorPiToolDisplay({
			name: "edit",
			args: { path: ".tool-demo-temp.txt" },
			result: { status: "success", value: { linesAdded: 1, linesRemoved: 0, diffString: "--- a/.tool-demo-temp.txt\n+++ b/.tool-demo-temp.txt" } },
		});

		expect(editDisplay).toMatchObject({
			toolName: CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
			args: { path: ".tool-demo-temp.txt", activityTitle: "Cursor edit", activitySummary: ".tool-demo-temp.txt" },
			result: { details: { cursorToolName: "edit", title: "Cursor edit", summary: ".tool-demo-temp.txt", diff: "--- a/.tool-demo-temp.txt\n+++ b/.tool-demo-temp.txt" } },
			isError: false,
		});
		expect(editDisplay.args).not.toHaveProperty("edits");
		expect(editDisplay.result.content[0].text).toContain("edit .tool-demo-temp.txt");
	});

	it("maps Cursor StrReplace to schema-valid edit replay and notebook edits to neutral cursor activity", () => {
		const strReplaceDisplay = buildCursorPiToolDisplay({
			name: "StrReplace",
			args: { path: "src/index.ts", old_string: "before", new_string: "after" },
			result: { status: "success", value: { linesAdded: 2, linesRemoved: 1, diff: "--- a/src/index.ts\n+++ b/src/index.ts" } },
		});
		const notebookDisplay = buildCursorPiToolDisplay({
			name: "EditNotebook",
			args: { path: "notebooks/demo.ipynb", cellId: "cell-1" },
			result: { status: "success", value: { linesAdded: 1, linesRemoved: 0, unifiedDiff: "--- a/notebooks/demo.ipynb\n+++ b/notebooks/demo.ipynb" } },
		});
		const genericNotebookEditDisplay = buildCursorPiToolDisplay({
			name: "edit",
			args: { path: "notebooks/demo.ipynb", oldText: "before", newText: "after" },
			result: { status: "success", value: { linesAdded: 1, linesRemoved: 1, unifiedDiff: "--- a/notebooks/demo.ipynb\n+++ b/notebooks/demo.ipynb" } },
		});

		expect(strReplaceDisplay).toMatchObject({
			toolName: "edit",
			args: { path: "src/index.ts", edits: [{ oldText: "before", newText: "after" }] },
			result: { details: { cursorToolName: "edit", diff: "--- a/src/index.ts\n+++ b/src/index.ts" } },
			isError: false,
		});
		expect(notebookDisplay).toMatchObject({
			toolName: CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
			args: { path: "notebooks/demo.ipynb", cellId: "cell-1", activityTitle: "Cursor edit", activitySummary: "notebooks/demo.ipynb" },
			result: { details: { cursorToolName: "edit", title: "Cursor edit", diff: "--- a/notebooks/demo.ipynb\n+++ b/notebooks/demo.ipynb" } },
			isError: false,
		});
		expect(genericNotebookEditDisplay).toMatchObject({
			toolName: CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
			args: { path: "notebooks/demo.ipynb", oldText: "before", newText: "after", activityTitle: "Cursor edit", activitySummary: "notebooks/demo.ipynb" },
			result: { details: { cursorToolName: "edit", title: "Cursor edit", diff: "--- a/notebooks/demo.ipynb\n+++ b/notebooks/demo.ipynb" } },
			isError: false,
		});
		expect(strReplaceDisplay.toolName).not.toBe(CURSOR_REPLAY_ACTIVITY_TOOL_NAME);
		expect(notebookDisplay.args).not.toHaveProperty("edits");
		expect(genericNotebookEditDisplay.args).not.toHaveProperty("edits");
	});

	it("builds replay-only native pi display data for Cursor workflow and utility tools", () => {
		const lintsDisplay = buildCursorPiToolDisplay(
			{
				name: "readLints",
				args: { path: "/repo/src/index.ts" },
				result: {
					status: "success",
					value: { fileDiagnostics: [{ path: "/repo/src/index.ts", diagnostics: [] }], totalDiagnostics: 0 },
				},
			},
			{ cwd: "/repo" },
		);
		const todosDisplay = buildCursorPiToolDisplay({
			name: "updateTodos",
			args: {},
			result: {
				status: "success",
				value: {
					todos: [
						{ content: "Run Read/Grep/Glob", status: "completed" },
						{ content: "Run Task/MCP", status: "pending" },
					],
					totalCount: 2,
				},
			},
		});
		const planDisplay = buildCursorPiToolDisplay({
			name: "createPlan",
			args: {},
			result: {
				status: "success",
				value: {
					todos: [
						{ content: "Draft plan", status: "completed" },
						{ content: "Review plan", status: "pending" },
					],
					totalCount: 2,
				},
			},
		});
		const taskDisplay = buildCursorPiToolDisplay({
			name: "task",
			args: { description: "Quick ls demo subagent" },
			result: {
				status: "success",
				value: { result: { success: { command: "ls src | head -5", stdout: "context.ts\ncursor-provider.ts\n" } } },
			},
		});
		const mcpDisplay = buildCursorPiToolDisplay({
			name: "mcp",
			args: { toolName: "git" },
			result: {
				status: "success",
				value: { content: [{ text: { text: "## Git Status ✅\n13 modified" } }], isError: false },
			},
		});
		const deleteDisplay = buildCursorPiToolDisplay(
			{
				name: "delete",
				args: { path: "/repo/.debug/delete-me.txt" },
				result: { status: "success", value: { fileSize: 9 } },
			},
			{ cwd: "/repo" },
		);

		expect(lintsDisplay).toMatchObject({
			toolName: CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
			args: { paths: ["src/index.ts"], diagnosticCount: 0, activityTitle: "Cursor diagnostics", activitySummary: "0 diagnostics in src/index.ts" },
			result: { details: { cursorToolName: "readLints", title: "Cursor diagnostics", summary: "0 diagnostics in src/index.ts" } },
			isError: false,
		});
		expect(lintsDisplay.result.content[0].text).toContain("No diagnostics in src/index.ts");
		expect(todosDisplay).toMatchObject({
			toolName: CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
			args: { totalCount: 2, activityTitle: "Cursor todos", activitySummary: "1/2 completed, 1 pending" },
			result: {
				details: {
					cursorToolName: "updateTodos",
					title: "Cursor todos",
					summary: "1/2 completed, 1 pending",
				},
			},
			isError: false,
		});
		expect(planDisplay).toMatchObject({
			toolName: CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
			args: { totalCount: 2, activityTitle: "Cursor plan", activitySummary: "1/2 completed, 1 pending" },
			result: {
				details: {
					cursorToolName: "createPlan",
					title: "Cursor plan",
					summary: "1/2 completed, 1 pending",
				},
			},
			isError: false,
		});
		expect(todosDisplay.result.content[0].text).toContain("✓ Run Read/Grep/Glob (completed)");
		expect(taskDisplay).toMatchObject({
			toolName: CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
			args: { description: "Quick ls demo subagent", activityTitle: "Cursor task", activitySummary: "Quick ls demo subagent: $ ls src | head -5" },
			result: { details: { cursorToolName: "task", title: "Cursor task", summary: "Quick ls demo subagent: $ ls src | head -5" } },
			isError: false,
		});
		expect(taskDisplay.result.content[0].text).toContain("context.ts");
		expect(mcpDisplay).toMatchObject({
			toolName: CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
			args: { toolName: "git", activityTitle: "Cursor MCP", activitySummary: "git · ## Git Status ✅" },
			result: { details: { cursorToolName: "mcp", title: "Cursor MCP", summary: "git · ## Git Status ✅" } },
			isError: false,
		});
		expect(mcpDisplay.result.content[0].text).toContain("## Git Status ✅");
		expect(mcpDisplay.result.content[0].text).not.toContain('"content"');
		expect(deleteDisplay).toMatchObject({
			toolName: CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
			args: { path: ".debug/delete-me.txt", activityTitle: "Cursor delete", activitySummary: ".debug/delete-me.txt" },
			result: { details: { cursorToolName: "delete", title: "Cursor delete", path: ".debug/delete-me.txt" } },
			isError: false,
		});
		expect(deleteDisplay.result.content[0].text).toContain("Deleted 9 bytes");
	});

	it("scrubs secrets from Cursor MCP collapsed summaries", () => {
		const secret = "super-secret-key-12345";
		const display = buildCursorPiToolDisplay({
			name: "mcp",
			args: { toolName: "auth" },
			result: {
				status: "success",
				value: {
					content: [{ text: { text: `apiKey=${secret}\nBearer bearer-token-value` } }],
				},
			},
		});

		expect(display.args.activitySummary).toContain("auth · apiKey=[redacted]");
		expect(display.args.activitySummary).not.toContain(secret);
		expect(display.args.activitySummary).not.toContain("bearer-token-value");
		expect(display.result.details?.summary).toContain("[redacted]");
		expect(display.result.details?.summary).not.toContain(secret);
		expect(display.result.details?.summary).not.toContain("bearer-token-value");
	});

	it("summarizes Cursor MCP non-text content without dumping raw payloads", () => {
		const display = buildCursorPiToolDisplay({
			name: "mcp",
			args: { toolName: "image_service" },
			result: {
				status: "success",
				value: {
					content: [
						{ type: "image", mimeType: "image/png", data: "base64-image-data" },
						{ type: "resource", uri: "file:///secret.txt", blob: "raw-resource-payload" },
					],
				},
			},
		});
		const transcript = formatCursorToolTranscript({
			name: "mcp",
			args: { toolName: "image_service" },
			result: {
				status: "success",
				value: {
					content: [
						{ type: "image", mimeType: "image/png", data: "base64-image-data" },
						{ type: "resource", uri: "file:///secret.txt", blob: "raw-resource-payload" },
					],
				},
			},
		});

		expect(display.result.content[0].text).toContain("[image image/png omitted]");
		expect(display.result.content[0].text).toContain("[resource omitted]");
		expect(display.result.content[0].text).not.toContain("base64-image-data");
		expect(display.result.content[0].text).not.toContain("raw-resource-payload");
		expect(transcript).toContain("[image image/png omitted]");
		expect(transcript).not.toContain("base64-image-data");
	});

	it("labels completed Cursor web search MCP activity instead of generic Cursor MCP", () => {
		const toolCall = {
			name: "mcp",
			args: { toolName: "WebSearch", args: { search_term: "pi extension" } },
			result: { status: "success", value: { content: [{ text: { text: "result snippet" } }], isError: false } },
		};
		const display = buildCursorPiToolDisplay(toolCall);
		const transcript = formatCursorToolTranscript(toolCall);

		expect(display).toMatchObject({
			toolName: CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
			args: { query: "pi extension", activityTitle: "Cursor web search", activitySummary: "pi extension" },
			result: { details: { cursorToolName: "webSearch", title: "Cursor web search" } },
		});
		expect(display.args.activityTitle).not.toBe("Cursor MCP");
		expect(transcript).toContain("web search pi extension");
		expect(transcript).not.toContain("WebSearch\n");
	});

	it("labels completed Cursor web fetch host activity with bounded URL summary", () => {
		const toolCall = {
			name: "web_fetch",
			args: { url: "https://example.com/docs" },
			result: { status: "success", value: { content: [{ text: { text: "docs page" } }], isError: false } },
		};
		const display = buildCursorPiToolDisplay(toolCall);

		expect(display).toMatchObject({
			toolName: CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
			args: { url: "https://example.com/docs", activityTitle: "Cursor web fetch", activitySummary: "https://example.com/docs" },
			result: { details: { cursorToolName: "webFetch", title: "Cursor web fetch" } },
		});
	});

	it("formats completed semSearch activity with bounded results text", () => {
		const results = "src/index.ts:42 — export function main()\nsrc/util.ts:10 — helper";
		const display = buildCursorPiToolDisplay({
			name: "semSearch",
			args: { query: "main entrypoint", targetDirectories: ["src"], explanation: "find bootstrap" },
			result: { status: "success", value: { results } },
		});
		const transcript = formatCursorToolTranscript({
			name: "semSearch",
			args: { query: "main entrypoint", targetDirectories: ["src"], explanation: "find bootstrap" },
			result: { status: "success", value: { results } },
		});

		expect(display).toMatchObject({
			toolName: CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
			args: { query: "main entrypoint", activityTitle: "Cursor semantic search", activitySummary: "main entrypoint (1 dir)" },
			result: { details: { cursorToolName: "semSearch", title: "Cursor semantic search", summary: "semSearch main entrypoint" } },
			isError: false,
		});
		expect(display.result.content[0].text).toContain(results);
		expect(display.result.content[0].text).not.toContain('"results"');
		expect(transcript).toContain("semSearch main entrypoint");
		expect(transcript).toContain(results);
		expect(transcript).not.toContain('"results"');
	});

	it("formats semSearch errors without dumping raw payloads", () => {
		const transcript = formatCursorToolTranscript({
			name: "semSearch",
			args: { query: "missing index" },
			result: { status: "error", error: { message: "semantic index unavailable" } },
		});

		expect(transcript).toContain("semSearch missing index");
		expect(transcript).toContain("semantic index unavailable");
		expect(transcript).not.toContain('"query"');
	});

	it("formats completed recordScreen activity with mode, path, and duration", () => {
		const display = buildCursorPiToolDisplay(
			{
				name: "recordScreen",
				args: { mode: "SAVE_RECORDING" },
				result: {
					status: "success",
					value: { path: "/repo/.cursor/recordings/demo.webm", recordingDurationMs: 4200, wasPriorRecordingCancelled: false },
				},
			},
			{ cwd: "/repo" },
		);
		const transcript = formatCursorToolTranscript(
			{
				name: "recordScreen",
				args: { mode: "SAVE_RECORDING" },
				result: {
					status: "success",
					value: { path: "/repo/.cursor/recordings/demo.webm", recordingDurationMs: 4200 },
				},
			},
			{ cwd: "/repo" },
		);

		expect(display).toMatchObject({
			toolName: CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
			args: {
				mode: "SAVE_RECORDING",
				path: ".cursor/recordings/demo.webm",
				activityTitle: "Cursor screen recording",
				activitySummary: ".cursor/recordings/demo.webm · 4.2s",
			},
			result: {
				details: {
					cursorToolName: "recordScreen",
					title: "Cursor screen recording",
					summary: ".cursor/recordings/demo.webm · 4.2s",
				},
			},
			isError: false,
		});
		expect(display.result.content[0].text).toContain("Recording: .cursor/recordings/demo.webm");
		expect(display.result.content[0].text).toContain("Duration: 4.2s");
		expect(transcript).toContain("recordScreen save recording");
		expect(transcript).not.toContain('"recordingDurationMs"');
	});

	it("formats recordScreen errors without dumping raw payloads", () => {
		const transcript = formatCursorToolTranscript({
			name: "recordScreen",
			args: { mode: "START_RECORDING" },
			result: { status: "error", error: { message: "screen capture unavailable" } },
		});

		expect(transcript).toContain("recordScreen start recording");
		expect(transcript).toContain("screen capture unavailable");
		expect(transcript).not.toContain('"mode"');
	});

	it("shows Cursor generateImage output paths without dumping image data", () => {
		const display = buildCursorPiToolDisplay(
			{
				name: "generateImage",
				args: { description: "Small badge", filePath: "assets/badge.png" },
				result: {
					status: "success",
					value: { filePath: "/Users/example/.cursor/projects/repo/assets/badge.png", imageData: "base64-image-data" },
				},
			},
			{ cwd: "/repo" },
		);

		expect(display).toMatchObject({
			toolName: CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
			args: { prompt: "Small badge", activityTitle: "Cursor image generation", activitySummary: "/Users/example/.cursor/projects/repo/assets/badge.png" },
			result: {
				details: {
					cursorToolName: "generateImage",
					title: "Cursor image generation",
					summary: "saved /Users/example/.cursor/projects/repo/assets/badge.png",
					imagePath: "/Users/example/.cursor/projects/repo/assets/badge.png",
					imageDisplayPath: "/Users/example/.cursor/projects/repo/assets/badge.png",
					imageMimeType: "image/png",
				},
			},
			isError: false,
		});
		expect(display.result.content[0].text).toContain("Saved image: /Users/example/.cursor/projects/repo/assets/badge.png");
		expect(display.result.content[0].text).not.toContain("base64-image-data");
	});

	it("normalizes replay-only Cursor edit and write paths for pi display", () => {
		const editDisplay = buildCursorPiToolDisplay(
			{
				name: "edit",
				args: { path: "/repo/src/index.ts" },
				result: {
					status: "success",
					value: { linesAdded: 1, linesRemoved: 1, diffString: "--- a//repo/src/index.ts\n+++ b//repo/src/index.ts" },
				},
			},
			{ cwd: "/repo" },
		);
		const nativeEditDisplay = buildCursorPiToolDisplay(
			{
				name: "StrReplace",
				args: { path: "/repo/src/index.ts", oldText: "old", newText: "new" },
				result: {
					status: "success",
					value: { linesAdded: 1, linesRemoved: 1, diffString: "--- a//repo/src/index.ts\n+++ b//repo/src/index.ts" },
				},
			},
			{ cwd: "/repo" },
		);
		const pathOnlyWriteDisplay = buildCursorPiToolDisplay(
			{
				name: "write",
				args: { path: "/repo/new.txt" },
				result: { status: "success", value: { linesCreated: 1, fileSize: 6 } },
			},
			{ cwd: "/repo" },
		);
		const contentWriteDisplay = buildCursorPiToolDisplay(
			{
				name: "write",
				args: { path: "/repo/new.txt", content: "hello\n" },
				result: { status: "success", value: { linesCreated: 1, fileSize: 6, fileContentAfterWrite: "hello\n" } },
			},
			{ cwd: "/repo" },
		);

		expect(editDisplay.args).toEqual({ path: "src/index.ts", activityTitle: "Cursor edit", activitySummary: "src/index.ts" });
		expect(nativeEditDisplay.args).toEqual({ path: "src/index.ts", edits: [{ oldText: "old", newText: "new" }] });
		expect(pathOnlyWriteDisplay.args).toEqual({ path: "new.txt", activityTitle: "Cursor write", activitySummary: "new.txt" });
		expect(contentWriteDisplay.args).toEqual({ path: "new.txt", content: "hello\n" });
		expect(editDisplay.toolName).toBe(CURSOR_REPLAY_ACTIVITY_TOOL_NAME);
		expect(nativeEditDisplay.toolName).toBe("edit");
		expect(pathOnlyWriteDisplay.toolName).toBe(CURSOR_REPLAY_ACTIVITY_TOOL_NAME);
		expect(contentWriteDisplay.toolName).toBe("write");
		expect(editDisplay.result.content[0].text).toContain("edit src/index.ts");
		expect(pathOnlyWriteDisplay.result.content[0].text).toContain("write new.txt");
		expect(pathOnlyWriteDisplay.result.details).toMatchObject({ cursorToolName: "write", title: "Cursor write", path: "new.txt" });
		expect(editDisplay.result.content[0].text).toContain("--- a/src/index.ts\n+++ b/src/index.ts");
		expect(editDisplay.result.content[0].text).not.toContain("/repo");
		expect(editDisplay.result.details).toMatchObject({ path: "src/index.ts", diffString: "--- a/src/index.ts\n+++ b/src/index.ts", diff: "--- a/src/index.ts\n+++ b/src/index.ts" });
	});

	it("builds native pi display data for Cursor read and shell calls", () => {
		const readDisplay = buildCursorPiToolDisplay({
			name: "read",
			args: { path: "README.md" },
			result: { status: "success", value: { content: "# Title" } },
		});
		const shellDisplay = buildCursorPiToolDisplay({
			name: "run_terminal_cmd",
			args: { command: "date", timeout: 30000 },
			result: { status: "success", value: { stdout: "Sat May  9\n", stderr: "", exitCode: 0 } },
		});

		expect(readDisplay).toMatchObject({
			toolName: "read",
			args: { path: "README.md" },
			result: { content: [{ type: "text", text: "# Title" }] },
			isError: false,
		});
		expect(shellDisplay).toMatchObject({
			toolName: "bash",
			args: { command: "date", timeout: 30 },
			result: { content: [{ type: "text", text: "Sat May  9" }] },
			isError: false,
		});
	});

	it("marks native pi display data for nonzero Cursor shell exits as errors", () => {
		const shellDisplay = buildCursorPiToolDisplay({
			name: "shell",
			args: { command: "printf error >&2; exit 7", timeout: 30000 },
			result: { status: "success", value: { stdout: "", stderr: "error\n", exitCode: 7 } },
		});

		expect(shellDisplay).toMatchObject({
			toolName: "bash",
			args: { command: "printf error >&2; exit 7", timeout: 30 },
			result: { content: [{ type: "text", text: "error\n\nCommand exited with code 7" }] },
			isError: true,
		});
	});

	it("marks Cursor shell commands backgrounded by timeout as native pi errors", () => {
		const shellDisplay = buildCursorPiToolDisplay({
			name: "shell",
			args: { command: "sleep 2", timeout: 1000 },
			result: { status: "success", value: { stdout: "", stderr: "", exitCode: 0, executionTime: 1113 } },
		});

		expect(shellDisplay).toMatchObject({
			toolName: "bash",
			args: { command: "sleep 2", timeout: 1 },
			result: { content: [{ type: "text", text: "Command backgrounded after 1 second timeout" }] },
			isError: true,
		});
	});

	it("normalizes native Cursor read display paths and uses pi-like continuation text", () => {
		const cwd = "/repo";
		const content = Array.from({ length: 25 }, (_, index) => `line ${index + 1}`).join("\n");
		const display = buildCursorPiToolDisplay(
			{
				name: "read",
				args: { path: "/repo/README.md" },
				result: { status: "success", value: { content, totalLines: 25, fileSize: content.length } },
			},
			{ cwd },
		);

		expect(display.args).toEqual({ path: "README.md" });
		expect(display.result.content[0].text).toBe(
			`${Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n")}\n\n[5 more lines in file. Use offset=21 to continue.]`,
		);
	});

	it("builds native pi grep display data for Cursor grep calls and find display data for Cursor glob calls", () => {
		const grepDisplay = buildCursorPiToolDisplay({
			type: "grep",
			args: { pattern: "getActiveTools|sem_reindex", path: "src" },
			result: {
				status: "success",
				value: {
					workspaceResults: {
						src: {
							type: "files",
							output: { files: ["src/tools/reindex.ts:", "src/tools/status.ts:"] },
						},
					},
				},
			},
		});
		const globDisplay = buildCursorPiToolDisplay({
			type: "glob",
			args: { globPattern: "**/*.ts", targetDirectory: "src" },
			result: { status: "success", value: { files: ["src/index.ts", "src/context.ts"] } },
		});
		const emptyGrepDisplay = buildCursorPiToolDisplay({
			type: "grep",
			args: { pattern: "missing", path: "src" },
			result: { status: "success", value: { totalMatches: 0 } },
		});
		const emptyWorkspaceGrepDisplay = buildCursorPiToolDisplay({
			type: "grep",
			args: { pattern: "missing", path: "src" },
			result: {
				status: "success",
				value: {
					workspaceResults: {
						"/repo": {
							type: "content",
							output: { matches: [], totalMatches: 0 },
						},
					},
				},
			},
		});
		const fileOnlyContentGrepDisplay = buildCursorPiToolDisplay({
			type: "grep",
			args: { pattern: "version", path: "." },
			result: {
				status: "success",
				value: {
					workspaceResults: {
						"/repo": {
							type: "content",
							output: { matches: [{ file: "./package.json:", line: "" }], totalMatches: 1 },
						},
					},
				},
			},
		});
		const emptyGlobDisplay = buildCursorPiToolDisplay({
			type: "glob",
			args: { globPattern: "**/*.missing", targetDirectory: "src" },
			result: { status: "success", value: { files: [], totalMatches: 0 } },
		});
		const emptyCursorGlobDisplay = buildCursorPiToolDisplay({
			type: "glob",
			args: { globPattern: "**/*.missing", targetDirectory: "src" },
			result: { status: "success", value: { files: [], totalFiles: 0, clientTruncated: false, ripgrepTruncated: false } },
		});

		expect(grepDisplay).toMatchObject({
			toolName: "grep",
			args: { pattern: "getActiveTools|sem_reindex", path: "src" },
			result: { content: [{ type: "text", text: "src/tools/reindex.ts\nsrc/tools/status.ts" }] },
			isError: false,
		});
		expect(globDisplay).toMatchObject({
			toolName: "find",
			args: { pattern: "**/*.ts", path: "src" },
			result: { content: [{ type: "text", text: "src/index.ts\nsrc/context.ts" }] },
			isError: false,
		});
		expect(emptyGrepDisplay.result.content[0].text).toBe("(no matches)");
		expect(emptyWorkspaceGrepDisplay.result.content[0].text).toBe("(no matches)");
		expect(fileOnlyContentGrepDisplay.result.content[0].text).toBe("./package.json");
		expect(emptyGlobDisplay.result.content[0].text).toBe("No files found matching pattern");
		expect(emptyCursorGlobDisplay.result.content[0].text).toBe("No files found matching pattern");
	});

	it("labels native read display local previews when Cursor read content is unavailable", () => {
		const dir = mkdtempSync(join(tmpdir(), "cursor-tool-display-"));
		try {
			writeFileSync(join(dir, "README.md"), "# Local display preview\n");

			const display = buildCursorPiToolDisplay(
				{
					name: "read",
					args: { path: join(dir, "README.md") },
					result: { status: "success", value: { content: "", totalLines: 1, fileSize: 24 } },
				},
				{ cwd: dir },
			);

			expect(display.args).toMatchObject({ localReadPreview: true });
			expect(display.result.details).toMatchObject({ localReadPreview: true });
			expect(display.result.content[0].text).toContain(
				"[local file preview at transcript time; Cursor read result content was unavailable]",
			);
			expect(display.result.content[0].text).toContain("# Local display preview");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps started tool args when the completed Cursor update only contains a result", () => {
		const merged = mergeCursorToolCalls(
			{ name: "read", args: { path: "src/index.ts" } },
			{ name: "read", result: { status: "success", value: { content: "export default" } } },
		);

		expect(formatCursorToolTranscript(merged)).toContain("read src/index.ts");
	});

	it("maps common Cursor aliases to pi-like command names", () => {
		const transcript = formatCursorToolTranscript({
			name: "run_terminal_cmd",
			args: { command: "pwd" },
			result: { status: "success", value: { stdout: "/tmp\n", stderr: "", exitCode: 0, executionTime: 1 } },
		});

		expect(transcript).toContain("$ pwd");
		expect(transcript).toContain("/tmp");
	});

	it("bounds large Cursor read output", () => {
		const transcript = formatCursorToolTranscript(
			{
				name: "read",
				args: { path: "big.txt" },
				result: { status: "success", value: { content: Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n") } },
			},
			{ maxLines: 3, maxChars: 1000 },
		);

		expect(transcript).toContain("read big.txt");
		expect(transcript).toContain("line 0\nline 1\nline 2");
		expect(transcript).toContain("17 more lines");
	});

	it("bounds unknown future Cursor tool completions with neutral activity cards", () => {
		const largePayload = "x".repeat(5000);
		const toolCall = {
			name: "futureSemSearchWidget",
			args: {
				query: largePayload,
				...Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`field-${index}`, `value-${index}`])),
			},
			result: {
				status: "success",
				value: { matches: Array.from({ length: 40 }, (_, index) => ({ path: `src/file-${index}.ts`, score: index })) },
			},
		};

		const transcript = formatCursorToolTranscript(toolCall);
		expect(transcript.startsWith("futureSemSearchWidget\n\n")).toBe(true);
		expect(transcript).toContain("query=");
		expect(transcript).toContain("(+5 more)");
		expect(transcript.length).toBeLessThan(1200);
		expect(transcript).not.toContain(largePayload);

		const display = buildCursorPiToolDisplay(toolCall);
		expect(display).toMatchObject({
			toolName: CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
			args: {
				cursorToolName: "futureSemSearchWidget",
				activityTitle: "Cursor activity",
				activitySummary: "futureSemSearchWidget",
			},
			result: {
				details: {
					cursorToolName: "futureSemSearchWidget",
					title: "Cursor activity",
				},
			},
			isError: false,
		});
		expect(display.result.content[0].text.length).toBeLessThan(1200);
	});

	it("bounds unknown future Cursor tool error completions with neutral activity cards", () => {
		const largeError = { message: "x".repeat(5000), details: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`field-${index}`, "y".repeat(200)])) };
		const toolCall = {
			name: "futureBrokenWidget",
			args: {
				query: "x".repeat(5000),
				...Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`field-${index}`, `value-${index}`])),
			},
			result: {
				status: "error",
				error: largeError,
			},
		};

		const transcript = formatCursorToolTranscript(toolCall);
		expect(transcript.startsWith("futureBrokenWidget\n\n")).toBe(true);
		expect(transcript).toContain("query=");
		expect(transcript).toContain("Error:");
		expect(transcript.length).toBeLessThan(1200);
		expect(transcript).not.toContain("x".repeat(500));

		const display = buildCursorPiToolDisplay(toolCall);
		expect(display).toMatchObject({
			toolName: CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
			args: {
				cursorToolName: "futureBrokenWidget",
				activityTitle: "Cursor activity",
				activitySummary: "futureBrokenWidget",
			},
			isError: true,
		});
		expect(display.result.content[0].text.length).toBeLessThan(1200);
		expect(display.result.content[0].text).not.toContain("x".repeat(500));
		expect(display.result.details?.summary).toBeUndefined();
		expect(JSON.stringify(display.result.details ?? {})).not.toContain("x".repeat(500));
	});
});
