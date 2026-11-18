import { describe, expect, it } from "vitest";
import { buildCursorPiToolDisplayFromSpec } from "../src/cursor-transcript-tool-specs.js";
import {
	CURSOR_REPLAY_GENERATE_IMAGE_RESULT_TITLE,
	parseCursorReplayToolDetails,
} from "../src/cursor-replay-tool-details.js";
import { renderCursorReplayResult } from "../src/cursor-native-tool-display-replay.js";
import { getCursorToolActivityReplaySpec } from "../src/cursor-tool-presentation-registry.js";
import { createRenderContext, createRenderTheme } from "./helpers/render-fixtures.js";

const theme = createRenderTheme();

function renderReplayResult(details: unknown, text = "ok", isError = false): string {
	return renderCursorReplayResult(
		{ content: [{ type: "text", text }], details },
		{ expanded: false, isPartial: false },
		theme,
		createRenderContext({ isError, showImages: false }),
		isError,
	)
		.render(120)
		.join("\n");
}

describe("cursor replay tool details contract", () => {
	it("does not upgrade payloads without current replay variants", () => {
		expect(parseCursorReplayToolDetails({ path: "src/a.ts" })).toBeUndefined();
		expect(parseCursorReplayToolDetails({ variant: "activity", title: "Cursor MCP" })).toMatchObject({
			variant: "activity",
			sourceToolName: "unregisteredActivity",
			title: "Cursor MCP",
		});
		expect(parseCursorReplayToolDetails({ variant: "edit", path: "src/a.ts" })).toBeUndefined();
	});

	it("parses activity details and ignores unknown fields at the boundary", () => {
		const parsed = parseCursorReplayToolDetails({
			variant: "activity",
			sourceToolName: "mcp",
			title: "Cursor MCP",
			summary: "git status",
			expandedText: "line one",
			untrusted: "drop-me",
		});
		expect(parsed).toMatchObject({
			variant: "activity",
			sourceToolName: "mcp",
			title: "Cursor MCP",
			summary: "git status",
			expandedText: "line one",
		});
		expect(parsed).not.toHaveProperty("untrusted");
	});

	it("parses explicit nativeEdit and nativeWrite variants without title reclassification", () => {
		const edit = parseCursorReplayToolDetails({
			variant: "nativeEdit",
			title: "Cursor edit",
			path: "src/a.ts",
			diffString: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new",
			linesAdded: 1,
		});
		const write = parseCursorReplayToolDetails({
			variant: "nativeWrite",
			title: "Cursor write",
			path: "out.txt",
			linesCreated: 3,
		});

		expect(edit).toMatchObject({ variant: "nativeEdit", path: "src/a.ts" });
		expect(edit).not.toHaveProperty("title");
		expect(write).toMatchObject({ variant: "nativeWrite", path: "out.txt" });
		expect(write).not.toHaveProperty("title");
	});

	it("keeps genericFallback strict instead of repairing known source names in render parsing", () => {
		const edit = parseCursorReplayToolDetails({
			variant: "genericFallback",
			sourceToolName: "edit",
			path: "src/a.ts",
			diffString: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new",
			linesAdded: 1,
		});
		const write = parseCursorReplayToolDetails({
			variant: "genericFallback",
			sourceToolName: "write",
			path: "out.txt",
			linesCreated: 2,
		});
		const image = parseCursorReplayToolDetails({
			variant: "genericFallback",
			sourceToolName: "generateImage",
			imagePath: "/tmp/out.png",
		});

		expect(edit).toMatchObject({ variant: "genericFallback", sourceToolName: "edit" });
		expect(write).toMatchObject({ variant: "genericFallback", sourceToolName: "write" });
		expect(image).toMatchObject({ variant: "genericFallback", sourceToolName: "generateImage" });
	});

	it("renders generateImage producer details with the current visible title and path", () => {
		const display = buildCursorPiToolDisplayFromSpec({
			rawName: "generateImage",
			name: "generateImage",
			args: { prompt: "a red circle" },
			result: { status: "success", value: { filePath: "/tmp/generated.png" }, error: undefined },
			options: { cwd: "/tmp", maxChars: 4000 },
		});
		const rendered = renderReplayResult(display.result.details, display.result.content[0]?.text ?? "");
		const details = parseCursorReplayToolDetails(display.result.details);
		expect(details).toMatchObject({ variant: "generateImage", imagePath: "/tmp/generated.png" });
		expect(details).not.toHaveProperty("title");
		expect(rendered).toContain(`${CURSOR_REPLAY_GENERATE_IMAGE_RESULT_TITLE} generated.png`);
		expect(rendered).not.toContain("Cursor generateImage");
	});

	it.each([
		["edit", "no match", "Cursor edit"],
		["write", "permission denied", "write src/a.ts"],
	] as const)("renders path-only %s errors with the activity error body", (name, error, expectedText) => {
		const display = buildCursorPiToolDisplayFromSpec({
			rawName: name,
			name,
			args: { path: "src/a.ts" },
			result: { status: "error", value: undefined, error },
			options: { cwd: "/repo", maxChars: 4000 },
		});
		const rendered = renderReplayResult(display.result.details, display.result.content[0]?.text ?? "", true);

		expect(display.result.details).toMatchObject({
			variant: "activity",
			sourceToolName: name,
			title: `Cursor ${name}`,
		});
		expect(rendered).toContain(expectedText);
		expect(rendered).toContain(`Error: ${error}`);
		expect(rendered.split("\n")).not.toContain(`${name} src/a.ts`);
	});

	it("renders path-only edit no-change results with the Cursor edit activity title", () => {
		const display = buildCursorPiToolDisplayFromSpec({
			rawName: "edit",
			name: "edit",
			args: { path: "src/a.ts" },
			result: { status: "success", value: { linesAdded: 0, linesRemoved: 0 }, error: undefined },
			options: { cwd: "/repo", maxChars: 4000 },
		});
		const rendered = renderReplayResult(display.result.details, display.result.content[0]?.text ?? "");

		expect(display.result.details).toMatchObject({
			variant: "activity",
			sourceToolName: "edit",
			title: "Cursor edit",
		});
		expect(rendered).toContain("Cursor edit");
		expect(rendered).not.toMatch(/^edit src\/a\.ts$/m);
	});

	it("renders generateImage producer error details with the current visible title", () => {
		const display = buildCursorPiToolDisplayFromSpec({
			rawName: "generateImage",
			name: "generateImage",
			args: { prompt: "a red circle" },
			result: { status: "error", value: undefined, error: "image generation failed" },
			options: { cwd: "/tmp", maxChars: 4000 },
		});
		const rendered = renderCursorReplayResult(
			{
				content: display.result.content,
				details: display.result.details,
			},
			{ expanded: false, isPartial: false },
			theme,
			createRenderContext({ isError: true, showImages: false }),
			true,
		)
			.render(120)
			.join("\n");
		expect(rendered).toContain(CURSOR_REPLAY_GENERATE_IMAGE_RESULT_TITLE);
		expect(rendered).not.toContain("Cursor generateImage");
		expect(rendered).not.toMatch(/^image generation failed$/m);
	});
});

