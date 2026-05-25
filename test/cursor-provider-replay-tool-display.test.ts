import { describe, it, expect, vi, beforeEach } from "vitest";
import { Type } from "typebox";
import {
	resetCursorProviderTestState,
	mockedCreate,
	mockedCreateAgentPlatform,
	makeModel,
	makeContext,
	makeAssistantMessage,
	collectEvents,
	collectTextDeltas,
	collectThinkingDeltas,
	getEventsOfType,
	getDoneEvent,
	getErrorEvent,
	getTextEndEvent,
	hasEventType,
	isToolCallBlock,
	isCursorToolStreamEvent,
	getCreatedAgentOptions,
	createMockAgentPlatform,
	registerBridgeForProviderTest,
	registerNativeToolDisplayForTest,
	connectMcpClient,
	createBuiltinToolInfo,
	createBridgeToolInfo,
	cursorModelItems,
	type CursorDeltaHandler,
	type CursorStepHandler,
	type RegisteredTool,
} from "./helpers/cursor-provider-harness.js";
import { streamCursor, __testUtils as cursorProviderTestUtils } from "../src/cursor-provider.js";
import { estimateCursorPromptMessageTokens } from "../src/context.js";
import { __testUtils as nativeToolDisplayTestUtils } from "../src/cursor-native-tool-display.js";
import type { Context } from "@earendil-works/pi-ai";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";


