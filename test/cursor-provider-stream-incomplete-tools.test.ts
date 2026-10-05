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
	mockCreatedAgent,
	asMockCursorRun,
} from "./helpers/cursor-provider-harness.js";
import { streamCursor } from "./helpers/cursor-provider-ownership.js";
import type { InteractionUpdate, SendOptions, ToolCallStartedUpdate, ToolCallCompletedUpdate } from "@cursor/sdk";
import { installedCursorModules } from "./helpers/cursor-sdk-installed-modules.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("streamCursor incomplete tools", () => {
	beforeEach(resetCursorProviderTestState);

	it("reconciles and deduplicates public shell callbacks produced by the installed SDK accumulator", async () => {
		const started = {
			type: "tool-call-started", callId: "shell-1", modelCallId: "model-shell-1",
			toolCall: { type: "shell", args: { command: "echo completed" } },
		} satisfies ToolCallStartedUpdate;
		const completed = {
			...started, type: "tool-call-completed",
			toolCall: {
				...started.toolCall,
				result: { status: "success", value: {
					stdout: "completed\n", stderr: "", exitCode: 0, signal: "", executionTime: 1,
				} },
			},
		} satisfies ToolCallCompletedUpdate;
		const sdk = await vi.importActual<typeof import("@cursor/sdk")>("@cursor/sdk");
		expect(sdk.ToolCallStartedUpdateSchema.parse(started)).toEqual(started);
		expect(sdk.ToolCallCompletedUpdateSchema.parse(completed)).toEqual(completed);
		expect(sdk.ToolCallStartedUpdateSchema.safeParse({
			...started, toolCall: { name: "shell", args: started.toolCall.args },
		}).success).toBe(false);

		const modules = await installedCursorModules();
		const Accumulator = Object.values(modules("./src/agent/run-interaction-accumulator.ts")).find(
			(value: any) => typeof value === "function" && typeof value.prototype?.apply === "function",
		) as new (options: Pick<SendOptions, "onDelta" | "onStep">) => { apply(update: InteractionUpdate): Promise<void> };
		expect(Accumulator).toBeTypeOf("function");
		const callbacks: unknown[] = [];
		const send = vi.fn(async (_msg: unknown, opts: SendOptions = {}) => {
			const accumulator = new Accumulator({
				onDelta: async args => {
					callbacks.push({ channel: "delta", ...args });
					await opts.onDelta?.(args);
				},
				onStep: async args => {
					callbacks.push({ channel: "step", ...args });
					await opts.onStep?.(args);
				},
			});
			// These are schema-checked test inputs to the real installed producer,
			// not a service capture or evidence of an alias-changing start/completion.
			await accumulator.apply(started);
			await accumulator.apply(completed);
			return asMockCursorRun({
				id: "run-shell-contract", agentId: "agent-1", status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-shell-contract", status: "finished", result: "done" }),
			});
		});
		mockCreatedAgent({ send });
		const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		// Independent drift guard: onStep preserves the ToolCall, adds no ID,
		// and fires before the completed delta in this installed accumulator.
		expect(callbacks).toEqual([
			{ channel: "delta", update: started },
			{ channel: "step", step: { type: "toolCall", message: completed.toolCall } },
			{ channel: "delta", update: completed },
		]);
		const trace = collectThinkingDeltas(events);
		expect(trace.match(/\$ echo completed/g)).toHaveLength(1);
		expect(trace).toContain("completed\n");
		expect(trace).not.toContain("did not complete");
		expect(collectTextDeltas(events)).toBe("done");
	});

	// Legacy alias/ID combinations are compatibility inputs, not public SDK captures.
	it.each(["bash", "run_terminal_cmd"])("replays a legacy %s alias without a stale shell missing-completion trace", async name => {
		const send = vi.fn(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({ update: { type: "tool-call-started", callId: "shell-start", toolCall: { name: "shell", args: { command: "echo completed" } } } });
			opts.onDelta({ update: { type: "tool-call-completed", callId: "different-completion-id", toolCall: {
				name, args: { command: "echo completed" }, result: { status: "success", value: { stdout: "completed", exitCode: 0 } },
			} } });
			return asMockCursorRun({ id: "run-alias", agentId: "agent-1", status: "finished", wait: vi.fn().mockResolvedValue({ id: "run-alias", status: "finished", result: "done" }) });
		});
		mockCreatedAgent({ send, [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined) });
		const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		const trace = collectThinkingDeltas(events);
		expect(trace).toContain("completed");
		expect(trace).not.toContain("did not complete");
		expect(collectTextDeltas(events)).toBe("done");
	});

	it("retains a different unmatched shell after another shell completes and assistant text succeeds", async () => {
		const send = vi.fn(async (_msg: unknown, opts: SendOptions = {}) => {
			await opts.onDelta?.({ update: { type: "tool-call-started", callId: "unmatched-shell", modelCallId: "model-unmatched", toolCall: { type: "shell", args: { command: "sleep 10" } } } });
			await opts.onDelta?.({ update: { type: "tool-call-completed", callId: "other-shell", modelCallId: "model-other", toolCall: {
				type: "shell", args: { command: "echo completed" }, result: { status: "success", value: { stdout: "completed", stderr: "", exitCode: 0, signal: "", executionTime: 1 } },
			} } });
			return asMockCursorRun({ id: "run-unmatched", agentId: "agent-1", status: "finished", wait: vi.fn().mockResolvedValue({ id: "run-unmatched", status: "finished", result: "done" }) });
		});
		mockCreatedAgent({ send, [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined) });
		const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		expect(collectThinkingDeltas(events)).toContain("Cursor shell did not complete");
		expect(collectTextDeltas(events)).toBe("done");
	});

		it("surfaces incomplete started Cursor tool calls with neutral activity traces", async () => {
			const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "shell", args: { command: "sleep 10" } }, callId: "c1" } });
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

			expect(trace).toContain("Cursor shell did not complete");
			expect(trace).toContain("missing completion");
			expect(text).toBe("done");
			expect(hasEventType(events, "toolcall_start")).toBe(false);
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

		it("surfaces explicit SDK-shaped onStep tool errors without a step ID", async () => {
			const mockSend = vi.fn(async (_msg: unknown, opts: SendOptions = {}) => {
				await opts.onDelta?.({ update: { type: "tool-call-started", toolCall: { type: "read", args: { path: "missing.txt" } }, callId: "c1", modelCallId: "model-read-1" } });
				await opts.onStep?.({
					step: {
						type: "toolCall",
						message: {
							type: "read",
							args: { path: "missing.txt" },
							result: { status: "error", error: { message: "missing.txt: No such file" } },
						},
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

			expect(trace).toContain("read missing.txt");
			expect(trace).toContain("Error:");
			expect(trace).toContain("missing.txt: No such file");
			expect(trace).not.toContain("Cursor tool started without a completion event");
		});

});
