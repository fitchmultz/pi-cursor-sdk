import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCursorPiToolDisplay, formatCursorToolTranscript, mergeCursorToolCalls } from "../src/cursor-tool-transcript.js";

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
		expect(editDisplay.result.content[0].text).toContain("edit src/index.ts");
		expect(editDisplay.result.content[0].text).toContain("+1 -1");
		expect(writeDisplay).toMatchObject({
			toolName: "cursor_write",
			args: { path: "new.txt" },
			result: { details: { cursorToolName: "write" } },
			isError: false,
		});
		expect(writeDisplay.result.content[0].text).toContain("write new.txt");
		expect(writeDisplay.result.content[0].text).toContain("Created 1 lines");
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
});
