import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	createBuiltinToolInfo,
	createExtensionTestContext,
	getHarnessRegisteredTool,
	makeHarnessModel,
	makeModel,
} from "./helpers/pi-harness.js";
import { createExtensionPi, resetIndexExtensionTestState } from "./helpers/index-extension-test-kit.js";

vi.mock("../src/model-discovery.js", () => ({
	discoverModels: vi.fn(),
	getCursorModelMetadata: vi.fn(),
}));

vi.mock("../src/cursor-provider.js", () => ({
	streamCursor: vi.fn(),
}));

import extensionFactory from "../src/index.js";
import { discoverModels } from "../src/model-discovery.js";

const mockedDiscover = vi.mocked(discoverModels);
import {
	canRenderCursorToolNatively,
	recordCursorNativeToolDisplay,
} from "../src/cursor-native-tool-display.js";
import { CURSOR_ASK_QUESTION_TOOL_NAME } from "../src/cursor-question-tool.js";

describe("extension native Cursor tool replay", () => {
	beforeEach(resetIndexExtensionTestState);

	it("defers native Cursor tool wrapper registration until session_start", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		mockedDiscover.mockResolvedValueOnce([]);
		const pi = createExtensionPi();
		pi.getAllTools.mockImplementation(() => {
			throw new Error("runtime tool actions are unavailable during extension load");
		});

		await extensionFactory(pi);

		expect(pi._tools.map((tool) => tool.name)).toEqual([CURSOR_ASK_QUESTION_TOOL_NAME]);
		expect(canRenderCursorToolNatively("grep")).toBe(false);
	});

	it("registers native Cursor tool wrappers with the pi session cwd", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		mockedDiscover.mockResolvedValueOnce([]);
		const dir = mkdtempSync(join(tmpdir(), "pi-cursor-native-cwd-"));
		try {
			writeFileSync(join(dir, "session-file.txt"), "from session cwd\n");
			const pi = createExtensionPi();
			await extensionFactory(pi);
			await pi.runSessionStart({ cwd: dir });

			const readTool = getHarnessRegisteredTool(pi._tools, "read");
			expect(readTool).toBeDefined();
			const result = await readTool!.execute(
				"ordinary-read",
				{ path: "session-file.txt" },
				undefined,
				undefined,
				createExtensionTestContext({ cwd: dir }),
			);

			expect(result.content).toEqual([{ type: "text", text: "from session cwd\n" }]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("updates registered native Cursor tool wrappers to the latest pi session cwd", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		mockedDiscover.mockResolvedValueOnce([]);
		const firstDir = mkdtempSync(join(tmpdir(), "pi-cursor-native-cwd-first-"));
		const secondDir = mkdtempSync(join(tmpdir(), "pi-cursor-native-cwd-second-"));
		try {
			writeFileSync(join(firstDir, "session-file.txt"), "from first cwd\n");
			writeFileSync(join(secondDir, "session-file.txt"), "from second cwd\n");
			const pi = createExtensionPi();
			await extensionFactory(pi);
			await pi.runSessionStart({ cwd: firstDir });
			await pi.runSessionStart({ cwd: secondDir });

			const readTool = getHarnessRegisteredTool(pi._tools, "read");
			expect(readTool).toBeDefined();
			const result = await readTool!.execute(
				"ordinary-read",
				{ path: "session-file.txt" },
				undefined,
				undefined,
				createExtensionTestContext({ cwd: secondDir }),
			);

			expect(pi.registerTool).toHaveBeenCalledTimes(22);
			expect(result.content).toEqual([{ type: "text", text: "from second cwd\n" }]);
		} finally {
			rmSync(firstDir, { recursive: true, force: true });
			rmSync(secondDir, { recursive: true, force: true });
		}
	});

	it("registered native Cursor tool wrappers return recorded Cursor results without executing built-ins", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		mockedDiscover.mockResolvedValueOnce([]);
		const pi = createExtensionPi();
		await extensionFactory(pi);
		await pi.runSessionStart();

		recordCursorNativeToolDisplay({
			id: "cursor-tool-1",
			toolName: "read",
			args: { path: "README.md" },
			result: { content: [{ type: "text", text: "# pi-cursor-sdk" }] },
			isError: false,
		});

		const readTool = getHarnessRegisteredTool(pi._tools, "read");
		expect(readTool).toBeDefined();
		const result = await readTool!.execute(
			"cursor-tool-1",
			{ path: "README.md" },
			undefined,
			undefined,
			createExtensionTestContext(),
		);

		expect(result).toEqual({
			content: [{ type: "text", text: "# pi-cursor-sdk" }],
			details: undefined,
			terminate: true,
		});
	});

	it("labels collapsed native read replay cards when only local preview content is available", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		mockedDiscover.mockResolvedValueOnce([]);
		const dir = mkdtempSync(join(tmpdir(), "pi-cursor-read-preview-replay-"));
		try {
			writeFileSync(join(dir, "README.md"), "# Local preview body\n");
			const pi = createExtensionPi();
			await extensionFactory(pi);
			await pi.runSessionStart({ cwd: dir });

			const notice = "[local file preview at transcript time; Cursor read result content was unavailable]";
			recordCursorNativeToolDisplay({
				id: "cursor-replay-1-1-tool-1",
				toolName: "read",
				args: { path: "README.md", localReadPreview: true },
				result: {
					content: [{ type: "text", text: `${notice}\n# Local preview body\n` }],
					details: { localReadPreview: true },
				},
				isError: false,
			});

			const readTool = getHarnessRegisteredTool(pi._tools, "read");
			expect(readTool).toBeDefined();
			const theme = {
				fg: (style: string, text: string) => (style === "warning" || style === "muted" ? `<${style}>${text}</${style}>` : text),
				bold: (text: string) => text,
			} as never;
			const replayContext = {
				isError: false,
				toolCallId: "cursor-replay-1-1-tool-1",
				args: { path: "README.md", localReadPreview: true },
				expanded: false,
			} as never;
			const options = { expanded: false, isPartial: false } as never;

			const callRendered = readTool!.renderCall?.({ path: "README.md", localReadPreview: true }, theme, replayContext)?.render(120).join("\n") ?? "";
			const resultRendered =
				readTool!.renderResult?.(
					{
						content: [{ type: "text", text: `${notice}\n# Local preview body\n` }],
						details: { localReadPreview: true },
					},
					options,
					theme,
					replayContext,
				)?.render(120).join("\n") ?? "";

			const callRenderedText = stripVTControlCharacters(callRendered);
			expect(callRenderedText).toContain("read README.md");
			expect(callRenderedText).toContain("local file preview");
			expect(resultRendered).toContain(notice);
			expect(resultRendered).not.toContain("# Local preview body");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("renders Cursor generateImage replay results with a visible path and image fallback", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		mockedDiscover.mockResolvedValueOnce([]);
		const dir = mkdtempSync(join(tmpdir(), "pi-cursor-image-replay-"));
		const imagePath = join(dir, "badge.png");
		writeFileSync(imagePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		try {
			const pi = createExtensionPi();
			await extensionFactory(pi);
			await pi.runSessionStart();

			const generateImageTool = getHarnessRegisteredTool(pi._tools, "cursor_generate_image");
			const component = generateImageTool.renderResult?.(
				{
					content: [{ type: "text", text: `generateImage Small badge\n\nSaved image: ${imagePath}` }],
					details: {
						cursorToolName: "generateImage",
						title: "Cursor generateImage",
						summary: `saved ${imagePath}`,
						imagePath,
						imageDisplayPath: imagePath,
						imageMimeType: "image/png",
						expandedText: `generateImage Small badge\n\nSaved image: ${imagePath}`,
					},
				},
				{ expanded: false, isPartial: false } as never,
				{ fg: (_style: string, text: string) => text, bold: (text: string) => text } as never,
				{ isError: false, showImages: true } as never,
			);

			const rendered = component?.render(120).join("\n") ?? "";
			expect(rendered).toContain(`Cursor generateImage saved ${imagePath}`);
			expect(rendered).toContain("[Image: badge.png [image/png] 1x1]");
		} finally {
			resetCapabilitiesCache();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("renders neutral cursor partial calls from activity metadata", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		mockedDiscover.mockResolvedValueOnce([]);
		const pi = createExtensionPi();
		await extensionFactory(pi);
		await pi.runSessionStart();
		const theme = { fg: (_style: string, text: string) => text, bold: (text: string) => text } as never;
		const cursorTool = getHarnessRegisteredTool(pi._tools, "cursor");

		const rendered = [
			cursorTool.renderCall?.({ activityTitle: "Cursor plan", activitySummary: "2 items", totalCount: 2 }, theme, { isPartial: true } as never)?.render(120).join("\n"),
			cursorTool.renderCall?.({ activityTitle: "Cursor todos", activitySummary: "1/2 completed, 1 pending", totalCount: 2 }, theme, { isPartial: true } as never)?.render(120).join("\n"),
			cursorTool.renderCall?.({ activityTitle: "Cursor MCP", activitySummary: "external_search", toolName: "external_search" }, theme, { isPartial: true } as never)?.render(120).join("\n"),
		]
			.filter((entry): entry is string => Boolean(entry))
			.join("\n");

		expect(rendered).toContain("Cursor plan 2 items");
		expect(rendered).toContain("Cursor todos 1/2 completed, 1 pending");
		expect(rendered).toContain("Cursor MCP external_search");
		expect(rendered).not.toContain("Cursor activity");
		expect(rendered).not.toContain("cursor_create_plan");
		expect(rendered).not.toContain("cursor_update_todos");
		expect(rendered).not.toContain("cursor_mcp");
	});

	it("renders Cursor web replay cards summary-only until expanded", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		mockedDiscover.mockResolvedValueOnce([]);
		const pi = createExtensionPi();
		await extensionFactory(pi);
		await pi.runSessionStart();
		const theme = { fg: (_style: string, text: string) => text, bold: (text: string) => text } as never;
		const context = { isError: false, showImages: false } as never;
		const cursorTool = getHarnessRegisteredTool(pi._tools, "cursor");
		const result = {
			content: [{ type: "text" as const, text: "web search azure-functions python\n\nLinks:\n1. [Release](https://example.com)" }],
			details: {
				cursorToolName: "webSearch",
				title: "Cursor web search",
				summary: "web search azure-functions python",
				expandedText: "web search azure-functions python\n\nLinks:\n1. [Release](https://example.com)",
				collapseDetailsByDefault: true,
			},
		};

		const collapsed = cursorTool!.renderResult?.(result, { expanded: false, isPartial: false } as never, theme, context)?.render(120).join("\n").trimEnd() ?? "";
		const expanded = cursorTool!.renderResult?.(result, { expanded: true, isPartial: false } as never, theme, context)?.render(120).join("\n") ?? "";

		expect(collapsed).toBe("Cursor web search web search azure-functions python");
		expect(collapsed).not.toContain("Links:");
		expect(expanded).toContain("Cursor web search web search azure-functions python");
		expect(expanded).toContain("Links:");
		expect(expanded).toContain("https://example.com");
	});

	it("renders legacy Cursor replay-only tool labels without raw synthetic names", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		mockedDiscover.mockResolvedValueOnce([]);
		const pi = createExtensionPi();
		await extensionFactory(pi);
		await pi.runSessionStart();
		const theme = { fg: (_style: string, text: string) => text, bold: (text: string) => text } as never;
		const options = { expanded: false, isPartial: false } as never;
		const context = { isError: false, showImages: false } as never;

		const editTool = getHarnessRegisteredTool(pi._tools, "cursor_edit");
		const writeTool = getHarnessRegisteredTool(pi._tools, "cursor_write");
		const mcpTool = getHarnessRegisteredTool(pi._tools, "cursor_mcp");

		// Cursor replay-only tools should use pi's default tool shell so they get
		// the same green/red status card background as native tools.
		expect(mcpTool.renderShell).toBeUndefined();

		const rendered = [
			editTool.renderCall?.({ path: "src/index.ts" }, theme, { isPartial: true } as never)?.render(120).join("\n"),
			writeTool.renderResult?.(
				{
					content: [{ type: "text", text: "write new.txt\n\nCreated 1 lines" }],
					details: { variant: "nativeWrite", path: "new.txt", linesCreated: 1, fileSize: 6, expandedText: "Created 1 lines" },
				},
				options,
				theme,
				context,
			)?.render(120).join("\n"),
			mcpTool!.renderResult?.(
				{
					content: [{ type: "text", text: "mcp git\n\nstatus" }],
					details: { variant: "activity", sourceToolName: "mcp", title: "Cursor MCP activity", summary: "git", expandedText: "status" },
				},
				options,
				theme,
				context,
			)?.render(120).join("\n"),
		]
			.filter((entry): entry is string => Boolean(entry))
			.join("\n");

		expect(rendered).toContain("edit src/index.ts");
		expect(rendered).toContain("write new.txt");
		expect(rendered).not.toContain("Cursor edit");
		expect(rendered).not.toContain("Cursor write");
		expect(rendered).toContain("Cursor MCP activity git");
		expect(rendered).not.toContain("cursor_edit");
		expect(rendered).not.toContain("cursor_write");
		expect(rendered).not.toContain("cursor_mcp");
	});

	it("renders native edit and write replay wrappers without synthetic card names", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		mockedDiscover.mockResolvedValueOnce([]);
		const pi = createExtensionPi();
		await extensionFactory(pi);
		await pi.runSessionStart();
		const theme = {
			fg: (style: string, text: string) =>
				["toolDiffAdded", "toolDiffRemoved", "toolDiffContext", "toolOutput"].includes(style) ? `<${style}>${text}</${style}>` : text,
			bold: (text: string) => text,
		} as never;
		const options = { expanded: false, isPartial: false } as never;
		const replayContext = { isError: false, showImages: false, toolCallId: "cursor-replay-1-1-tool-1" } as never;

		const editTool = getHarnessRegisteredTool(pi._tools, "edit");
		const writeTool = getHarnessRegisteredTool(pi._tools, "write");
		const rendered = [
			editTool.renderCall?.({ path: "src/index.ts" }, theme, { isPartial: true, toolCallId: "cursor-replay-1-1-tool-1" } as never)?.render(120).join("\n"),
			editTool.renderResult?.(
				{
					content: [{ type: "text", text: "edit src/index.ts\n\n+1 -1" }],
					details: {
						cursorToolName: "edit",
						path: "src/index.ts",
						linesAdded: 1,
						linesRemoved: 1,
						diff: "--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-old line\n+new line",
					},
				},
				options,
				theme,
				replayContext,
			)?.render(120).join("\n"),
			writeTool!.renderCall?.({ path: "new.txt", content: "hello\n" }, theme, { isPartial: true, toolCallId: "cursor-replay-1-1-tool-2" } as never)?.render(120).join("\n"),
			writeTool!.renderResult?.(
				{
					content: [{ type: "text", text: "write new.txt\n\nCreated 3 lines\n\n# Title\n\nBody" }],
					details: { variant: "nativeWrite", path: "new.txt", linesCreated: 3, fileSize: 13, fileContentAfterWrite: "# Title\n\nBody\n" },
				},
				options,
				theme,
				replayContext,
			)?.render(120).join("\n"),
		]
			.filter((entry): entry is string => Boolean(entry))
			.join("\n");

		expect(rendered).toContain("edit src/index.ts");
		expect(rendered).toContain("write new.txt");
		expect(rendered).toContain("write new.txt (1 line)");
		expect(rendered).not.toContain("write new.txt (2 lines)");
		expect(rendered).toContain("<toolDiffRemoved>-1 old line</toolDiffRemoved>");
		expect(rendered).toContain("<toolDiffAdded>+1 new line</toolDiffAdded>");
		expect(rendered).toContain("<toolOutput># Title</toolOutput>");
		expect(rendered).toContain("<toolOutput>Body</toolOutput>");
		expect(rendered).not.toContain("Cursor edit");
		expect(rendered).not.toContain("Cursor write");
		expect(rendered).not.toContain("cursor_");
	});

	it("renders Cursor replay-only results with collapsed previews instead of summary-only cards", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		mockedDiscover.mockResolvedValueOnce([]);
		const pi = createExtensionPi();
		await extensionFactory(pi);
		await pi.runSessionStart();
		const theme = {
			fg: (style: string, text: string) =>
				["toolDiffAdded", "toolDiffRemoved", "toolDiffContext"].includes(style) ? `<${style}>${text}</${style}>` : text,
			bold: (text: string) => text,
		} as never;
		const options = { expanded: false, isPartial: false } as never;
		const context = { isError: false, showImages: false } as never;

		const todosTool = getHarnessRegisteredTool(pi._tools, "cursor_update_todos");
		const todosRendered = todosTool.renderResult?.(
			{
				content: [{ type: "text", text: "updateTodos\n\n✓ Demo TodoWrite tool output (completed)\n… Run remaining Cursor tools once (inProgress)" }],
				details: {
					cursorToolName: "updateTodos",
					title: "Cursor todos",
					summary: "1/2 completed, 1 in progress",
					expandedText: "updateTodos\n\n✓ Demo TodoWrite tool output (completed)\n… Run remaining Cursor tools once (inProgress)",
				},
			},
			options,
			theme,
			context,
		)?.render(120).join("\n") ?? "";
		expect(todosRendered).toContain("Demo TodoWrite tool output");
		expect(todosRendered).toContain("Run remaining Cursor tools once");

		const taskTool = getHarnessRegisteredTool(pi._tools, "cursor_task");
		const taskRendered = taskTool.renderResult?.(
			{
				content: [{ type: "text", text: "task Quick repo file count\n\n20" }],
				details: {
					cursorToolName: "task",
					title: "Cursor task",
					summary: "Quick repo file count: 20",
					expandedText: "task Quick repo file count\n\n20",
				},
			},
			options,
			theme,
			context,
		)?.render(120).join("\n") ?? "";
		expect(taskRendered).toContain("Cursor task Quick repo file count: 20");

		const editTool = getHarnessRegisteredTool(pi._tools, "cursor_edit");
		const editRendered = editTool.renderResult?.(
			{
				content: [{ type: "text", text: "edit src/index.ts\n\n+1 -1" }],
				details: {
					cursorToolName: "edit",
					path: "src/index.ts",
					linesAdded: 1,
					linesRemoved: 1,
					diffString: "--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-old line\n+new line",
				},
			},
			options,
			theme,
			context,
		)?.render(120).join("\n") ?? "";
		expect(editRendered).toContain("edit src/index.ts added 1 line, removed 1 line");
		expect(editRendered).not.toContain("Cursor updated");
		expect(editRendered).toContain("<toolDiffRemoved>-1 old line</toolDiffRemoved>");
		expect(editRendered).toContain("<toolDiffAdded>+1 new line</toolDiffAdded>");
		expect(editRendered).not.toContain("--- a/src/index.ts");
		expect(editRendered).not.toContain("@@");
		expect(editRendered).not.toContain("expand for diff");

		const createRendered = editTool!.renderResult?.(
			{
				content: [{ type: "text", text: "edit new.txt\n\n+2 -1" }],
				details: {
					cursorToolName: "edit",
					path: "new.txt",
					linesAdded: 2,
					linesRemoved: 1,
					diffString: "--- /dev/null\n+++ b/new.txt\n@@ -1 +1,2 @@\n-\n+first line\n+second line",
				},
			},
			options,
			theme,
			context,
		)?.render(120).join("\n") ?? "";
		expect(createRendered).toContain("edit new.txt created 2 lines");
		expect(createRendered).not.toContain("Cursor created");
		expect(createRendered).toContain("<toolDiffAdded>+1 first line</toolDiffAdded>");
		expect(createRendered).toContain("<toolDiffAdded>+2 second line</toolDiffAdded>");
		expect(createRendered).not.toContain("/dev/null");
		expect(createRendered).not.toContain("@@");

		const neutralPathOnlyEditTool = getHarnessRegisteredTool(pi._tools, "cursor");
		const neutralPathOnlyEditRendered = neutralPathOnlyEditTool.renderResult?.(
			{
				content: [{ type: "text", text: "edit .tool-demo/ux-demo.ts\n\n+1 -1" }],
				details: {
					variant: "activity",
					sourceToolName: "edit",
					title: "Cursor edit",
					summary: ".tool-demo/ux-demo.ts added 1 line, removed 1 line",
					path: ".tool-demo/ux-demo.ts",
					expandedText: "edit .tool-demo/ux-demo.ts\n\n+1 -1",
				},
			},
			options,
			theme,
			context,
		)?.render(120).join("\n") ?? "";
		expect(neutralPathOnlyEditRendered).toContain("Cursor edit .tool-demo/ux-demo.ts added 1 line, removed 1 line");
		expect(neutralPathOnlyEditRendered).not.toContain("<toolDiffRemoved>");
		expect(neutralPathOnlyEditRendered).not.toContain("@@");
	});

	it("registered native Cursor tool wrappers replay recorded Cursor errors as tool errors", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		mockedDiscover.mockResolvedValueOnce([]);
		const pi = createExtensionPi();
		await extensionFactory(pi);
		await pi.runSessionStart();

		recordCursorNativeToolDisplay({
			id: "cursor-tool-error",
			toolName: "bash",
			args: { command: "exit 7" },
			result: { content: [{ type: "text", text: "Command exited with code 7" }] },
			isError: true,
		});

		const bashTool = getHarnessRegisteredTool(pi._tools, "bash");
		await expect(
			bashTool.execute("cursor-tool-error", { command: "exit 7" }, undefined, undefined, createExtensionTestContext()),
		).rejects.toThrow(
			"Command exited with code 7",
		);
	});

	it("does not register native Cursor tool wrappers on non-Cursor models", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		mockedDiscover.mockResolvedValueOnce([]);
		const pi = createExtensionPi();
		await extensionFactory(pi);
		await pi.runSessionStart({
			model: makeHarnessModel("openai-codex", "openai-codex-responses", "gpt-5.5"),
		});

		expect(pi._tools.map((tool) => tool.name)).toEqual([CURSOR_ASK_QUESTION_TOOL_NAME]);
		expect(canRenderCursorToolNatively("cursor")).toBe(false);
		expect(canRenderCursorToolNatively("edit")).toBe(false);
		expect(canRenderCursorToolNatively("write")).toBe(false);
		expect(pi.registerTool).toHaveBeenCalledTimes(1);
	});

	it("leaves ordinary pi edit rendering untouched on non-Cursor models", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		mockedDiscover.mockResolvedValueOnce([]);
		const pi = createExtensionPi();
		await extensionFactory(pi);
		await pi.runSessionStart({
			model: makeHarnessModel("openai-codex", "openai-codex-responses", "gpt-5.5"),
		});

		const wrappedEdit = pi._tools.find((tool) => tool.name === "edit");
		expect(wrappedEdit).toBeUndefined();
		expect(pi._activeToolNames()).toEqual(["read", "bash", "edit", "write"]);
	});

	it("registers native Cursor tool wrappers on first Cursor model transition", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		mockedDiscover.mockResolvedValueOnce([]);
		const pi = createExtensionPi();
		await extensionFactory(pi);
		await pi.runSessionStart({
			model: makeHarnessModel("openai-codex", "openai-codex-responses", "gpt-5.5"),
		});

		expect(pi._tools.map((tool) => tool.name)).toEqual([CURSOR_ASK_QUESTION_TOOL_NAME]);

		await pi.runModelSelect(makeModel("composer-2.5"));

		expect(pi._tools.map((tool) => tool.name)).toContain("cursor");
		expect(pi._tools.map((tool) => tool.name)).toContain("read");
		expect(pi._activeToolNames()).toContain("cursor");
		expect(pi._activeToolNames()).toContain("read");
		expect(canRenderCursorToolNatively("cursor")).toBe(true);
		expect(canRenderCursorToolNatively("read")).toBe(true);
	});

	it("warns once for conflicting native Cursor tool wrappers across turn lifecycle hooks", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		mockedDiscover.mockResolvedValueOnce([]);
		const notify = vi.fn();
		const ui = { notify, setStatus: vi.fn() };
		const pi = createExtensionPi([
			{
				name: "read",
				description: "hashline read",
				parameters: Type.Object({}),
				sourceInfo: {
					source: "package",
					path: "/opt/homebrew/lib/node_modules/pi-hashline-edit/index.ts",
					scope: "user",
					origin: "package",
				},
			},
			createBuiltinToolInfo("bash"),
			createBuiltinToolInfo("grep"),
			createBuiltinToolInfo("find"),
			createBuiltinToolInfo("ls"),
			createBuiltinToolInfo("edit"),
			createBuiltinToolInfo("write"),
		]);
		await extensionFactory(pi);

		await pi.runSessionStart({ ui });
		await pi.runBeforeAgentStart({ ui });
		await pi.runTurnStart({ ui });
		await pi.runModelSelect(makeModel("composer-2.5"), { ui });

		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Cursor native tool replay skipped for read"), "warning");
	});

	it("does not register native Cursor tool wrappers when native display is disabled", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "0";
		mockedDiscover.mockResolvedValueOnce([]);
		const pi = createExtensionPi();
		await extensionFactory(pi);
		await pi.runSessionStart();

		expect(pi._tools.map((tool) => tool.name)).toEqual([CURSOR_ASK_QUESTION_TOOL_NAME]);
		expect(canRenderCursorToolNatively("read")).toBe(false);
	});

	it("does not register native Cursor tool wrappers when native tool registration is disabled", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		process.env.PI_CURSOR_REGISTER_NATIVE_TOOLS = "0";
		mockedDiscover.mockResolvedValueOnce([]);
		const pi = createExtensionPi();
		await extensionFactory(pi);
		await pi.runSessionStart();

		expect(pi._tools.map((tool) => tool.name)).toEqual([CURSOR_ASK_QUESTION_TOOL_NAME]);
		expect(canRenderCursorToolNatively("read")).toBe(false);
	});

	it("skips only native Cursor tool wrappers owned by another extension", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		mockedDiscover.mockResolvedValueOnce([]);
		const pi = createExtensionPi([
			{
				name: "read",
				description: "hashline read",
				parameters: Type.Object({}),
				sourceInfo: {
					source: "package",
					path: "/opt/homebrew/lib/node_modules/pi-hashline-edit/index.ts",
					scope: "user",
					origin: "package",
				},
			},
			createBuiltinToolInfo("bash"),
			createBuiltinToolInfo("grep"),
			createBuiltinToolInfo("find"),
			createBuiltinToolInfo("ls"),
		]);
		await extensionFactory(pi);
		await pi.runSessionStart();

		expect(pi._tools.map((tool) => tool.name)).toEqual([
			CURSOR_ASK_QUESTION_TOOL_NAME,
			"grep",
			"find",
			"ls",
			"cursor",
			"cursor_edit",
			"cursor_write",
			"cursor_delete",
			"cursor_read_lints",
			"cursor_update_todos",
			"cursor_create_plan",
			"cursor_task",
			"cursor_generate_image",
			"cursor_mcp",
			"cursor_sem_search",
			"cursor_record_screen",
			"cursor_web_search",
			"cursor_web_fetch",
			"bash",
			"edit",
			"write",
		]);
		expect(canRenderCursorToolNatively("read")).toBe(false);
		expect(canRenderCursorToolNatively("bash")).toBe(true);
		expect(canRenderCursorToolNatively("edit")).toBe(true);
		expect(canRenderCursorToolNatively("write")).toBe(true);
		expect(canRenderCursorToolNatively("grep")).toBe(true);
		expect(canRenderCursorToolNatively("find")).toBe(true);
		expect(canRenderCursorToolNatively("cursor")).toBe(true);
		expect(canRenderCursorToolNatively("cursor_edit")).toBe(true);
		expect(canRenderCursorToolNatively("ls")).toBe(true);
	});
});
