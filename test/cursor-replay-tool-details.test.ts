import { describe, expect, it } from "vitest";
import { buildCursorPiToolDisplayFromSpec } from "../src/cursor-transcript-tool-specs.js";
import {
	CURSOR_REPLAY_GENERATE_IMAGE_RESULT_TITLE,
	parseCursorReplayToolDetails,
} from "../src/cursor-replay-tool-details.js";
import { renderCursorReplayResult } from "../src/cursor-native-tool-display-replay.js";
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
