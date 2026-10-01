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
} from "./helpers/cursor-provider-harness.js";
import { streamCursor } from "../src/cursor-provider.js";

describe("streamCursor usage accounting", () => {
	beforeEach(resetCursorProviderTestState);

	it("uses returned local RunResult usage for spend when no turn-ended usage was applied", async () => {
		const mockSend = vi.fn().mockResolvedValue(asMockCursorRun({
			id: "run-1",
			agentId: "agent-1",
			status: "finished",
			wait: vi.fn().mockResolvedValue({
				id: "run-1",
				status: "finished",
				result: "done",
				usage: {
					inputTokens: 1_125_429,
					outputTokens: 7_049,
					cacheReadTokens: 1_015_493,
					cacheWriteTokens: 0,
					totalTokens: 2_147_971,
				},
			}),
		}));
		mockCreatedAgent({
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
		const events = await collectEvents(stream);
		const done = getDoneEvent(events);

		expect(done.message.usage.cacheRead).toBe(1_015_493);
		expect(done.message.usage.cacheWrite).toBe(0);
		expect(done.message.usage.input).toBe(1_125_429 - 1_015_493);
		expect(done.message.usage.output).toBe(7_049);
		expect(done.message.usage.totalTokens).toBeLessThan(1_125_429);
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
