import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CURSOR_REPLAY_ACTIVITY_TOOL_NAME } from "../src/cursor-tool-presentation-registry.js";
import {
	buildCursorPiToolDisplay,
	formatCursorToolTranscript,
	getCursorCreatePlanText,
} from "../src/cursor-tool-transcript.js";


describe("formatCursorToolTranscript read and shell", () => {
	it.each([["README.md", undefined], ["/repo/README.md", "/repo"]] as const)("formats Cursor read results as a pi-like read transcript (%s)", (path, cwd) => {
		const transcript = formatCursorToolTranscript({
			name: "read",
			args: { path },
			result: {
				status: "success",
				value: { content: "# pi-cursor-sdk\n\nA pi provider extension", totalLines: 3, fileSize: 42 },
			},
		}, { cwd });

		expect(transcript).toBe("read README.md\n\n# pi-cursor-sdk\n\nA pi provider extension\n");
		expect(transcript).not.toContain("/repo/README.md");
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
			result: { details: { variant: "activity", sourceToolName: "createPlan", title: "Cursor plan", summary: "Plan:" } },
			isError: false,
		});
		expect(display.result.content[0].text).toContain("Build a calculator UI");
	});

	it("labels empty Cursor read result local file previews", () => {
		const dir = mkdtempSync(join(tmpdir(), "cursor-tool-transcript-"));
		try {
			writeFileSync(join(dir, "README.md"), "# Local title\n\nLocal body\n");
			const toolCall = {
				name: "read",
				args: { path: join(dir, "README.md") },
				result: { status: "success", value: { content: "", totalLines: 3, fileSize: 26 } },
			};
			const transcript = formatCursorToolTranscript(toolCall, { cwd: dir });
			const display = buildCursorPiToolDisplay(toolCall, { cwd: dir });
			const notice = "[local file preview at transcript time; Cursor read result content was unavailable]";

			expect(transcript).toContain("read README.md");
			expect(transcript).toContain(notice);
			expect(transcript).toContain("# Local title");
			expect(transcript).toContain("Local body");
			expect(display.args).toMatchObject({ localReadPreview: true });
			expect(display.result.details).toMatchObject({ localReadPreview: true });
			expect(display.result.content[0].text).toContain(notice);
			expect(display.result.content[0].text).toContain("# Local title");
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
});
