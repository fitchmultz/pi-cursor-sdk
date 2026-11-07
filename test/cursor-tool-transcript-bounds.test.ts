import { describe, expect, it } from "vitest";
import { CURSOR_REPLAY_UNREGISTERED_ACTIVITY_TOOL_NAME } from "../src/cursor-replay-tool-details.js";
import { CURSOR_REPLAY_ACTIVITY_TOOL_NAME } from "../src/cursor-tool-presentation-registry.js";
import { buildCursorPiToolDisplay, formatCursorToolTranscript } from "../src/cursor-tool-transcript.js";
import { getCursorDisplayDetailSummary } from "./helpers/cursor-display-details.js";


describe("formatCursorToolTranscript bounds and aliases", () => {

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
		expect(pathOnlyWriteDisplay.result.details).toMatchObject({ variant: "activity", sourceToolName: "write", title: "Cursor write", path: "new.txt" });
		expect(editDisplay.result.content[0].text).toContain("--- a/src/index.ts\n+++ b/src/index.ts");
		expect(editDisplay.result.content[0].text).not.toContain("/repo");
		expect(editDisplay.result.details).toMatchObject({
			variant: "activity",
			sourceToolName: "edit",
			title: "Cursor edit",
			path: "src/index.ts",
		});
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
				activityTitle: "Cursor futureSemSearchWidget",
			},
			result: {
				details: {
					sourceToolName: CURSOR_REPLAY_UNREGISTERED_ACTIVITY_TOOL_NAME,
					variant: "activity",
					title: "Cursor futureSemSearchWidget",
				},
			},
			isError: false,
		});
		expect(display.args.activitySummary).toContain("query=");
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
				activityTitle: "Cursor futureBrokenWidget",
			},
			isError: true,
		});
		expect(display.args.activitySummary).toBeUndefined();
		expect(display.result.content[0].text.length).toBeLessThan(1200);
		expect(display.result.content[0].text).not.toContain("x".repeat(500));
		expect(getCursorDisplayDetailSummary(display)).toBeUndefined();
		expect(JSON.stringify(display.result.details ?? {})).not.toContain("x".repeat(500));
	});

	it("falls back to generic display for inherited object property tool names", () => {
		for (const inheritedName of ["constructor", "toString"] as const) {
			const display = buildCursorPiToolDisplay({
				name: inheritedName,
				args: { query: "probe" },
				result: { status: "success", value: { ok: true } },
			});
			expect(display.toolName).toBe(CURSOR_REPLAY_ACTIVITY_TOOL_NAME);
			expect(display.args).toMatchObject({
				activityTitle: `Cursor ${inheritedName}`,
			});
				expect(display.result.details).toMatchObject({
				variant: "activity",
				sourceToolName: CURSOR_REPLAY_UNREGISTERED_ACTIVITY_TOOL_NAME,
				title: `Cursor ${inheritedName}`,
			});
		}
	});
});
