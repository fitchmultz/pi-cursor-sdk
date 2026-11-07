import { describe, expect, it } from "vitest";
import { CURSOR_REPLAY_ACTIVITY_TOOL_NAME } from "../src/cursor-tool-presentation-registry.js";
import { buildCursorPiToolDisplay, formatCursorToolTranscript } from "../src/cursor-tool-transcript.js";
import { getCursorDisplayDetailSummary } from "./helpers/cursor-display-details.js";


describe("formatCursorToolTranscript MCP and web", () => {

	it("scrubs secrets from Cursor MCP collapsed summaries", () => {
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

		expect(display.args.activitySummary).toContain("auth · apiKey=[redacted]");
		expect(display.args.activitySummary).not.toContain(secret);
		expect(display.args.activitySummary).not.toContain("bearer-token-value");
		expect(getCursorDisplayDetailSummary(display)).toContain("[redacted]");
		expect(getCursorDisplayDetailSummary(display)).not.toContain(secret);
		expect(getCursorDisplayDetailSummary(display)).not.toContain("bearer-token-value");
	});

	it("prefers text MCP summary over earlier non-text blocks", () => {
		const toolCall = {
			name: "mcp",
			args: { toolName: "image_service" },
			result: {
				status: "success",
				value: {
					content: [
						{ type: "image", mimeType: "image/png", data: "base64-image-data" },
						{ text: { text: "useful text preview\nsecond line" } },
					],
				},
			},
		};
		const display = buildCursorPiToolDisplay(toolCall);
		expect(display.args.activitySummary).toBe("image_service · useful text preview");
		expect(display.result.content[0].text).toBe("image_service\n\nuseful text preview\nsecond line");
		expect(formatCursorToolTranscript(toolCall)).toBe("image_service\n\nuseful text preview\nsecond line\n");
	});

	it("summarizes Cursor MCP non-text content without dumping raw payloads", () => {
		const toolCall = {
			name: "mcp",
			args: { toolName: "image_service" },
			result: {
				status: "success",
				value: {
					content: [
						{ type: "image", mimeType: "image/png", data: "base64-image-data" },
						{ type: "resource", uri: "file:///secret.txt", blob: "raw-resource-payload" },
					],
				},
			},
		};
		const display = buildCursorPiToolDisplay(toolCall);
		const transcript = formatCursorToolTranscript(toolCall);

		expect(display.result.content[0].text).toContain("[image image/png omitted]");
		expect(display.result.content[0].text).toContain("[resource omitted]");
		expect(display.result.content[0].text).not.toContain("base64-image-data");
		expect(display.result.content[0].text).not.toContain("raw-resource-payload");
		expect(transcript).toContain("[image image/png omitted]");
		expect(transcript).not.toContain("base64-image-data");
	});

	it("renders empty MCP content without inventing a preview", () => {
		const result = { status: "success" as const, value: { content: [] } };

		const toolCall = { name: "mcp", args: { toolName: "empty" }, result };
		const display = buildCursorPiToolDisplay(toolCall);
		expect(display.args.activitySummary).toBe("empty");
		expect(display.result.content[0].text).toBe('empty\n\n{"content":[]}');
		expect(formatCursorToolTranscript(toolCall)).toBe('empty\n\n{"content":[]}\n');
	});

	it("preserves tool-level MCP errors in output and summaries", () => {
		const result = { status: "success" as const, value: { isError: true, content: [{ text: "failed remotely" }] } };

		const toolCall = { name: "mcp", args: { toolName: "remote" }, result };
		const display = buildCursorPiToolDisplay(toolCall);
		expect(display.args.activitySummary).toBe("remote · failed remotely");
		expect(display.result.content[0].text).toBe("remote\n\n[tool error]\nfailed remotely");
		expect(formatCursorToolTranscript(toolCall)).toBe("remote\n\n[tool error]\nfailed remotely\n");
	});

	it("formats completed semSearch activity with bounded results text", () => {
		const results = "src/index.ts:42 — export function main()\nsrc/util.ts:10 — helper";
		const display = buildCursorPiToolDisplay({
			name: "semSearch",
			args: { query: "main entrypoint", targetDirectories: ["src"], explanation: "find bootstrap" },
			result: { status: "success", value: { results } },
		});
		const transcript = formatCursorToolTranscript({
			name: "semSearch",
			args: { query: "main entrypoint", targetDirectories: ["src"], explanation: "find bootstrap" },
			result: { status: "success", value: { results } },
		});

		expect(display).toMatchObject({
			toolName: CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
			args: { query: "main entrypoint", activityTitle: "Cursor semantic search", activitySummary: "main entrypoint (1 dir)" },
			result: { details: { variant: "activity", sourceToolName: "semSearch", title: "Cursor semantic search", summary: "main entrypoint (1 dir)" } },
			isError: false,
		});
		expect(display.result.content[0].text).toContain(results);
		expect(display.result.content[0].text).not.toContain('"results"');
		expect(transcript).toContain("semSearch main entrypoint");
		expect(transcript).toContain(results);
		expect(transcript).not.toContain('"results"');
	});

	it.each([
		["semSearch", { query: "missing index" }, "semSearch missing index", "semantic index unavailable", "query"],
		["recordScreen", { mode: "START_RECORDING" }, "recordScreen start recording", "screen capture unavailable", "mode"],
	] as const)("formats %s errors without dumping raw payloads", (name, args, header, message, rawKey) => {
		const transcript = formatCursorToolTranscript({
			name,
			args,
			result: { status: "error", error: { message } },
		});

		expect(transcript).toContain(header);
		expect(transcript).toContain(message);
		expect(transcript).not.toContain(`"${rawKey}"`);
	});

	it("formats completed recordScreen activity with mode, path, and duration", () => {
		const display = buildCursorPiToolDisplay(
			{
				name: "recordScreen",
				args: { mode: "SAVE_RECORDING" },
				result: {
					status: "success",
					value: { path: "/repo/.cursor/recordings/demo.webm", recordingDurationMs: 4200, wasPriorRecordingCancelled: false },
				},
			},
			{ cwd: "/repo" },
		);
		const transcript = formatCursorToolTranscript(
			{
				name: "recordScreen",
				args: { mode: "SAVE_RECORDING" },
				result: {
					status: "success",
					value: { path: "/repo/.cursor/recordings/demo.webm", recordingDurationMs: 4200 },
				},
			},
			{ cwd: "/repo" },
		);

		expect(display).toMatchObject({
			toolName: CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
			args: {
				mode: "SAVE_RECORDING",
				path: ".cursor/recordings/demo.webm",
				activityTitle: "Cursor screen recording",
				activitySummary: ".cursor/recordings/demo.webm · 4.2s",
			},
			result: {
				details: {
					variant: "activity",
					sourceToolName: "recordScreen",
					title: "Cursor screen recording",
					summary: ".cursor/recordings/demo.webm · 4.2s",
				},
			},
			isError: false,
		});
		expect(display.result.content[0].text).toContain("Recording: .cursor/recordings/demo.webm");
		expect(display.result.content[0].text).toContain("Duration: 4.2s");
		expect(transcript).toContain("recordScreen save recording");
		expect(transcript).not.toContain('"recordingDurationMs"');
	});

	it("shows Cursor generateImage output paths without dumping image data", () => {
		const display = buildCursorPiToolDisplay(
			{
				name: "generateImage",
				args: { description: "Small badge", filePath: "assets/badge.png" },
				result: {
					status: "success",
					value: { filePath: "/Users/example/.cursor/projects/repo/assets/badge.png", imageData: "base64-image-data" },
				},
			},
			{ cwd: "/repo" },
		);

		expect(display).toMatchObject({
			toolName: CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
			args: { prompt: "Small badge", activityTitle: "Cursor image generation", activitySummary: "/Users/example/.cursor/projects/repo/assets/badge.png" },
			result: {
				details: {
					variant: "generateImage",
					summary: "/Users/example/.cursor/projects/repo/assets/badge.png",
					imagePath: "/Users/example/.cursor/projects/repo/assets/badge.png",
					imageDisplayPath: "/Users/example/.cursor/projects/repo/assets/badge.png",
					imageMimeType: "image/png",
				},
			},
			isError: false,
		});
		expect(display.result.content[0].text).toContain("Saved image: /Users/example/.cursor/projects/repo/assets/badge.png");
		expect(display.result.content[0].text).not.toContain("base64-image-data");
		expect(display.result.details).not.toHaveProperty("title");
	});
});
