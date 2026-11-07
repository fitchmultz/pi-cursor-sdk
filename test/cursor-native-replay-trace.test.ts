import { describe, it, expect } from "vitest";
import { formatInactiveCursorReplayTrace } from "../src/cursor-native-replay-trace.js";

describe("cursor-native-replay-trace", () => {
	it("formats inactive replay as title: summary", () => {
		const text = formatInactiveCursorReplayTrace({
			toolName: "grep",
			args: { pattern: "sidebar", path: "src" },
			result: { content: [{ type: "text", text: "src/app.css" }] },
			isError: false,
		});
		expect(text).toBe("Cursor grep: src/app.css\n");
	});

	it("prefers activity title and summary when present", () => {
		const text = formatInactiveCursorReplayTrace({
			toolName: "cursor",
			args: { activityTitle: "Edit layout", activitySummary: "src/app.tsx" },
			result: { content: [{ type: "text", text: "ignored" }] },
			isError: false,
		});
		expect(text).toBe("Edit layout: src/app.tsx\n");
	});
});
