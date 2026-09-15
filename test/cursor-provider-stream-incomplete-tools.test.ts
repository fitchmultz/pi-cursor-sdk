import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	resetCursorProviderTestState,
	makeModel,
	makeContext,
	collectEvents,
	collectTextDeltas,
	collectThinkingDeltas,
	hasEventType,
	type CursorDeltaHandler,
	type CursorStepHandler,
	mockCreatedAgent,
	asMockCursorRun,
} from "./helpers/cursor-provider-harness.js";
import { streamCursor } from "../src/cursor-provider.js";
import type { SendOptions } from "@cursor/sdk";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type CursorOnStepPayload = Parameters<NonNullable<SendOptions["onStep"]>>[0];


describe("streamCursor incomplete tools", () => {
	beforeEach(resetCursorProviderTestState);

		it("surfaces incomplete started Cursor tool calls with neutral activity traces", async () => {
			const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "mcp", args: { toolName: "git" } }, callId: "c1" } });
				return asMockCursorRun({
					id: "run-1",
					agentId: "agent-1",
					status: "finished",
					wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "done" }),
					cancel: vi.fn(),
					supports: () => true,
					unsupportedReason: () => undefined,
				});
			});
			mockCreatedAgent({
				send: mockSend,
				[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
			});

			const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
			const events = await collectEvents(stream);
			const trace = collectThinkingDeltas(events);
			const text = collectTextDeltas(events);

			expect(trace).toContain("Cursor MCP did not complete");
			expect(trace).toContain("missing completion");
			expect(text).toBe("done");
			expect(hasEventType(events, "toolcall_start")).toBe(false);
		});

		it("keeps a stale incomplete shell start debug-only after a successful text-producing turn", async () => {
			const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				opts.onDelta({
					update: {
						type: "tool-call-started",
						toolCall: { name: "shell", args: { command: "echo cursor-stuck-probe-ok" } },
						callId: "c-shell-stale",
					},
				});
				return asMockCursorRun({
					id: "run-1",
					agentId: "agent-1",
					status: "finished",
					wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "done" }),
					cancel: vi.fn(),
					supports: () => true,
					unsupportedReason: () => undefined,
				});
			});
			mockCreatedAgent({
				send: mockSend,
				[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
			});

			const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
			const trace = collectThinkingDeltas(events);
			expect(collectTextDeltas(events)).toBe("done");
			expect(trace).not.toContain("Cursor shell did not complete");
			expect(trace).not.toContain("missing completion");
			expect(hasEventType(events, "toolcall_start")).toBe(false);
		});

		it("still surfaces an incomplete shell start when the successful turn produced no assistant text", async () => {
			const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				opts.onDelta({
					update: { type: "tool-call-started", toolCall: { name: "shell", args: { command: "echo ok" } }, callId: "c-shell-empty" },
				});
				return asMockCursorRun({
					id: "run-1",
					agentId: "agent-1",
					status: "finished",
					wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "" }),
					cancel: vi.fn(),
					supports: () => true,
					unsupportedReason: () => undefined,
				});
			});
			mockCreatedAgent({
				send: mockSend,
				[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
			});

			const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
			expect(collectThinkingDeltas(events)).toContain("Cursor shell did not complete");
			expect(collectThinkingDeltas(events)).toContain("missing completion");
		});

		it("still surfaces an incomplete shell start after abort", async () => {
			const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				opts.onDelta({
					update: { type: "tool-call-started", toolCall: { name: "shell", args: { command: "sleep 10" } }, callId: "c-shell-abort" },
				});
				return asMockCursorRun({
					id: "run-1",
					agentId: "agent-1",
					status: "cancelled",
					wait: vi.fn().mockResolvedValue({ id: "run-1", status: "cancelled", result: "done" }),
					cancel: vi.fn(),
					supports: () => true,
					unsupportedReason: () => undefined,
				});
			});
			mockCreatedAgent({
				send: mockSend,
				[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
			});

			const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
			expect(collectThinkingDeltas(events)).toContain("Cursor shell did not complete");
			expect(collectThinkingDeltas(events)).toContain("aborted");
		});

		it("still surfaces an incomplete shell start after an SDK failure", async () => {
			const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				opts.onDelta({
					update: { type: "tool-call-started", toolCall: { name: "shell", args: { command: "echo ok" } }, callId: "c-shell-fail" },
				});
				return asMockCursorRun({
					id: "run-1",
					agentId: "agent-1",
					status: "error",
					wait: vi.fn().mockResolvedValue({ id: "run-1", status: "error", result: "sdk exploded" }),
					cancel: vi.fn(),
					supports: () => true,
					unsupportedReason: () => undefined,
				});
			});
			mockCreatedAgent({
				send: mockSend,
				[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
			});

			const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
			expect(collectThinkingDeltas(events)).toContain("Cursor shell did not complete");
			expect(collectThinkingDeltas(events)).toContain("SDK run failed");
		});

		it("surfaces incomplete Cursor web search MCP activity with a distinct label", async () => {
			const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				opts.onDelta({
					update: {
						type: "tool-call-started",
						toolCall: { name: "mcp", args: { toolName: "WebSearch", args: { search_term: "pi extension" } } },
						callId: "c1",
					},
				});
				return asMockCursorRun({
					id: "run-1",
					agentId: "agent-1",
					status: "finished",
					wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "done" }),
					cancel: vi.fn(),
					supports: () => true,
					unsupportedReason: () => undefined,
				});
			});
			mockCreatedAgent({
				send: mockSend,
				[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
			});

			const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
			const trace = collectThinkingDeltas(events);
			expect(trace).toContain("Cursor web search did not complete");
			expect(trace).not.toContain("Cursor MCP did not complete");
		});

		it("surfaces incomplete generic Cursor MCP activity", async () => {
			const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				opts.onDelta({
					update: {
						type: "tool-call-started",
						toolCall: { name: "mcp", args: { toolName: "git" } },
						callId: "c1",
					},
				});
				return asMockCursorRun({
					id: "run-1",
					agentId: "agent-1",
					status: "finished",
					wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "done" }),
					cancel: vi.fn(),
					supports: () => true,
					unsupportedReason: () => undefined,
				});
			});
			mockCreatedAgent({
				send: mockSend,
				[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
			});

			const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
			expect(collectThinkingDeltas(events)).toContain("Cursor MCP did not complete");
		});

		it("records discarded incomplete started tool calls to coordinator-events.jsonl when PI_CURSOR_SDK_EVENT_DEBUG is enabled", async () => {
			const artifactDir = mkdtempSync(join(tmpdir(), "pi-cursor-sdk-provider-discarded-debug-"));
			process.env.PI_CURSOR_SDK_EVENT_DEBUG = "1";
			process.env.PI_CURSOR_SDK_EVENT_DEBUG_RUN_DIR = artifactDir;
			const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "read", args: { path: "README.md" } }, callId: "c1" } });
				return asMockCursorRun({
					id: "run-1",
					agentId: "agent-1",
					status: "finished",
					wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "done" }),
					cancel: vi.fn(),
					supports: () => true,
					unsupportedReason: () => undefined,
				});
			});
			mockCreatedAgent({
				send: mockSend,
				[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
			});

			try {
				await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
				const coordinatorEvents = readFileSync(join(artifactDir, "coordinator-events.jsonl"), "utf8");
				expect(coordinatorEvents).toContain("discarded-incomplete-started-tool-call");
				expect(coordinatorEvents).toContain('"toolName":"read"');
				expect(coordinatorEvents).toContain('"reason":"no-completion-at-run-end"');
				expect(coordinatorEvents).not.toContain("c1");
			} finally {
				delete process.env.PI_CURSOR_SDK_EVENT_DEBUG;
				delete process.env.PI_CURSOR_SDK_EVENT_DEBUG_RUN_DIR;
				rmSync(artifactDir, { recursive: true, force: true });
			}
		});

		it("suppresses incomplete missing-file reads with final error text while keeping debug evidence", async () => {
			const artifactDir = mkdtempSync(join(tmpdir(), "pi-cursor-sdk-provider-missing-read-debug-"));
			process.env.PI_CURSOR_SDK_EVENT_DEBUG = "1";
			process.env.PI_CURSOR_SDK_EVENT_DEBUG_RUN_DIR = artifactDir;
			const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "read", args: { path: "missing.txt" } }, callId: "c-missing" } });
				return asMockCursorRun({
					id: "run-1",
					agentId: "agent-1",
					status: "finished",
					wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "Error: File not found" }),
					cancel: vi.fn(),
					supports: () => true,
					unsupportedReason: () => undefined,
				});
			});
			mockCreatedAgent({
				send: mockSend,
				[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
			});

			try {
				const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
				const trace = collectThinkingDeltas(events);
				const text = collectTextDeltas(events);
				const coordinatorEvents = readFileSync(join(artifactDir, "coordinator-events.jsonl"), "utf8");
				const displayDecisions = readFileSync(join(artifactDir, "display-decisions.jsonl"), "utf8");

				expect(text).toBe("Error: File not found");
				expect(trace).not.toContain("Cursor read did not complete");
				expect(hasEventType(events, "toolcall_start")).toBe(false);
				expect(coordinatorEvents).toContain("discarded-incomplete-started-tool-call");
				expect(coordinatorEvents).toContain('"toolName":"read"');
				expect(coordinatorEvents).not.toContain("c-missing");
				expect(displayDecisions).toContain('"action":"skip-incomplete-fast-local"');
				expect(displayDecisions).toContain('"toolName":"read"');
			} finally {
				delete process.env.PI_CURSOR_SDK_EVENT_DEBUG;
				delete process.env.PI_CURSOR_SDK_EVENT_DEBUG_RUN_DIR;
				rmSync(artifactDir, { recursive: true, force: true });
			}
		});

		it("still surfaces explicit completed Cursor tool errors", async () => {
			const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "shell", args: { command: "cat missing.txt" } }, callId: "c1" } });
				opts.onDelta({
					update: {
						type: "tool-call-completed",
						toolCall: {
							name: "shell",
							args: { command: "cat missing.txt" },
							result: { status: "error", error: "missing.txt: No such file" },
						},
						callId: "c1",
					},
				});
				return asMockCursorRun({
					id: "run-1",
					agentId: "agent-1",
					status: "finished",
					wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "done" }),
					cancel: vi.fn(),
					supports: () => true,
					unsupportedReason: () => undefined,
				});
			});
			mockCreatedAgent({
				send: mockSend,
				[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
			});

			const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
			const events = await collectEvents(stream);
			const trace = collectThinkingDeltas(events);

			expect(trace).toContain("$ cat missing.txt");
			expect(trace).toContain("Error: missing.txt: No such file");
		});

		it("still surfaces explicit onStep Cursor tool errors", async () => {
			const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler; onStep: CursorStepHandler }) => {
				opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "read", args: { path: "missing.txt" } }, callId: "c1" } });
				opts.onStep({
					step: {
						type: "toolCall",
						id: "c1",
						message: {
							type: "read",
							args: { path: "missing.txt" },
							result: { status: "error", error: "missing.txt: No such file" },
						},
					} as CursorOnStepPayload["step"],
				});
				return asMockCursorRun({
					id: "run-1",
					agentId: "agent-1",
					status: "finished",
					wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "done" }),
					cancel: vi.fn(),
					supports: () => true,
					unsupportedReason: () => undefined,
				});
			});
			mockCreatedAgent({
				send: mockSend,
				[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
			});

			const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
			const events = await collectEvents(stream);
			const trace = collectThinkingDeltas(events);

			expect(trace).toContain("read missing.txt");
			expect(trace).toContain("Error: missing.txt: No such file");
			expect(trace).not.toContain("Cursor tool started without a completion event");
		});

});
