import { describe, it, expect } from "vitest";
import { formatInactiveCursorReplayTrace } from "../src/cursor-native-replay-trace.js";
import { scrubPiToolDisplay } from "../src/cursor-sensitive-text.js";
import { buildCursorPiToolDisplay } from "../src/cursor-tool-transcript.js";

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

	it("scrubs secrets from inactive MCP collapsed summary trace", () => {
		const secret = "super-secret-key-12345";
		const display = buildCursorPiToolDisplay({
			name: "mcp",
			args: { toolName: "auth" },
			result: {
				status: "success",
				value: {
					content: [{ text: { text: `apiKey=${secret}\nBearer bearer-token-value` } }],
				},
			},
		});
		const text = formatInactiveCursorReplayTrace(scrubPiToolDisplay(display, secret));

		expect(text).toContain("Cursor MCP");
		expect(text).toContain("[redacted]");
		expect(text).not.toContain(secret);
		expect(text).not.toContain("bearer-token-value");
	});
});
