import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	resetCursorProviderTestState,
	makeModel,
	makeContext,
	collectEvents,
	getDoneEvent,
	getErrorEvent,
	type CursorDeltaHandler,
	mockCreatedAgent,
	asMockCursorRun,
	createPiHarness,
} from "./helpers/cursor-provider-harness.js";
import { captureProviderTestOwnership, streamCursor } from "./helpers/cursor-provider-ownership.js";
import { registerCursorNativeToolDisplayState } from "../src/cursor-native-tool-display-state.js";
import { streamCursor as streamOwnedCursor } from "../src/cursor-provider.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtensionTestContext } from "./helpers/pi-harness.js";
import { captureCursorUsageRecorder, readCursorUsageView } from "../src/cursor-usage-ledger.js";
import { __testUtils as scopeTestUtils } from "../src/cursor-session-scope.js";

describe("streamCursor usage accounting", () => {
	beforeEach(resetCursorProviderTestState);

	it("blocks SDK send when the captured usage claim cannot be appended", async () => {
		const send = vi.fn();
		const dispose = vi.fn().mockResolvedValue(undefined);
		mockCreatedAgent({ send, [Symbol.asyncDispose]: dispose });
		const model = makeModel();
		const context = makeContext();
		const pi = createPiHarness();
		registerCursorNativeToolDisplayState(pi);
		const ownership = captureProviderTestOwnership(model, context, undefined, pi);
		pi.appendEntry.mockImplementation(() => { throw new Error("claim write failed"); });
		const events = await collectEvents(streamOwnedCursor(model, context, { apiKey: "test-key" }, ownership));
		expect(getErrorEvent(events).error.errorMessage).toContain("claim write failed");
		expect(send).not.toHaveBeenCalled();
		expect(dispose).toHaveBeenCalledOnce();
	});

	it.each(["finished", "error", "cancelled"] as const)("records the actual %s terminal on the captured origin", async status => {
		const model = makeModel();
		const context = makeContext();
		const pi = createPiHarness();
		registerCursorNativeToolDisplayState(pi);
		const ownership = captureProviderTestOwnership(model, context, undefined, pi);
		mockCreatedAgent({ send: vi.fn(async () => {
			expect(pi.appendEntry).toHaveBeenCalledWith("pi-cursor-sdk:usage-origin-v1", expect.any(Object));
			return asMockCursorRun({
				id: "run-accounted", agentId: "agent-1", status,
				wait: vi.fn().mockResolvedValue({ id: "run-accounted", status, result: "done" }),
			});
		}) });
		await collectEvents(streamOwnedCursor(model, context, { apiKey: "test-key" }, ownership));
		expect(pi.appendEntry).toHaveBeenCalledWith("pi-cursor-sdk:usage-v1", expect.objectContaining({
			kind: "terminal", status: status === "finished" ? "success" : status === "cancelled" ? "abort" : "error",
			origin: expect.objectContaining({ sessionFile: undefined }),
		}));
	});

	it("ignores returned RunResult usage for occupancy but persists its terminal-only facts", async () => {
		const root = mkdtempSync(join(tmpdir(), "cursor-terminal-usage-"));
		try {
			const manager = SessionManager.create(root, join(root, "sessions"));
			manager.appendMessage({ role: "user", content: "Hello", timestamp: 1 });
			scopeTestUtils.set(root, manager.getSessionFile());
			const model = makeModel(), context = makeContext(), pi = createPiHarness();
			registerCursorNativeToolDisplayState(pi);
			const ownership = captureProviderTestOwnership(model, context, undefined, pi);
			pi.appendEntry.mockImplementation((type, data) => { manager.appendCustomEntry(type, data); });
			const ctx = { ...createExtensionTestContext({ cwd: root }), sessionManager: manager };
			ownership.usageRecorder = captureCursorUsageRecorder(pi, ctx);
			const usage = { inputTokens: 1_405_237, outputTokens: 9_680, cacheReadTokens: 1_297_860,
				cacheWriteTokens: 107_320, totalTokens: 2_820_097, reasoningTokens: 3_641 };
			mockCreatedAgent({
				send: vi.fn().mockResolvedValue(asMockCursorRun({ id: "run-1", agentId: "agent-1", status: "finished",
					wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "done", usage }),
				})),
				[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
			});
			const done = getDoneEvent(await collectEvents(streamOwnedCursor(model, context, { apiKey: "test-key" }, ownership)));
			expect(done.message.usage.cacheRead).toBe(0);
			expect(done.message.usage.cacheWrite).toBe(0);
			expect(done.message.usage.input).toBeLessThan(model.contextWindow);
			expect(done.message.usage.totalTokens).toBeLessThan(model.contextWindow);
			const reopened = SessionManager.open(manager.getSessionFile()!);
			const view = readCursorUsageView(pi, { ...ctx, sessionManager: reopened });
			const start = view.records.find(record => record.kind === "start")!;
			const terminals = view.records.filter(record => record.kind === "terminal");
			expect(terminals).toHaveLength(1);
			expect(terminals[0]).toMatchObject({ turnId: start.turnId, origin: start.origin, status: "success", waitUsage: usage });
			expect(start.origin).toMatchObject({ sessionId: reopened.getSessionId(), sessionFile: reopened.getSessionFile() });
			expect(view.records.filter(record => record.kind === "run")).toMatchObject([{ turnId: start.turnId, origin: start.origin, runId: "run-1" }]);
			expect(start).toMatchObject({ data: { agentId: "agent-1" } });
			expect(view.records.filter(record => record.kind === "raw")).toEqual([]);
			expect(view.agents[0]?.wholeAgent).toBeUndefined();
			const evidence = process.env.PI_CURSOR_TEST_EVIDENCE_DIR;
			if (evidence) {
				mkdirSync(evidence, { recursive: true });
				writeFileSync(join(evidence, "terminal-only.jsonl"), readFileSync(reopened.getSessionFile()!));
				writeFileSync(join(evidence, "terminal-only.json"), JSON.stringify({ records: view.records, nativeUsage: done.message.usage }));
				writeFileSync(join(evidence, "terminal-only.journal"), readFileSync(join(root, "sessions", readdirSync(join(root, "sessions")).find(name => name.endsWith(".journal"))!)));
			}
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("uses real per-turn SDK usage instead of prompt estimates or RunResult usage", async () => {
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({ update: { type: "text-delta", text: "done" } });
			opts.onDelta({
				update: {
					type: "turn-ended",
					usage: {
						inputTokens: 25_432,
						outputTokens: 612,
						cacheReadTokens: 24_000,
						cacheWriteTokens: 123,
					},
				},
			});
			return asMockCursorRun({
				id: "run-1",
				agentId: "agent-1",
				status: "finished",
				wait: vi.fn().mockResolvedValue({
					id: "run-1",
					status: "finished",
					usage: {
						inputTokens: 6_746_960,
						outputTokens: 17_701,
						cacheReadTokens: 6_559_232,
						cacheWriteTokens: 0,
						totalTokens: 6_764_661,
					},
				}),
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
		const done = getDoneEvent(events);

		expect(done.message.usage.input).toBe(25_432 - 24_000 - 123);
		expect(done.message.usage.output).toBe(612);
		expect(done.message.usage.cacheRead).toBe(24_000);
		expect(done.message.usage.cacheWrite).toBe(123);
		expect(done.message.usage.totalTokens).toBe(25_432 + 612);
	});

	it("falls back to bounded estimates when SDK turn usage exceeds the model window", async () => {
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({ update: { type: "text-delta", text: "done" } });
			opts.onDelta({
				update: {
					type: "turn-ended",
					usage: {
						inputTokens: 1_125_429,
						outputTokens: 7_049,
						cacheReadTokens: 1_015_493,
						cacheWriteTokens: 0,
					},
				},
			});
			return asMockCursorRun({
				id: "run-1",
				agentId: "agent-1",
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
			});
		});
		mockCreatedAgent({
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		const done = getDoneEvent(events);

		expect(done.message.usage.cacheRead).toBe(0);
		expect(done.message.usage.cacheWrite).toBe(0);
		expect(done.message.usage.input).toBeLessThan(1_125_429);
		expect(done.message.usage.totalTokens).toBeLessThan(1_125_429);
	});

	it("keeps failed runs with no SDK usage on the current zero-usage error path", async () => {
		const mockSend = vi.fn().mockResolvedValue(asMockCursorRun({
			id: "run-1",
			agentId: "agent-1",
			status: "error",
			wait: vi.fn().mockResolvedValue({
				id: "run-1",
				status: "error",
				error: { message: "boom" },
			}),
		}));
		mockCreatedAgent({
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
		const events = await collectEvents(stream);
		const error = getErrorEvent(events);

		expect(error.error.usage).toMatchObject({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 });
	});
});
