import { describe, expect, it } from "vitest";
import {
	CURSOR_REPLAY_COLLAPSED_PREVIEW_LINES,
	CURSOR_REPLAY_PREVIEW_MAX_LINE_CHARS,
	formatCursorReplayDiff,
	formatCursorReplayFilePreview,
	renderCursorReplayResult,
} from "../src/cursor-native-tool-display-replay.js";
import { createRenderContext, createRenderTheme } from "./helpers/render-fixtures.js";

const theme = createRenderTheme();

const taggedTheme = createRenderTheme({
	fg: (name: string, value: string) => `<${name}>${value}</${name}>`,
});

function renderReplayResultWithDetails(details: unknown): string {
	return renderCursorReplayResult(
		{ content: [{ type: "text", text: "ok" }], details },
		{ expanded: false, isPartial: false },
		taggedTheme,
		createRenderContext({ isError: false, showImages: false }),
		false,
	)
		.render(240)
		.join("\n");
}

describe("cursor native replay rendering", () => {
	it("bounds huge single-line diffs in collapsed replay cards", () => {
		const hugeLine = "x".repeat(20_000);
		const rendered = formatCursorReplayDiff(`--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-${hugeLine}\n+${hugeLine}`, theme, CURSOR_REPLAY_COLLAPSED_PREVIEW_LINES);

		expect(rendered).not.toContain(hugeLine);
		expect(rendered.length).toBeLessThan(CURSOR_REPLAY_PREVIEW_MAX_LINE_CHARS * 4);
		expect(rendered).toContain("…");
	});

	it("bounds huge write previews before rendering", () => {
		const hugeLine = "y".repeat(20_000);
		const rendered = formatCursorReplayFilePreview(hugeLine, "generated.txt", theme);

		expect(rendered).toBeDefined();
		expect(rendered).not.toContain(hugeLine);
		expect(rendered!.length).toBeLessThan(CURSOR_REPLAY_PREVIEW_MAX_LINE_CHARS * 2);
		expect(rendered).toContain("more chars");
	});

	it("uses honest truncation copy for expanded diffs that still exceed the display budget", () => {
		const diff = ["--- a/file.txt", "+++ b/file.txt", "@@ -1,60 +1,60 @@", ...Array.from({ length: 60 }, (_, index) => `+line ${index}`)].join("\n");
		const rendered = formatCursorReplayDiff(diff, theme, 40);

		expect(rendered).toContain("more diff lines hidden");
		expect(rendered).not.toContain("full diff");
	});

	it("shows the standard expand affordance on collapsed expandable replay cards", () => {
		const rendered = renderReplayResultWithDetails({
			variant: "activity",
			sourceToolName: "task",
			title: "Cursor subagent",
			summary: "Inspect package.json · Explore · composer-2.5-fast · ID: agent-1",
			expandedText: "subagent Inspect package.json\n\n1. Package name: pi-cursor-sdk\n2. Risk: peer ranges",
		});

		expect(rendered).toContain("to expand");
		expect(rendered).toContain("Cursor subagent");
	});

	it("colors unified diff body lines in neutral Cursor edit activity cards after a long preamble", () => {
		const preamble = Array.from({ length: 12 }, (_, index) => `note ${index + 1}`).join("\n");
		const rendered = renderReplayResultWithDetails({
			variant: "activity",
			sourceToolName: "edit",
			title: "Cursor edit",
			summary: "file.txt added 1 line, removed 1 line",
			expandedText: `${preamble}\n\nedit file.txt\n\n+1 -1\n\n--- a/file.txt\n+++ b/file.txt\n@@ -1,3 +1,3 @@\n-old line\n+new line\n keep line\n final line`,
		});

		expect(rendered).toContain("<toolDiffRemoved>-1 old line</toolDiffRemoved>");
		expect(rendered).toContain("<toolDiffAdded>+1 new line</toolDiffAdded>");
		expect(rendered).toContain("<toolDiffContext> 2 keep line</toolDiffContext>");
		expect(rendered).toContain("<toolDiffContext> 3 final line</toolDiffContext>");
		expect(rendered).not.toContain("--- a/file.txt");
		expect(rendered).not.toContain("+++ b/file.txt");
	});

	it("activity edit with structured diffString uses canonical colored diff renderer (ignores expandedText preamble; text extraction not used)", () => {
		// Structured primary path (new sessions): diffString present on details -> formatCursorReplayDiff directly.
		// Long preamble in expandedText must not affect; no reliance on extractUnifiedDiffSection for coloring.
		const preamble = Array.from({ length: 20 }, (_, index) => `preamble note ${index + 1}`).join("\n");
		const structuredDiff = "--- a/src/file.ts\n+++ b/src/file.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n context";
		const rendered = renderReplayResultWithDetails({
			variant: "activity",
			sourceToolName: "edit",
			title: "Cursor edit",
			summary: "src/file.ts updated",
			diffString: structuredDiff,
			// expandedText has a long preamble; structured diffString must win for colors.
			expandedText: `${preamble}\n\nsome transcript\n${structuredDiff}`,
		});

		// Uses formatCursorReplayDiff output shape (numbered, headers skipped, context/added/removed tags).
		expect(rendered).toContain("<toolDiffRemoved>-1 old</toolDiffRemoved>");
		expect(rendered).toContain("<toolDiffAdded>+1 new</toolDiffAdded>");
		expect(rendered).toContain("<toolDiffContext> 2 context</toolDiffContext>");
		// Headers from structured are omitted by canonical renderer (consistent with nativeEdit).
		expect(rendered).not.toContain("--- a/src/file.ts");
		expect(rendered).not.toContain("+++ b/src/file.ts");
		// Preamble must not leak into diff preview.
		expect(rendered).not.toContain("preamble note");
	});

	it("colors unified diff body lines in neutral Cursor write activity cards", () => {
		// Unstructured write path (no diffString) still exercises extract + canonical renderer.
		const rendered = renderReplayResultWithDetails({
			variant: "activity",
			sourceToolName: "write",
			title: "Cursor write",
			summary: "created 2 lines",
			expandedText: "write file.txt\n\n+2 -0\n\n--- /dev/null\n+++ b/file.txt\n@@ -0,0 +1,2 @@\n+first line\n+second line",
		});

		expect(rendered).toContain("Cursor write");
		// Canonical output (numbered, headers omitted).
		expect(rendered).toContain("<toolDiffAdded>+1 first line</toolDiffAdded>");
		expect(rendered).toContain("<toolDiffAdded>+2 second line</toolDiffAdded>");
		expect(rendered).not.toContain("--- /dev/null");
		expect(rendered).not.toContain("+++ b/file.txt");
	});

	it("activity write with structured fileContentAfterWrite uses canonical file preview (ignores expandedText preamble)", () => {
		const preamble = Array.from({ length: 20 }, (_, index) => `preamble note ${index + 1}`).join("\n");
		const rendered = renderReplayResultWithDetails({
			variant: "activity",
			sourceToolName: "write",
			title: "Cursor write",
			summary: "new.txt",
			path: "new.txt",
			fileContentAfterWrite: "hello world\n",
			expandedText: `${preamble}\n\nwrite new.txt\n\nCreated 1 lines\n\nhello world\n`,
		});

		expect(rendered).toContain("<toolOutput>hello world</toolOutput>");
		expect(rendered).not.toContain("preamble note");
		expect(rendered).not.toContain("<muted>hello world</muted>");
	});
});