describe("cursor mcp activity collapsed rendering", () => {
	const listing = JSON.stringify([
		{ name: "slack_read_channel", title: "Read channel messages", description: "Reads messages from a Slack channel" },
		{ name: "slack_post_message", title: "Post message", description: "Posts a message" },
	]);

	function displayFor(value: unknown) {
		return buildCursorPiToolDisplayFromSpec({
			rawName: "mcp",
			name: "mcp",
			args: { type: "MCP", toolName: "search_tools", args: { pattern: "slack" } },
			result: { status: "success", value, error: undefined },
			options: { cwd: "/tmp", maxChars: 400_000 },
		});
	}

	it("collapses a payload that would otherwise fill the row", () => {
		const display = displayFor({ content: [{ type: "text", text: listing }] });
		const rendered = renderReplayResult(display.result.details, display.result.content[0]?.text ?? "");

		// The row is one logical line: the title and summary. Narrow widths may wrap that line, so the
		// payload is what has to be absent, measured by the body it would otherwise print.
		expect(rendered).toContain("Cursor MCP search_tools");
		expect(rendered).not.toContain("slack_post_message");
		expect(rendered).not.toContain("Posts a message");
	});

	it("still shows the full payload once expanded", () => {
		const display = displayFor({ content: [{ type: "text", text: listing }] });
		const rendered = renderCursorReplayResult(
			{ content: display.result.content, details: display.result.details },
			{ expanded: true, isPartial: false },
			theme,
			createRenderContext({ isError: false, showImages: false }),
			false,
		)
			.render(120)
			.join("\n");

		expect(rendered).toContain("slack_post_message");
	});

	it("collapses rows recorded before the mcp spec collapsed details", () => {
		// Shape written by an earlier version: no collapse flag of its own, which a resumed session
		// replays verbatim.
		const rendered = renderReplayResult({
			variant: "activity",
			sourceToolName: "mcp",
			title: "Cursor MCP",
			summary: "search_tools",
			expandedText: 'search_tools\n\n[{"name":"sonarqube_analyze_code_snippet","description":"Analyze a file"}]',
		});

		expect(rendered.split("\n").filter((line) => line.trim())).toHaveLength(1);
		expect(rendered).not.toContain("sonarqube_analyze_code_snippet");
	});

	it("marks every spec that collapses its details, so recorded rows collapse too", () => {
		for (const source of ["mcp", "webSearch", "webFetch"] as const) {
			const spec = getCursorToolActivityReplaySpec(source);
			expect(spec?.collapseDetailsByDefault).toBe(true);
			expect(spec?.buildDetails({} as never, "x")).toMatchObject({ collapseDetailsByDefault: true });
		}
	});
});
