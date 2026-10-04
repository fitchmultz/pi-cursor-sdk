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
	createTestToolInfo,
	cursorModelItems,
	type CursorDeltaHandler,
	type CursorStepHandler,
	type RegisteredTool,
	mockCreatedAgent,
	asMockCursorRun,
	getPiToolsMcpUrlFromAgentCreateOptions,
	createExtensionTestContext} from "./helpers/cursor-provider-harness.js";
import { streamCursor } from "./helpers/cursor-provider-ownership.js";
import { __testUtils as cursorProviderTestUtils } from "../src/cursor-provider.js";
import { estimateCursorPromptMessageTokens } from "../src/context.js";
import { __testUtils as nativeToolDisplayTestUtils } from "../src/cursor-native-tool-display-state.js";
import type { Context } from "@earendil-works/pi-ai";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";


describe("streamCursor native replay shell output", () => {
	beforeEach(resetCursorProviderTestState);

it("uses Cursor shell-output-delta as display-only fallback when completed shell output is empty", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const registeredTools: RegisteredTool[] = [];
		await registerNativeToolDisplayForTest(registeredTools);

		const command = 'sleep 2 && echo "background job done"';
		let resolveRun: (result: { id: string; status: "finished"; result: string }) => void = () => {};
		const runWait = vi.fn(
			() =>
				new Promise<{ id: string; status: "finished"; result: string }>((resolve) => {
					resolveRun = resolve;
				}),
		);
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { toolName: "run_terminal_cmd", args: { command } }, callId: "shell-1" } });
			opts.onDelta({ update: { type: "shell-output-delta", event: { case: "stdout", value: { data: "background job done\n" } } } });
			opts.onDelta({
				update: {
					type: "tool-call-completed",
					toolCall: {
						toolName: "run_terminal_cmd",
						result: { status: "success", value: { stdout: "", stderr: "", exitCode: 0, executionTime: 2015 } },
					},
					callId: "shell-1",
				},
			});
			return asMockCursorRun({
				id: "run-1",
				agentId: "agent-1",
				status: "running",
				wait: runWait,
				cancel: vi.fn(),
				supports: () => true,
				unsupportedReason: () => undefined,
			});
		});
		mockCreatedAgent({
			agentId: "agent-1",
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const firstEvents = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		const firstDone = getDoneEvent(firstEvents);
		const toolCall = firstDone.message.content.find(isToolCallBlock);

		expect(collectThinkingDeltas(firstEvents)).toContain("Cursor shell stdout: background job done");
		expect(firstDone.reason).toBe("toolUse");
		expect(toolCall!.name).toBe("bash");
		expect(toolCall!.arguments).toEqual({ command });

		const bashTool = registeredTools.find((tool) => tool.name === "bash");
		const toolResult = await bashTool!.execute(toolCall!.id, toolCall!.arguments, undefined, undefined, createExtensionTestContext());
		expect(toolResult).toMatchObject({
			content: [{ type: "text", text: "background job done" }],
			terminate: false,
		});

		resolveRun({ id: "run-1", status: "finished", result: "Done." });
		const replayContext = makeContext();
		replayContext.messages = [
			...replayContext.messages,
			firstDone.message,
			{
				role: "toolResult",
				toolCallId: toolCall!.id,
				toolName: "bash",
				content: toolResult.content,
				details: toolResult.details,
				isError: false,
				timestamp: 2,
			},
		];

		const replayEvents = await collectEvents(streamCursor(makeModel(), replayContext, { apiKey: "test-key" }));
		const replayText = collectTextDeltas(replayEvents);
		expect(replayText).toBe("Done.");
	});

	it("drops shell-output-delta fallback data when overlapping shell calls make attribution ambiguous", async () => {
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "shell", args: { command: "sleep 1" } }, callId: "shell-1" } });
			opts.onDelta({ update: { type: "shell-output-delta", event: { case: "stdout", value: { data: "partial first output\n" } } } });
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "shell", args: { command: "sleep 2" } }, callId: "shell-2" } });
			opts.onDelta({ update: { type: "shell-output-delta", event: { case: "stdout", value: { data: "ambiguous output\n" } } } });
			for (const [callId, command] of [
				["shell-1", "sleep 1"],
				["shell-2", "sleep 2"],
			] as const) {
				opts.onDelta({
					update: {
						type: "tool-call-completed",
						toolCall: {
							name: "shell",
							args: { command },
							result: { status: "success", value: { stdout: "", stderr: "", exitCode: 0, executionTime: 1 } },
						},
						callId,
					},
				});
			}
			return asMockCursorRun({
				id: "run-1",
				agentId: "agent-1",
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "Done." }),
				cancel: vi.fn(),
				supports: () => true,
				unsupportedReason: () => undefined,
			});
		});
		mockCreatedAgent({
			agentId: "agent-1",
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		const trace = collectThinkingDeltas(events);

		expect(trace).toContain("Cursor shell stdout: partial first output");
		expect(trace).toContain("$ sleep 1");
		expect(trace).toContain("$ sleep 2");
		expect(trace).not.toContain("ambiguous output");
		expect(trace.match(/\(no output\)/g)).toHaveLength(2);
	});

	it("prefers completed shell stdout over Cursor shell-output-delta fallback data", async () => {
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "shell", args: { command: "printf done" } }, callId: "shell-1" } });
			opts.onDelta({ update: { type: "shell-output-delta", event: { case: "stdout", value: { data: "delta output\n" } } } });
			opts.onDelta({
				update: {
					type: "tool-call-completed",
					toolCall: {
						name: "shell",
						result: { status: "success", value: { stdout: "completed output\n", stderr: "", exitCode: 0, executionTime: 1 } },
					},
					callId: "shell-1",
				},
			});
			return asMockCursorRun({
				id: "run-1",
				agentId: "agent-1",
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "Done." }),
				cancel: vi.fn(),
				supports: () => true,
				unsupportedReason: () => undefined,
			});
		});
		mockCreatedAgent({
			agentId: "agent-1",
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		const trace = collectThinkingDeltas(events);

		expect(trace).toContain("Cursor shell stdout: delta output");
		expect(trace).toContain("completed output");
	});
});
