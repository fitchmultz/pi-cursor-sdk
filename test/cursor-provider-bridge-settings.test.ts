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
	asMockSdkAgent,
	asMockCursorRun,
	getPiToolsMcpUrlFromAgentCreateOptions,
} from "./helpers/cursor-provider-harness.js";
import { streamCursor, __testUtils as cursorProviderTestUtils } from "../src/cursor-provider.js";
import { estimateCursorPromptMessageTokens } from "../src/context.js";
import { __testUtils as sessionAgentTestUtils } from "../src/cursor-session-agent.js";
import { __testUtils as cursorPiToolBridgeTestUtils } from "../src/cursor-pi-tool-bridge.js";
import { __testUtils as nativeToolDisplayTestUtils } from "../src/cursor-native-tool-display-state.js";
import type { Context } from "@earendil-works/pi-ai/compat";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";



describe("streamCursor bridge settings", () => {
	beforeEach(resetCursorProviderTestState);

	it("loads all Cursor setting sources by default for ambient MCP/tools", async () => {
		const mockSend = vi.fn().mockResolvedValue({
			id: "run-1",
			agentId: "agent-1",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		});
		mockCreatedAgent({
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(makeModel("composer-2"), makeContext(), { apiKey: "test-key" });
		await collectEvents(stream);

		expect(mockedCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				local: expect.objectContaining({ cwd: process.cwd(), settingSources: ["all"], store: expect.any(Object) }),
			}),
		);
	});

	it("allows Cursor setting sources to be disabled", async () => {
		process.env.PI_CURSOR_SETTING_SOURCES = "none";
		const mockSend = vi.fn().mockResolvedValue({
			id: "run-1",
			agentId: "agent-1",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		});
		mockCreatedAgent({
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(makeModel("composer-2"), makeContext(), { apiKey: "test-key" });
		await collectEvents(stream);

		expect(mockedCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				local: expect.objectContaining({ cwd: process.cwd(), store: expect.any(Object) }),
			}),
		);
	});

	it("allows Cursor setting sources to be explicitly enabled", async () => {
		process.env.PI_CURSOR_SETTING_SOURCES = "all";
		const mockSend = vi.fn().mockResolvedValue({
			id: "run-1",
			agentId: "agent-1",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		});
		mockCreatedAgent({
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(makeModel("composer-2"), makeContext(), { apiKey: "test-key" });
		await collectEvents(stream);

		expect(mockedCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				local: expect.objectContaining({ cwd: process.cwd(), settingSources: ["all"], store: expect.any(Object) }),
			}),
		);
	});

	it("suppresses all direct Cursor SDK startup writes when setting sources are enabled", async () => {
		process.env.PI_CURSOR_SETTING_SOURCES = "all";
		const stdoutChunks: string[] = [];
		const stderrChunks: string[] = [];
		const originalStdoutWrite = process.stdout.write;
		const originalStderrWrite = process.stderr.write;
		const createCollector = (chunks: string[]) =>
			((
				chunk: string | Uint8Array,
				encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
				callback?: (error?: Error | null) => void,
			): boolean => {
				chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
				const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
				done?.();
				return true;
			}) as typeof process.stdout.write;
		process.stdout.write = createCollector(stdoutChunks);
		process.stderr.write = createCollector(stderrChunks) as typeof process.stderr.write;
		const consoleSpy = vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
			process.stdout.write(`${String(message)}\n`);
		});
		const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation((message?: unknown) => {
			process.stderr.write(`${String(message)}\n`);
		});
		try {
			const mockSend = vi.fn().mockImplementation(async () => {
				process.stdout.write("VISIBLE non-startup stdout\n");
				process.stderr.write("VISIBLE non-startup stderr\n");
				console.log("VISIBLE non-startup console");
				console.warn(
					'[hooks] SessionStart trigger matcher "startup" is not supported in Cursor, hooks will fire for all triggers',
				);
				console.warn('[hooks] Tool "Glob" is not supported in Cursor and will be ignored');
				process.stdout.write('18:05:57.959 INFO  managed_skills.removed ctx=syncBuiltinSkills meta={skill_id: "clone"}\n');
				process.stderr.write('18:05:57.961 INFO  managed_skills.removed ctx=syncBuiltinSkills meta={skill_id: "cursor"}\n');
				console.log('18:05:57.962 INFO  managed_skills.removed ctx=syncBuiltinSkills meta={skill_id: "cursor-sdk"}');
				process.stderr.write("Error initializing ignore mapping for /tmp/project: permission denied\n");
				console.warn("Ripgrep path not configured. Call configureRipgrepPath() at startup.");
				return asMockCursorRun({
					id: "run-1",
					agentId: "agent-1",
					status: "finished",
					wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
					cancel: vi.fn(),
					supports: () => true,
					unsupportedReason: () => undefined,
				});
			});
			mockedCreate.mockImplementationOnce(async () => {
				process.stdout.write('INFO managed_skills.removed meta={skill_id:"clone"}\n');
				process.stderr.write("INFO managed_skills.removed stderr\n");
				console.log("INFO managed_skills.removed via console");
				process.stdout.write("UNEXPECTED startup stdout with test-key\n");
				process.stderr.write("UNEXPECTED startup stderr with test-key\n");
				console.log("UNEXPECTED startup console with test-key");
				return asMockSdkAgent({
					agentId: "agent-1",
					send: mockSend,
					[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
				});
			});

			await collectEvents(streamCursor(makeModel("composer-2"), makeContext(), { apiKey: "test-key" }));
		} finally {
			process.stdout.write = originalStdoutWrite;
			process.stderr.write = originalStderrWrite;
		}

		expect(stdoutChunks.join("")).not.toContain("[hooks]");
		expect(stderrChunks.join("")).not.toContain("[hooks]");
		expect(stdoutChunks.join("")).not.toContain("Error initializing ignore mapping for");
		expect(stderrChunks.join("")).not.toContain("Error initializing ignore mapping for");
		expect(stdoutChunks.join("")).not.toContain("Ripgrep path not configured");
		expect(stderrChunks.join("")).not.toContain("Ripgrep path not configured");
		expect(stdoutChunks.join("")).not.toContain("managed_skills.removed");
		expect(stderrChunks.join("")).not.toContain("managed_skills.removed");
		expect(stdoutChunks.join("")).not.toContain("UNEXPECTED startup");
		expect(stderrChunks.join("")).not.toContain("UNEXPECTED startup");
		expect(stdoutChunks.join("")).not.toContain("test-key");
		expect(stderrChunks.join("")).not.toContain("test-key");
		expect(stdoutChunks.join("")).toContain("VISIBLE non-startup stdout");
		expect(stdoutChunks.join("")).toContain("VISIBLE non-startup console");
		expect(stderrChunks.join("")).toContain("VISIBLE non-startup stderr");
		expect(consoleSpy).not.toHaveBeenCalledWith("INFO managed_skills.removed via console");
		expect(consoleSpy).not.toHaveBeenCalledWith("UNEXPECTED startup console with test-key");
		expect(consoleSpy).not.toHaveBeenCalledWith('18:05:57.962 INFO  managed_skills.removed ctx=syncBuiltinSkills meta={skill_id: "cursor-sdk"}');
		expect(consoleSpy).toHaveBeenCalledWith("VISIBLE non-startup console");
		expect(consoleWarnSpy).not.toHaveBeenCalledWith(
			'[hooks] SessionStart trigger matcher "startup" is not supported in Cursor, hooks will fire for all triggers',
		);
		expect(consoleWarnSpy).not.toHaveBeenCalledWith('[hooks] Tool "Glob" is not supported in Cursor and will be ignored');
		consoleSpy.mockRestore();
		consoleWarnSpy.mockRestore();
	});

	it("allows Cursor setting sources to be narrowed", async () => {
		process.env.PI_CURSOR_SETTING_SOURCES = "project,user";
		const mockSend = vi.fn().mockResolvedValue({
			id: "run-1",
			agentId: "agent-1",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		});
		mockCreatedAgent({
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(makeModel("composer-2"), makeContext(), { apiKey: "test-key" });
		await collectEvents(stream);

		expect(mockedCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				local: expect.objectContaining({ cwd: process.cwd(), settingSources: ["project", "user"], store: expect.any(Object) }),
			}),
		);
	});
});
