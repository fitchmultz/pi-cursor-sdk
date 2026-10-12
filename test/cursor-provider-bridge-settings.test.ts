import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	resetCursorProviderTestState, mockedCreate, makeModel, makeContext,
	collectEvents, mockCreatedAgent, asMockSdkAgent, asMockCursorRun,
} from "./helpers/cursor-provider-harness.js";
import { streamCursor } from "./helpers/cursor-provider-ownership.js";

describe("streamCursor bridge settings", () => {
	beforeEach(resetCursorProviderTestState);

	it.each([
		["default", undefined, ["all"]],
		["disabled", "none", undefined],
		["explicit all", "all", ["all"]],
		["narrowed", "project,user", ["project", "user"]],
	] as const)("passes %s Cursor setting sources to Agent.create", async (_label, raw, expected) => {
		if (raw !== undefined) process.env.PI_CURSOR_SETTING_SOURCES = raw;
		mockCreatedAgent({
			send: vi.fn().mockResolvedValue({
				id: "run-1",
				agentId: "agent-1",
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
				cancel: vi.fn(),
				supports: () => true,
				unsupportedReason: () => undefined,
			}),
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		await collectEvents(streamCursor(makeModel("composer-2"), makeContext(), { apiKey: "test-key" }));

		const local = mockedCreate.mock.calls[0]?.[0]?.local;
		expect(local).toMatchObject({ cwd: process.cwd(), store: expect.any(Object) });
		if (expected === undefined) expect(local).not.toHaveProperty("settingSources");
		else expect(local).toHaveProperty("settingSources", expected);
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

});
