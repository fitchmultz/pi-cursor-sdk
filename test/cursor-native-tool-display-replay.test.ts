import { describe, expect, it } from "vitest";
import {
	CURSOR_REPLAY_COLLAPSED_PREVIEW_LINES,
	CURSOR_REPLAY_PREVIEW_MAX_LINE_CHARS,
	formatCursorReplayDiff,
	formatCursorReplayFilePreview,
	renderNativeLookingCursorReadReplayResult,
	type CursorReplayRenderTheme,
} from "../src/cursor-native-tool-display-replay.js";
import { LOCAL_READ_PREVIEW_NOTICE } from "../src/cursor-transcript-utils.js";
import { Text } from "@earendil-works/pi-tui";

const theme = {
	fg: (_name: string, value: string) => value,
	bold: (value: string) => value,
} as CursorReplayRenderTheme;

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

	it("shows local read preview disclaimer in collapsed native read replay results", () => {
		const result = {
			content: [{ type: "text" as const, text: `${LOCAL_READ_PREVIEW_NOTICE}\n# Local preview\n` }],
			details: { localReadPreview: true },
		};
		const rendered = renderNativeLookingCursorReadReplayResult(
			result,
			{ expanded: false, isPartial: false },
			theme,
			{ isError: false, args: { path: "README.md", localReadPreview: true } },
			() => new Text("", 0, 0),
		)
			.render(120)
			.join("\n");

		expect(rendered).toContain(LOCAL_READ_PREVIEW_NOTICE);
		expect(rendered).not.toContain("# Local preview");
	});
});
