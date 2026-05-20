import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildCursorPiToolDisplay,
	formatCursorToolTranscript,
	mergeCursorToolCalls,
	resolveCursorReplayPiToolName,
} from "../src/cursor-tool-transcript.js";

describe("formatCursorToolTranscript", () => {
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

	it("builds replay-only native pi display data for Cursor edit and write calls", () => {
		const editDisplay = buildCursorPiToolDisplay({
			name: "edit",
			args: { path: "src/index.ts" },
			result: { status: "success", value: { linesAdded: 1, linesRemoved: 1, diffString: "--- a/src/index.ts\n+++ b/src/index.ts" } },
		});
		const writeDisplay = buildCursorPiToolDisplay({
			name: "write",
			args: { path: "new.txt" },
			result: { status: "success", value: { linesCreated: 1, fileSize: 6 } },
		});

		expect(editDisplay).toMatchObject({
			toolName: "cursor_edit",
			args: { path: "src/index.ts" },
			result: { details: { cursorToolName: "edit" } },
			isError: false,
		});
		expect(editDisplay.result.content[0].text).toBe("");
		expect(editDisplay.result.details).toMatchObject({
			cursorToolName: "edit",
			diffString: "--- a/src/index.ts\n+++ b/src/index.ts",
			diff: "--- a/src/index.ts\n+++ b/src/index.ts",
		});
		expect(writeDisplay).toMatchObject({
			toolName: "cursor_write",
			args: { path: "new.txt" },
			result: { content: [{ type: "text", text: "" }], details: { cursorToolName: "write" } },
			isError: false,
		});
	});

	it("uses pi-native read truncation limits for replay tool results", () => {
		const content = Array.from({ length: 2500 }, (_, index) => `line ${index}`).join("\n");
		const display = buildCursorPiToolDisplay({
			name: "read",
			args: { path: "big.txt" },
			result: { status: "success", value: { content, totalLines: 2500 } },
		});

		expect(display.result.content[0].text).toContain("line 0");
		expect(display.result.content[0].text).toContain("Use offset=");
		expect(display.result.content[0].text).not.toContain("more lines truncated");
	});

	it("builds native pi display data for Cursor grep and glob calls", () => {
		const grepDisplay = buildCursorPiToolDisplay({
			name: "grep",
			args: { pattern: "pi-cursor-sdk", path: "/workspace/src" },
			result: {
				status: "success",
				value: { workspaceResults: { src: { type: "content", output: { matches: [{ file: "src/index.ts", lineNumber: 1, line: "export" }] } } } },
			},
		});
		const globDisplay = buildCursorPiToolDisplay({
			name: "glob",
			args: { globPattern: "*.ts", targetDirectory: "/workspace/src" },
			result: { status: "success", value: { files: ["src/index.ts", "src/context.ts"] } },
		});

		expect(grepDisplay.toolName).toBe("grep");
		expect(grepDisplay.args).toEqual({ pattern: "pi-cursor-sdk", path: "src" });
		expect(globDisplay.toolName).toBe("find");
		expect(globDisplay.args).toEqual({ pattern: "*.ts", path: "src" });
	});

	it("normalizes bash replay args to pi-like relative commands without SDK timeout metadata", () => {
		const display = buildCursorPiToolDisplay(
			{
				name: "shell",
				args: { command: "ls /workspace/src", timeout: 30 },
				result: { status: "success", value: { stdout: "a.ts\n", stderr: "", exitCode: 0 } },
			},
			{ cwd: "/workspace" },
		);

		expect(display.toolName).toBe("bash");
		expect(display.args).toEqual({ command: "ls src" });
	});

	it("builds native pi display data for Cursor read and shell calls", () => {
		const readDisplay = buildCursorPiToolDisplay({
			name: "read",
			args: { path: "README.md" },
			result: { status: "success", value: { content: "# Title" } },
		});
		const shellDisplay = buildCursorPiToolDisplay({
			name: "run_terminal_cmd",
			args: { command: "date" },
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
			args: { command: "date" },
			result: { content: [{ type: "text", text: "Sat May  9" }] },
			isError: false,
		});
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

	it("maps delete, readLints, mcp, and unknown tools to native replay tool names", () => {
		expect(resolveCursorReplayPiToolName("delete")).toBe("cursor_delete");
		expect(resolveCursorReplayPiToolName("readLints")).toBe("cursor_read_lints");
		expect(resolveCursorReplayPiToolName("mcp")).toBe("cursor_mcp");
		expect(resolveCursorReplayPiToolName("Task")).toBe("cursor_tool");
	});

	it("builds native pi display data for Cursor delete, readLints, mcp, and unknown tools", () => {
		const deleteDisplay = buildCursorPiToolDisplay(
			{
				name: "delete",
				args: { path: "/workspace/tmp.txt" },
				result: { status: "success", value: { fileSize: 12 } },
			},
			{ cwd: "/workspace" },
		);
		const readLintsDisplay = buildCursorPiToolDisplay(
			{
			name: "readLints",
			args: { paths: ["/workspace/src/index.ts"] },
			result: {
				status: "success",
				value: {
					fileDiagnostics: [
						{
							path: "src/index.ts",
							diagnostics: [{ severity: "error", message: "Expected semicolon", source: "ts" }],
						},
					],
				},
			},
		},
			{ cwd: "/workspace" },
		);
		const mcpDisplay = buildCursorPiToolDisplay({
			name: "mcp",
			args: { toolName: "ListMcpResources", server: "github" },
			result: {
				status: "success",
				value: { isError: false, content: [{ type: "text", text: "resource-a\nresource-b" }] },
			},
		});
		const unknownDisplay = buildCursorPiToolDisplay({
			name: "WebFetch",
			args: { url: "https://example.com" },
			result: { status: "success", value: { title: "Example" } },
		});

		expect(deleteDisplay.toolName).toBe("cursor_delete");
		expect(deleteDisplay.args.path).toBe("tmp.txt");
		expect(readLintsDisplay.toolName).toBe("cursor_read_lints");
		expect(readLintsDisplay.result.content[0].text).toContain("src/index.ts: error ts: Expected semicolon");
		expect(mcpDisplay.toolName).toBe("cursor_mcp");
		expect(mcpDisplay.result.content[0].text).toContain("resource-a");
		expect(unknownDisplay.toolName).toBe("cursor_tool");
		expect(unknownDisplay.args.__cursorToolLabel).toBe("WebFetch");
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
});
