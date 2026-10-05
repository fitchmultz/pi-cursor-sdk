import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	resetCursorProviderTestState, mockedCreate, makeModel, makeContext,
	collectEvents, mockCreatedAgent, asMockSdkAgent, asMockCursorRun,
} from "./helpers/cursor-provider-harness.js";
import { streamCursor } from "./helpers/cursor-provider-ownership.js";



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

	it.each(["finished", "failed", "aborted"] as const)("owns filtering from prepare through send/wait and restores after %s", async (outcome) => {
		const chunks: Buffer[] = [];
		const original = process.stderr.write;
		const collector = ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
			chunks.push(Buffer.from(chunk));
			(typeof encoding === "function" ? encoding : callback)?.();
			return true;
		}) as typeof process.stderr.write;
		process.stderr.write = collector;
		const controller = new AbortController();
		try {
			// Synthetic orchestration fixture, not SDK/backend callback timing.
			const noise = '18:05:57.959 INFO  managed_skills.removed ctx=syncBuiltinSkills meta={skill_id: "clone"}\n';
			mockedCreate.mockImplementationOnce(async () => {
				process.stderr.write("creation-only diagnostic\n");
				return asMockSdkAgent({
					agentId: "agent-1",
					send: async () => {
						process.stderr.write(noise.slice(0, 25));
						process.stderr.write(noise.slice(25) + "VISIBLE first-send diagnostic\n");
						if (outcome === "failed") throw new Error("controlled send failure");
						return asMockCursorRun({
							id: "run-1", agentId: "agent-1", status: "finished",
							wait: async () => {
								process.stderr.write(noise + "VISIBLE wait diagnostic\n");
								if (outcome === "aborted") controller.abort();
								return { id: "run-1", status: outcome === "aborted" ? "cancelled" : "finished" };
							},
							cancel: vi.fn().mockResolvedValue(undefined), supports: () => true, unsupportedReason: () => undefined,
						});
					},
					[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
				});
			});
			const events = await collectEvents(streamCursor(makeModel("composer-2"), makeContext(), { apiKey: "test-key", signal: controller.signal }));
			expect(process.stderr.write).toBe(collector);
			process.stderr.write("VISIBLE after restore\n");
			expect(Buffer.concat(chunks).toString()).toBe(`VISIBLE first-send diagnostic\n${outcome === "failed" ? "" : "VISIBLE wait diagnostic\n"}VISIBLE after restore\n`);
			expect(events.some(event => event.type === (outcome === "finished" ? "done" : "error"))).toBe(true);
		} finally { process.stderr.write = original; }
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