describe("streamCursor native replay tool display", () => {
	beforeEach(resetCursorProviderTestState);

it("replays Cursor grep activity through native grep display", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const registeredTools: RegisteredTool[] = [];
		await registerNativeToolDisplayForTest(registeredTools);

		let resolveRun: (result: { id: string; status: "finished"; result: string }) => void = () => {};
		const runWait = vi.fn(
			() =>
				new Promise<{ id: string; status: "finished"; result: string }>((resolve) => {
					resolveRun = resolve;
				}),
		);
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({
				update: {
					type: "tool-call-started",
					toolCall: { type: "grep", args: { pattern: "sem_reindex", path: "src" } },
					callId: "c1",
				},
			});
			opts.onDelta({
				update: {
					type: "tool-call-completed",
					toolCall: {
						type: "grep",
						args: { pattern: "sem_reindex", path: "src" },
						result: {
							status: "success",
							value: {
								workspaceResults: {
									src: {
										type: "files",
										output: { files: ["src/tools/reindex.ts"] },
									},
								},
							},
						},
					},
					callId: "c1",
				},
			});
			return {
				id: "run-1",
				agentId: "agent-1",
				status: "running",
				wait: runWait,
				cancel: vi.fn(),
				supports: () => true,
				unsupportedReason: () => undefined,
			};
		});
		mockedCreate.mockResolvedValue({
			agentId: "agent-1",
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const firstEvents = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		const firstDone = getDoneEvent(firstEvents);
		const toolCall = firstDone.message.content.find(isToolCallBlock);
		const trace = collectThinkingDeltas(firstEvents);

		expect(firstDone.reason).toBe("toolUse");
		expect(toolCall.name).toBe("grep");
		expect(toolCall.arguments).toEqual({ pattern: "sem_reindex", path: "src" });
		expect(trace).not.toContain("src/tools/reindex.ts");

		const grepTool = registeredTools.find((tool) => tool.name === "grep");
		const toolResult = await grepTool!.execute(toolCall.id, toolCall.arguments, undefined, undefined, {});
		expect(toolResult.content[0].text).toContain("src/tools/reindex.ts");

		resolveRun({ id: "run-1", status: "finished", result: "Done." });

		const replayContext = makeContext();
		replayContext.messages = [
			...replayContext.messages,
			firstDone.message,
			{
				role: "toolResult",
				toolCallId: toolCall.id,
				toolName: "grep",
				content: toolResult.content,
				details: toolResult.details,
				isError: false,
				timestamp: 2,
			},
		];
		await collectEvents(streamCursor(makeModel(), replayContext, { apiKey: "test-key" }));
	});

	it("replays Cursor web search MCP activity through neutral cursor activity cards", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const registeredTools: RegisteredTool[] = [];
		await registerNativeToolDisplayForTest(registeredTools);

		let resolveRun: (result: { id: string; status: "finished"; result: string }) => void = () => {};
		const runWait = vi.fn(
			() =>
				new Promise<{ id: string; status: "finished"; result: string }>((resolve) => {
					resolveRun = resolve;
				}),
		);
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({
				update: {
					type: "tool-call-started",
					toolCall: { type: "mcp", args: { toolName: "WebSearch", args: { search_term: "pi mathematics" } } },
					callId: "web-1",
				},
			});
			opts.onDelta({
				update: {
					type: "tool-call-completed",
					toolCall: {
						type: "mcp",
						args: { toolName: "WebSearch", args: { search_term: "pi mathematics" } },
						result: {
							status: "success",
							value: { content: [{ text: { text: "Pi - Wikipedia\nhttps://en.wikipedia.org/wiki/Pi" } }], isError: false },
						},
					},
					callId: "web-1",
				},
			});
			return {
				id: "run-1",
				agentId: "agent-1",
				status: "running",
				wait: runWait,
				cancel: vi.fn(),
				supports: () => true,
				unsupportedReason: () => undefined,
			};
		});
		mockedCreate.mockResolvedValue({
			agentId: "agent-1",
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const firstEvents = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		const firstDone = getDoneEvent(firstEvents);
		const toolCall = firstDone.message.content.find(isToolCallBlock);
		const trace = collectThinkingDeltas(firstEvents);

		expect(firstDone.reason).toBe("toolUse");
		expect(toolCall.name).toBe("cursor");
		expect(toolCall.arguments).toMatchObject({
			query: "pi mathematics",
			activityTitle: "Cursor web search",
			activitySummary: "pi mathematics",
		});
		expect(trace).not.toContain("Wikipedia");

		const cursorTool = registeredTools.find((tool) => tool.name === "cursor");
		const toolResult = await cursorTool!.execute(toolCall.id, toolCall.arguments, undefined, undefined, {});
		expect(toolResult.content[0].text).toContain("Pi - Wikipedia");

		resolveRun({ id: "run-1", status: "finished", result: "Done." });

		const replayContext = makeContext();
		replayContext.messages = [
			...replayContext.messages,
			firstDone.message,
			{
				role: "toolResult",
				toolCallId: toolCall.id,
				toolName: "cursor",
				content: toolResult.content,
				details: toolResult.details,
				isError: false,
				timestamp: 2,
			},
		];
		await collectEvents(streamCursor(makeModel(), replayContext, { apiKey: "test-key" }));
		expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(0);
	});

	it("replays path-only Cursor edit activity through neutral recorded cursor output without pi edit validation", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const registeredTools: RegisteredTool[] = [];
		await registerNativeToolDisplayForTest(registeredTools);
		const dir = mkdtempSync(join(tmpdir(), "cursor-edit-replay-"));
		const targetPath = join(dir, ".tool-demo-temp.txt");
		writeFileSync(targetPath, "old\n");

		try {
			let resolveRun: (result: { id: string; status: "finished"; result: string }) => void = () => {};
			const runWait = vi.fn(
				() =>
					new Promise<{ id: string; status: "finished"; result: string }>((resolve) => {
						resolveRun = resolve;
					}),
			);
			const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				opts.onDelta({ update: { type: "tool-call-started", toolCall: { type: "edit", args: { path: targetPath } }, callId: "c1" } });
				opts.onDelta({
					update: {
						type: "tool-call-completed",
						toolCall: {
							type: "edit",
							args: { path: targetPath },
							result: {
								status: "success",
								value: { linesAdded: 1, linesRemoved: 1, diffString: `--- a/${targetPath}\n+++ b/${targetPath}` },
							},
						},
						callId: "c1",
					},
				});
				return {
					id: "run-1",
					agentId: "agent-1",
					status: "running",
					wait: runWait,
					cancel: vi.fn(),
					supports: () => true,
					unsupportedReason: () => undefined,
				};
			});
			mockedCreate.mockResolvedValue({
				agentId: "agent-1",
				send: mockSend,
				[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
			});

			const firstEvents = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
			const firstDone = getDoneEvent(firstEvents);
			const toolCall = firstDone.message.content.find(isToolCallBlock);

			expect(toolCall.name).toBe("cursor");
			expect(toolCall.arguments).toMatchObject({ path: targetPath });
			expect(toolCall.arguments).not.toHaveProperty("edits");
			const cursorTool = registeredTools.find((tool) => tool.name === "cursor");
			expect(cursorTool).toBeDefined();
			const toolResult = await cursorTool!.execute(toolCall.id, toolCall.arguments, undefined, undefined, {});
			expect(toolResult).toMatchObject({
				content: [{ type: "text", text: expect.stringContaining(`edit ${targetPath}`) }],
				details: { cursorToolName: "edit", title: "Cursor edit", summary: targetPath, diff: `--- a/${targetPath}\n+++ b/${targetPath}` },
				terminate: false,
			});
			expect(toolResult.content[0].text).not.toContain("Validation failed for tool \"edit\"");
			expect(readFileSync(targetPath, "utf-8")).toBe("old\n");

			const editTool = registeredTools.find((tool) => tool.name === "edit");
			expect(editTool).toBeDefined();
			await expect(
				editTool!.execute(
					"cursor-replay-1-1-tool-999",
					{ path: targetPath, edits: [{ oldText: "old\n", newText: "mutated\n" }] },
					undefined,
					undefined,
					{},
				),
			).rejects.toThrow("replay-only call does not execute file mutations");
			expect(readFileSync(targetPath, "utf-8")).toBe("old\n");

			resolveRun({ id: "run-1", status: "finished", result: "Done." });

			const replayContext = makeContext();
			replayContext.messages = [
				...replayContext.messages,
				firstDone.message,
				{
					role: "toolResult",
					toolCallId: toolCall.id,
					toolName: "cursor",
					content: toolResult.content,
					details: toolResult.details,
					isError: false,
					timestamp: 2,
				},
			];
			const replayEvents = await collectEvents(streamCursor(makeModel(), replayContext, { apiKey: "test-key" }));
			const replayText = collectTextDeltas(replayEvents);
			expect(replayText).toBe("Done.");
			expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("replays path-only Cursor write activity through neutral recorded cursor output without pi write validation", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const registeredTools: RegisteredTool[] = [];
		await registerNativeToolDisplayForTest(registeredTools);
		const dir = mkdtempSync(join(tmpdir(), "cursor-write-path-only-replay-"));
		const targetPath = join(dir, "recorded-write.txt");
		writeFileSync(targetPath, "old\n");

		try {
			let resolveRun: (result: { id: string; status: "finished"; result: string }) => void = () => {};
			const runWait = vi.fn(
				() =>
					new Promise<{ id: string; status: "finished"; result: string }>((resolve) => {
						resolveRun = resolve;
					}),
			);
			const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				opts.onDelta({
					update: { type: "tool-call-started", toolCall: { type: "write", args: { path: targetPath } }, callId: "c1" },
				});
				opts.onDelta({
					update: {
						type: "tool-call-completed",
						toolCall: {
							type: "write",
							args: { path: targetPath },
							result: {
								status: "success",
								value: { linesCreated: 1, fileSize: 4 },
							},
						},
						callId: "c1",
					},
				});
				return {
					id: "run-1",
					agentId: "agent-1",
					status: "running",
					wait: runWait,
					cancel: vi.fn(),
					supports: () => true,
					unsupportedReason: () => undefined,
				};
			});
			mockedCreate.mockResolvedValue({
				agentId: "agent-1",
				send: mockSend,
				[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
			});

			const firstEvents = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
			const firstDone = getDoneEvent(firstEvents);
			const toolCall = firstDone.message.content.find(isToolCallBlock);

			expect(toolCall.name).toBe("cursor");
			expect(toolCall.arguments).toMatchObject({ path: targetPath, activityTitle: "Cursor write", activitySummary: targetPath });
			expect(toolCall.arguments).not.toHaveProperty("content");
			const cursorTool = registeredTools.find((tool) => tool.name === "cursor");
			expect(cursorTool).toBeDefined();
			const toolResult = await cursorTool!.execute(toolCall.id, toolCall.arguments, undefined, undefined, {});
			expect(toolResult).toMatchObject({
				content: [{ type: "text", text: expect.stringContaining(`write ${targetPath}`) }],
				details: { cursorToolName: "write", title: "Cursor write", path: targetPath },
				terminate: false,
			});
			expect(toolResult.content[0].text).not.toContain("Validation failed for tool \"write\"");
			expect(readFileSync(targetPath, "utf-8")).toBe("old\n");

			resolveRun({ id: "run-1", status: "finished", result: "Done." });

			const replayContext = makeContext();
			replayContext.messages = [
				...replayContext.messages,
				firstDone.message,
				{
					role: "toolResult",
					toolCallId: toolCall.id,
					toolName: "cursor",
					content: toolResult.content,
					details: toolResult.details,
					isError: false,
					timestamp: 2,
				},
			];
			const replayEvents = await collectEvents(streamCursor(makeModel(), replayContext, { apiKey: "test-key" }));
			const replayText = collectTextDeltas(replayEvents);
			expect(replayText).toBe("Done.");
			expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("replays Cursor StrReplace through schema-valid recorded edit output without mutating files", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const registeredTools: RegisteredTool[] = [];
		await registerNativeToolDisplayForTest(registeredTools);
		const dir = mkdtempSync(join(tmpdir(), "cursor-strreplace-replay-"));
		const targetPath = join(dir, "recorded-edit.txt");
		writeFileSync(targetPath, "old\n");

		try {
			let resolveRun: (result: { id: string; status: "finished"; result: string }) => void = () => {};
			const runWait = vi.fn(
				() =>
					new Promise<{ id: string; status: "finished"; result: string }>((resolve) => {
						resolveRun = resolve;
					}),
			);
			const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				opts.onDelta({
					update: {
						type: "tool-call-started",
						toolCall: { type: "StrReplace", args: { path: targetPath, old_string: "old\n", new_string: "new\n" } },
						callId: "c1",
					},
				});
				opts.onDelta({
					update: {
						type: "tool-call-completed",
						toolCall: {
							type: "StrReplace",
							args: { path: targetPath, old_string: "old\n", new_string: "new\n" },
							result: {
								status: "success",
								value: { linesAdded: 1, linesRemoved: 1, diffString: `--- a/${targetPath}\n+++ b/${targetPath}\n@@ -1 +1 @@\n-old\n+new` },
							},
						},
						callId: "c1",
					},
				});
				return {
					id: "run-1",
					agentId: "agent-1",
					status: "running",
					wait: runWait,
					cancel: vi.fn(),
					supports: () => true,
					unsupportedReason: () => undefined,
				};
			});
			mockedCreate.mockResolvedValue({
				agentId: "agent-1",
				send: mockSend,
				[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
			});

			const firstEvents = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
			const firstDone = getDoneEvent(firstEvents);
			const toolCall = firstDone.message.content.find(isToolCallBlock);

			expect(toolCall.name).toBe("edit");
			expect(toolCall.arguments).toEqual({ path: targetPath, edits: [{ oldText: "old\n", newText: "new\n" }] });
			const editTool = registeredTools.find((tool) => tool.name === "edit");
			expect(editTool).toBeDefined();
			const toolResult = await editTool!.execute(toolCall.id, toolCall.arguments, undefined, undefined, {});
			expect(toolResult).toMatchObject({
				content: [{ type: "text", text: expect.stringContaining(`edit ${targetPath}`) }],
				details: { cursorToolName: "edit", diff: expect.stringContaining("-old") },
				terminate: false,
			});
			expect(readFileSync(targetPath, "utf-8")).toBe("old\n");

			resolveRun({ id: "run-1", status: "finished", result: "Done." });

			const replayContext = makeContext();
			replayContext.messages = [
				...replayContext.messages,
				firstDone.message,
				{
					role: "toolResult",
					toolCallId: toolCall.id,
					toolName: "edit",
					content: toolResult.content,
					details: toolResult.details,
					isError: false,
					timestamp: 2,
				},
			];
			const replayEvents = await collectEvents(streamCursor(makeModel(), replayContext, { apiKey: "test-key" }));
			const replayText = collectTextDeltas(replayEvents);
			expect(replayText).toBe("Done.");
			expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("replays Cursor write activity through native-looking recorded write output without mutating files", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const registeredTools: RegisteredTool[] = [];
		await registerNativeToolDisplayForTest(registeredTools);
		const dir = mkdtempSync(join(tmpdir(), "cursor-write-replay-"));
		const targetPath = join(dir, "recorded-write.txt");
		writeFileSync(targetPath, "old\n");

		try {
			let resolveRun: (result: { id: string; status: "finished"; result: string }) => void = () => {};
			const runWait = vi.fn(
				() =>
					new Promise<{ id: string; status: "finished"; result: string }>((resolve) => {
						resolveRun = resolve;
					}),
			);
			const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				opts.onDelta({
					update: { type: "tool-call-started", toolCall: { type: "write", args: { path: targetPath, content: "new\n" } }, callId: "c1" },
				});
				opts.onDelta({
					update: {
						type: "tool-call-completed",
						toolCall: {
							type: "write",
							args: { path: targetPath, content: "new\n" },
							result: {
								status: "success",
								value: { linesCreated: 1, fileSize: 4, fileContentAfterWrite: "new\n" },
							},
						},
						callId: "c1",
					},
				});
				return {
					id: "run-1",
					agentId: "agent-1",
					status: "running",
					wait: runWait,
					cancel: vi.fn(),
					supports: () => true,
					unsupportedReason: () => undefined,
				};
			});
			mockedCreate.mockResolvedValue({
				agentId: "agent-1",
				send: mockSend,
				[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
			});

			const firstEvents = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
			const firstDone = getDoneEvent(firstEvents);
			const toolCall = firstDone.message.content.find(isToolCallBlock);

			expect(toolCall.name).toBe("write");
			expect(toolCall.name).not.toContain("cursor");
			expect(toolCall.arguments).toEqual({ path: targetPath, content: "new\n" });
			const writeTool = registeredTools.find((tool) => tool.name === "write");
			expect(writeTool).toBeDefined();
			const toolResult = await writeTool!.execute(toolCall.id, toolCall.arguments, undefined, undefined, {});
			expect(toolResult).toMatchObject({
				content: [{ type: "text", text: expect.stringContaining(`write ${targetPath}`) }],
				details: { cursorToolName: "write", fileContentAfterWrite: "new\n" },
				terminate: false,
			});
			expect(readFileSync(targetPath, "utf-8")).toBe("old\n");

			await expect(
				writeTool!.execute("cursor-replay-1-1-tool-998", { path: targetPath, content: "mutated\n" }, undefined, undefined, {}),
			).rejects.toThrow("replay-only call does not execute file mutations");
			expect(readFileSync(targetPath, "utf-8")).toBe("old\n");

			resolveRun({ id: "run-1", status: "finished", result: "Done." });

			const replayContext = makeContext();
			replayContext.messages = [
				...replayContext.messages,
				firstDone.message,
				{
					role: "toolResult",
					toolCallId: toolCall.id,
					toolName: "write",
					content: toolResult.content,
					details: toolResult.details,
					isError: false,
					timestamp: 2,
				},
			];
			const replayEvents = await collectEvents(streamCursor(makeModel(), replayContext, { apiKey: "test-key" }));
			const replayText = collectTextDeltas(replayEvents);
			expect(replayText).toBe("Done.");
			expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
