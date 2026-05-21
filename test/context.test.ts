import { describe, it, expect } from "vitest";
import { buildCursorPrompt } from "../src/context.js";
import type { Context, UserMessage, AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";

describe("buildCursorPrompt", () => {
	it("includes system prompt", () => {
		const ctx: Context = {
			systemPrompt: "You are helpful.",
			messages: [],
		};
		const result = buildCursorPrompt(ctx);
		expect(result.text).toContain("System instructions from pi:");
		expect(result.text).toContain("You are helpful.");
	});

	it("omits pi tool catalogs and local skill catalogs from Cursor-facing system instructions", () => {
		const ctx: Context = {
			systemPrompt: [
				"You are an expert coding assistant.",
				"",
				"Available tools:",
				"- custom_private_tool: private local tool",
				"- read: read files",
				"",
				"In addition to the tools above, you may have access to other custom tools depending on the project.",
				"",
				"Guidelines:",
				"- Use custom_private_tool for private work",
				"- Be concise in your responses",
				"",
				"Pi documentation (read only when needed):",
				"- Main documentation: /pi/README.md",
				"",
				"<project_context>",
				"Project instruction stays.",
				"</project_context>",
				"",
				"The following skills provide specialized instructions for specific tasks.",
				"Use the read tool to load a skill's file when the task matches its description.",
				"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
				"",
				"<available_skills>",
				"  <skill><name>private-skill</name><description>private local skill</description></skill>",
				"</available_skills>",
				"Current date: 2026-05-20",
				"Current working directory: /repo",
				"Semantic code intelligence priority:",
				"- Prefer custom_private_tool for symbols",
			].join("\n"),
			messages: [],
		};
		const result = buildCursorPrompt(ctx);
		expect(result.text).toContain("Pi tool catalog omitted");
		expect(result.text).toContain("Project instruction stays.");
		expect(result.text).toContain("Current date: 2026-05-20");
		expect(result.text).not.toContain("custom_private_tool");
		expect(result.text).not.toContain("private-skill");
		expect(result.text).not.toContain("Semantic code intelligence priority");
	});

	it("formats user and assistant messages", () => {
		const ctx: Context = {
			messages: [
				{ role: "user", content: "Hello", timestamp: 1 } satisfies UserMessage,
				{ role: "assistant", content: [{ type: "text", text: "Hi there" }], api: "cursor-sdk", provider: "cursor", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 } satisfies AssistantMessage,
			],
		};
		const result = buildCursorPrompt(ctx);
		expect(result.text).toContain("User: Hello");
		expect(result.text).toContain("Assistant: Hi there");
	});

	it("defensively formats assistant string content", () => {
		const ctx: Context = {
			messages: [
				{
					role: "assistant",
					content: "Legacy assistant text",
					api: "cursor-sdk",
					provider: "cursor",
					model: "test",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "stop",
					timestamp: 2,
				} as unknown as AssistantMessage,
			],
		};
		const result = buildCursorPrompt(ctx);
		expect(result.text).toContain("Assistant: Legacy assistant text");
	});

	it("omits thinking content from transcript", () => {
		const ctx: Context = {
			messages: [
				{ role: "user", content: "Think hard", timestamp: 1 } satisfies UserMessage,
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "internal thought" },
						{ type: "text", text: "Final answer" },
					],
					api: "cursor-sdk", provider: "cursor", model: "test",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "stop", timestamp: 2,
				} satisfies AssistantMessage,
			],
		};
		const result = buildCursorPrompt(ctx);
		expect(result.text).toContain("Final answer");
		expect(result.text).not.toContain("internal thought");
	});

	it("formats tool results", () => {
		const ctx: Context = {
			messages: [
				{ role: "user", content: "Run it", timestamp: 1 } satisfies UserMessage,
				{
					role: "toolResult",
					toolCallId: "tc1",
					toolName: "bash",
					content: [{ type: "text", text: "output here" }],
					isError: false,
					timestamp: 2,
				} satisfies ToolResultMessage,
			],
		};
		const result = buildCursorPrompt(ctx);
		expect(result.text).toContain("Tool result (bash, call tc1): output here");
	});

	it("formats tool errors", () => {
		const ctx: Context = {
			messages: [
				{ role: "user", content: "Run it", timestamp: 1 } satisfies UserMessage,
				{
					role: "toolResult",
					toolCallId: "tc1",
					toolName: "bash",
					content: [{ type: "text", text: "command failed" }],
					isError: true,
					timestamp: 2,
				} satisfies ToolResultMessage,
			],
		};
		const result = buildCursorPrompt(ctx);
		expect(result.text).toContain("Tool error (bash, call tc1): command failed");
	});

	it("labels legacy Cursor replay tools without rewriting literal transcript text", () => {
		const ctx: Context = {
			messages: [
				{
					role: "user",
					content: "Please search for the literal string cursor_edit.",
					timestamp: 0,
				} satisfies UserMessage,
				{
					role: "assistant",
					content: [
						{ type: "text", text: "I will preserve literal cursor_delete text." },
						{ type: "toolCall", id: "edit-call", name: "cursor_edit", arguments: { note: "cursor_write" } },
						{ type: "toolCall", id: "mcp-call", name: "cursor_mcp", arguments: { toolName: "git" } },
						{ type: "toolCall", id: "bash-call", name: "bash", arguments: { command: "echo cursor_mcp" } },
					],
					api: "cursor-sdk",
					provider: "cursor",
					model: "test",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "toolUse",
					timestamp: 1,
				} satisfies AssistantMessage,
				{
					role: "toolResult",
					toolCallId: "edit-call",
					toolName: "cursor_edit",
					content: [{ type: "text", text: "legacy cursor_edit result" }],
					isError: false,
					timestamp: 2,
				} satisfies ToolResultMessage,
				{
					role: "toolResult",
					toolCallId: "write-call",
					toolName: "cursor_write",
					content: [{ type: "text", text: "legacy cursor_mcp text" }],
					isError: false,
					timestamp: 3,
				} satisfies ToolResultMessage,
			],
		};

		const result = buildCursorPrompt(ctx);

		expect(result.text).toContain("User: Please search for the literal string cursor_edit.");
		expect(result.text).toContain("Assistant: I will preserve literal cursor_delete text.");
		expect(result.text).toContain("Tool call (Cursor edit, call edit-call)");
		expect(result.text).toContain('{"note":"cursor_write"}');
		expect(result.text).toContain("Tool call (Cursor MCP, call mcp-call):");
		expect(result.text).toContain('Tool call (bash, call bash-call): {"command":"echo cursor_mcp"}');
		expect(result.text).toContain("Tool result (Cursor edit, call edit-call): legacy cursor_edit result");
		expect(result.text).toContain("Tool result (Cursor write, call write-call): legacy cursor_mcp text");
		expect(result.text).not.toContain("Tool call (cursor_edit");
		expect(result.text).not.toContain("Tool call (cursor_mcp");
		expect(result.text).not.toContain("Tool result (cursor_write");
	});

	it("formats assistant tool calls before tool results", () => {
		const ctx: Context = {
			messages: [
				{ role: "user", content: "List files", timestamp: 1 } satisfies UserMessage,
				{
					role: "assistant",
					content: [
						{ type: "text", text: "I will inspect the directory." },
						{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: "ls" } },
					],
					api: "cursor-sdk",
					provider: "cursor",
					model: "test",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "toolUse",
					timestamp: 2,
				} satisfies AssistantMessage,
				{
					role: "toolResult",
					toolCallId: "tc1",
					toolName: "bash",
					content: [{ type: "text", text: "README.md" }],
					isError: false,
					timestamp: 3,
				} satisfies ToolResultMessage,
			],
		};
		const result = buildCursorPrompt(ctx);
		expect(result.text).toContain("Assistant: I will inspect the directory.\nTool call (bash, call tc1): {\"command\":\"ls\"}");
		expect(result.text).toContain("Tool result (bash, call tc1): README.md");
	});

	it("extracts images from latest user message only", () => {
		const ctx: Context = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "Look at this" },
						{ type: "image", data: "oldbase64", mimeType: "image/png" },
					],
					timestamp: 1,
				} satisfies UserMessage,
				{
					role: "user",
					content: [
						{ type: "text", text: "And this one" },
						{ type: "image", data: "newbase64", mimeType: "image/jpeg" },
					],
					timestamp: 2,
				} satisfies UserMessage,
			],
		};
		const result = buildCursorPrompt(ctx);
		expect(result.images).toHaveLength(1);
		expect(result.images[0]).toEqual({ data: "newbase64", mimeType: "image/jpeg" });
	});

	it("explains that only latest user images are available as image bytes", () => {
		const result = buildCursorPrompt({ messages: [{ role: "user", content: "test", timestamp: 1 }] });
		expect(result.text).toContain("only latest user images are sent");
		expect(result.text).toContain("ask to reattach or describe prior images");
	});

	it("replaces historical images with placeholder text", () => {
		const ctx: Context = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "First" },
						{ type: "image", data: "abc", mimeType: "image/png" },
					],
					timestamp: 1,
				} satisfies UserMessage,
				{
					role: "user",
					content: "Second",
					timestamp: 2,
				} satisfies UserMessage,
			],
		};
		const result = buildCursorPrompt(ctx);
		expect(result.text).toContain("[image omitted from transcript]");
		expect(result.images).toHaveLength(0);
	});

	it("budgets transcript history while preserving system prompt and latest user request", () => {
		const ctx: Context = {
			systemPrompt: "Always preserve this system instruction.",
			messages: [
				{ role: "user", content: `old request ${"x".repeat(200)}`, timestamp: 1 } satisfies UserMessage,
				{
					role: "assistant",
					content: [{ type: "text", text: `old answer ${"y".repeat(200)}` }],
					api: "cursor-sdk",
					provider: "cursor",
					model: "test",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "stop",
					timestamp: 2,
				} satisfies AssistantMessage,
				{ role: "user", content: "latest request must stay", timestamp: 3 } satisfies UserMessage,
			],
		};

		const result = buildCursorPrompt(ctx, { maxInputTokens: 120, charsPerToken: 1 });

		expect(result.text).toContain("Always preserve this system instruction.");
		expect(result.text).toContain("User: latest request must stay");
		expect(result.text).toContain("Answer the latest user request");
		expect(result.text).toContain("[Earlier transcript omitted: 2 messages to fit Cursor context budget]");
		expect(result.text).not.toContain("old request");
		expect(result.text).not.toContain("old answer");
	});

	it("keeps recent transcript messages that fit the budget", () => {
		const ctx: Context = {
			messages: [
				{ role: "user", content: `old request ${"x".repeat(3000)}`, timestamp: 1 } satisfies UserMessage,
				{ role: "user", content: "recent request", timestamp: 2 } satisfies UserMessage,
				{
					role: "toolResult",
					toolCallId: "tc1",
					toolName: "bash",
					content: [{ type: "text", text: "recent tool output" }],
					isError: false,
					timestamp: 3,
				} satisfies ToolResultMessage,
				{ role: "user", content: "latest request", timestamp: 4 } satisfies UserMessage,
			],
		};

		const result = buildCursorPrompt(ctx, { maxInputTokens: 1500, charsPerToken: 1 });

		expect(result.text).toContain("User: latest request");
		expect(result.text).toContain("User: recent request");
		expect(result.text).toContain("Tool result (bash, call tc1): recent tool output");
		expect(result.text).not.toContain("old request");
	});

	it("omits oversized old tool results before older text that still fits", () => {
		const ctx: Context = {
			messages: [
				{
					role: "toolResult",
					toolCallId: "tc1",
					toolName: "bash",
					content: [{ type: "text", text: `large output ${"z".repeat(1200)}` }],
					isError: false,
					timestamp: 1,
				} satisfies ToolResultMessage,
				{ role: "user", content: "recent request", timestamp: 2 } satisfies UserMessage,
				{ role: "user", content: "latest request", timestamp: 3 } satisfies UserMessage,
			],
		};

		const result = buildCursorPrompt(ctx, { maxInputTokens: 1150, charsPerToken: 1 });

		expect(result.text).toContain("User: latest request");
		expect(result.text).toContain("User: recent request");
		expect(result.text).toContain("[Earlier transcript omitted: 1 message to fit Cursor context budget]");
		expect(result.text).not.toContain("large output");
	});

	it("appends answer instruction", () => {
		const ctx: Context = {
			messages: [{ role: "user", content: "test", timestamp: 1 }],
		};
		const result = buildCursorPrompt(ctx);
		expect(result.text).toContain("Answer the latest user request");
	});

	it("instructs Cursor not to claim web search without an actual Cursor web tool", () => {
		const ctx: Context = {
			systemPrompt: "You can use WebSearch and WebFetch.",
			messages: [{ role: "user", content: "search the web for Cursor SDK best practices", timestamp: 1 }],
		};
		const result = buildCursorPrompt(ctx);
		expect(result.text.indexOf("Cursor SDK tool boundary:")).toBeLessThan(result.text.indexOf("System instructions from pi:"));
		expect(result.text).toContain("Pi tool names, replay tool names, and transcript tool names are context only");
		expect(result.text).toContain("do not claim access to pi-side tools from the system prompt");
		expect(result.text).toContain("do not claim WebSearch/WebFetch unless Cursor executes them");
		expect(result.text).not.toContain("do not use SwitchMode");
		expect(result.text).not.toContain("do not execute every Cursor tool");
		expect(result.text).toContain("replay is display-only and not a capability to invoke");
		expect(result.text).toContain("use Cursor web/search/browser/MCP or say web search is not configured");
	});
});
