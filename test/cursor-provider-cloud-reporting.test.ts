import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	asMockCursorRun,
	collectEvents,
	collectThinkingDeltas,
	getDoneEvent,
	getErrorEvent,
	makeContext,
	makeModel,
	mockCreatedAgent,
	resetCursorProviderTestState,
	type CursorDeltaHandler,
} from "./helpers/cursor-provider-harness.js";
import { streamCursor } from "./helpers/cursor-provider-ownership.js";
import {
	CLOUD_LIFECYCLE_ENTRY_TYPE,
	registerCursorCloudLifecycleLedger,
	__testUtils as cloudLifecycleTestUtils,
} from "../src/cursor-cloud-lifecycle.js";
import { createPiHarness } from "./helpers/pi-harness.js";

const CLOUD_AGENT_ID = "bc-00000000-0000-0000-0000-000000000001";

describe("streamCursor cloud reporting", () => {
	beforeEach(async () => {
		await resetCursorProviderTestState();
	});

	afterEach(() => {
		cloudLifecycleTestUtils.reset();
	});

	it("streams bounded cloud completion telemetry, records lifecycle, and keeps raw usage out of pi usage", async () => {
		process.env.PI_CURSOR_RUNTIME = "cloud";
		process.env.PI_CURSOR_CLOUD_ALLOW_LOCAL_STATE = "1";
		process.env.PI_CURSOR_CLOUD_ACK = "1";
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
			totalUsage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 40, totalTokens: 1540 },
			runs: [
				{ id: "run-1", usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 40, totalTokens: 1540 } },
			],
		}), { status: 200 }));
		const listArtifacts = vi.fn().mockResolvedValue([
			{ path: "artifacts/report.txt", sizeBytes: 12, updatedAt: "2026-07-07T00:00:00Z" },
		]);
		const pi = createPiHarness();
		registerCursorCloudLifecycleLedger(pi);
		mockCreatedAgent({
			agentId: CLOUD_AGENT_ID,
			listArtifacts,
			send: vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				opts.onDelta({
					update: {
						type: "turn-ended",
						usage: {
							inputTokens: 26,
							outputTokens: 8,
							cacheReadTokens: 9,
							cacheWriteTokens: 10,
						},
					},
				});
				return {
					id: "run-1",
					agentId: CLOUD_AGENT_ID,
					status: "finished",
					wait: vi.fn().mockResolvedValue({
						id: "run-1",
						status: "finished",
						result: "cloud done",
						git: { branches: [{ repoUrl: "github.com/acme/repo", branch: "cursor/work", prUrl: "https://github.com/acme/repo/pull/7" }] },
					}),
					cancel: vi.fn(),
					supports: () => true,
					unsupportedReason: () => undefined,
				};
			}),
		});

		try {
			const events = await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), { apiKey: "test-key" }));

			const thinking = collectThinkingDeltas(events);
			expect(thinking).toContain("Cursor cloud run:");
			expect(thinking).toContain(`- agent: ${CLOUD_AGENT_ID}`);
			expect(thinking).toContain("- run: run-1");
			expect(thinking).toContain("- branch: cursor/work (github.com/acme/repo)");
			expect(thinking).not.toContain("git fetch");
			expect(thinking).toContain("- PR: https://github.com/acme/repo/pull/7");
			expect(thinking).toContain("artifacts/report.txt (12 bytes");
			expect(thinking).toContain("raw usage (display only): input 1,000, output 200, cache read 300, cache write 40, total 1,540");
			expect(listArtifacts).toHaveBeenCalledTimes(1);
			expect(fetchSpy.mock.calls[0]?.[0].toString()).toContain(`/v1/agents/${CLOUD_AGENT_ID}/usage?runId=run-1`);

			const done = getDoneEvent(events);
			expect(done.message.usage.input).toBeGreaterThan(0);
			expect(done.message.usage.output).toBeGreaterThan(0);
			expect(done.message.usage.cacheRead).toBe(0);
			expect(done.message.usage.cacheWrite).toBe(0);
			expect(done.message.usage.totalTokens).toBeGreaterThanOrEqual(
				done.message.usage.input + done.message.usage.output,
			);
			expect(done.message.usage.totalTokens).not.toBe(34);
			const doneContent = JSON.stringify(done.message.content);
			expect(doneContent).not.toContain("Cursor cloud run:");
			expect(doneContent).not.toContain(CLOUD_AGENT_ID);
			expect(doneContent).not.toContain("run-1");
			expect(doneContent).not.toContain("github.com/acme/repo");
			expect(doneContent).not.toContain("artifacts/report.txt");
			expect(doneContent).not.toContain("raw usage");
			expect(pi.appendEntry).toHaveBeenCalledTimes(3);
			expect(pi.appendEntry.mock.calls[0]?.[1]).not.toHaveProperty("runId");
			expect(pi.appendEntry).toHaveBeenNthCalledWith(2, CLOUD_LIFECYCLE_ENTRY_TYPE, expect.objectContaining({
				agentId: CLOUD_AGENT_ID,
				runId: "run-1",
			}));
			expect(pi.appendEntry).toHaveBeenCalledWith(CLOUD_LIFECYCLE_ENTRY_TYPE, expect.objectContaining({
				action: "record",
				runtime: "cloud",
				agentId: CLOUD_AGENT_ID,
				runId: "run-1",
				branches: [expect.objectContaining({ branch: "cursor/work", prUrl: "https://github.com/acme/repo/pull/7" })],
			}));
			expect(pi.appendEntry.mock.calls[0]?.[1]).not.toHaveProperty("artifacts");
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("records the cloud agent before a rejected send", async () => {
		process.env.PI_CURSOR_RUNTIME = "cloud";
		process.env.PI_CURSOR_CLOUD_ALLOW_LOCAL_STATE = "1";
		process.env.PI_CURSOR_CLOUD_ACK = "1";
		const pi = createPiHarness();
		registerCursorCloudLifecycleLedger(pi);
		const send = vi.fn().mockRejectedValue(new Error("send failed"));
		mockCreatedAgent({ agentId: CLOUD_AGENT_ID, send });

		const events = await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), { apiKey: "test-key" }));

		expect(getErrorEvent(events).error.errorMessage).toContain("send failed");
		expect(pi.appendEntry).toHaveBeenCalledTimes(1);
		expect(pi.appendEntry).toHaveBeenCalledWith(CLOUD_LIFECYCLE_ENTRY_TYPE, expect.objectContaining({
			action: "record",
			agentId: CLOUD_AGENT_ID,
		}));
		expect(pi.appendEntry.mock.calls[0]?.[1]).not.toHaveProperty("runId");
		expect(pi.appendEntry.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]);
	});

	it.each(["cancelled result", "wait rejection"])("records returned cloud run IDs and awaits post-send abort: %s", async outcome => {
		process.env.PI_CURSOR_RUNTIME = "cloud";
		process.env.PI_CURSOR_CLOUD_ALLOW_LOCAL_STATE = "1";
		process.env.PI_CURSOR_CLOUD_ACK = "1";
		const pi = createPiHarness();
		registerCursorCloudLifecycleLedger(pi);
		const abortController = new AbortController();
		const cancel = vi.fn().mockResolvedValue(undefined);
		const wait = outcome === "wait rejection"
			? vi.fn().mockRejectedValue(new Error("transport rejected after cancellation"))
			: vi.fn().mockResolvedValue({ id: "run-aborted", status: "cancelled" });
		const send = vi.fn(async () => {
			abortController.abort();
			return asMockCursorRun({
				id: "run-aborted",
				agentId: CLOUD_AGENT_ID,
				status: "running",
				wait,
				cancel,
			});
		});
		mockCreatedAgent({ agentId: CLOUD_AGENT_ID, send });

		const events = await collectEvents(streamCursor(
			makeModel("gpt-5.5@1m"),
			makeContext(),
			{ apiKey: "test-key", signal: abortController.signal },
		));

		expect(getErrorEvent(events).reason).toBe("aborted");
		expect(pi.appendEntry).toHaveBeenCalledTimes(2);
		expect(pi.appendEntry).toHaveBeenNthCalledWith(2, CLOUD_LIFECYCLE_ENTRY_TYPE, expect.objectContaining({
			agentId: CLOUD_AGENT_ID,
			runId: "run-aborted",
		}));
		expect(pi.appendEntry.mock.invocationCallOrder[1]).toBeLessThan(cancel.mock.invocationCallOrder[0]);
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(wait).toHaveBeenCalledOnce();
	});

	it("fails before cloud send when its durable agent intent cannot be recorded", async () => {
		process.env.PI_CURSOR_RUNTIME = "cloud";
		process.env.PI_CURSOR_CLOUD_ALLOW_LOCAL_STATE = "1";
		process.env.PI_CURSOR_CLOUD_ACK = "1";
		const apiKey = "cursor-secret-intent-key";
		const pi = createPiHarness();
		cloudLifecycleTestUtils.setDurableWriter(() => false);
		registerCursorCloudLifecycleLedger(pi);
		const send = vi.fn();
		mockCreatedAgent({ agentId: CLOUD_AGENT_ID, send });

		const events = await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), { apiKey }));
		const error = getErrorEvent(events).error.errorMessage;

		expect(error).toContain(CLOUD_AGENT_ID);
		expect(error).toContain("send intent");
		expect(error).toContain("No run was started");
		expect(error).toContain("Cursor Cloud dashboard");
		expect(error).not.toContain(apiKey);
		expect(send).not.toHaveBeenCalled();
	});

	it("cancels a returned cloud run when its run ID cannot be recorded", async () => {
		process.env.PI_CURSOR_RUNTIME = "cloud";
		process.env.PI_CURSOR_CLOUD_ALLOW_LOCAL_STATE = "1";
		process.env.PI_CURSOR_CLOUD_ACK = "1";
		const pi = createPiHarness();
		let durableWrites = 0;
		cloudLifecycleTestUtils.setDurableWriter(() => ++durableWrites === 1);
		registerCursorCloudLifecycleLedger(pi);
		const cancel = vi.fn().mockResolvedValue(undefined);
		const wait = vi.fn();
		mockCreatedAgent({
			agentId: CLOUD_AGENT_ID,
			send: vi.fn().mockResolvedValue(asMockCursorRun({
				id: "run-unrecorded",
				agentId: CLOUD_AGENT_ID,
				status: "running",
				wait,
				cancel,
			})),
		});

		const events = await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), { apiKey: "test-key" }));
		const error = getErrorEvent(events).error.errorMessage;

		expect(error).toContain(CLOUD_AGENT_ID);
		expect(error).toContain("Cancellation requested/confirmed");
		expect(error).toContain("Cursor Cloud dashboard");
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(wait).not.toHaveBeenCalled();
		expect(pi.appendEntry).toHaveBeenCalledTimes(2);
		expect(pi.appendEntry.mock.calls[0]?.[1]).not.toHaveProperty("runId");
	});

	it.each(["error", "cancelled"] as const)("skips cloud completion telemetry after %s runs", async (status) => {
		process.env.PI_CURSOR_RUNTIME = "cloud";
		process.env.PI_CURSOR_CLOUD_ALLOW_LOCAL_STATE = "1";
		process.env.PI_CURSOR_CLOUD_ACK = "1";
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
		const listArtifacts = vi.fn().mockResolvedValue([{ path: "artifacts/report.txt", sizeBytes: 12, updatedAt: "now" }]);
		mockCreatedAgent({
			agentId: CLOUD_AGENT_ID,
			listArtifacts,
			send: vi.fn().mockResolvedValue({
				id: "run-1",
				agentId: CLOUD_AGENT_ID,
				status,
				wait: vi.fn().mockResolvedValue({ id: "run-1", status }),
				cancel: vi.fn(),
				supports: () => true,
				unsupportedReason: () => undefined,
			}),
		});

		try {
			const events = await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), { apiKey: "test-key" }));

			expect(getErrorEvent(events).reason).toBe(status === "cancelled" ? "aborted" : "error");
			expect(listArtifacts).not.toHaveBeenCalled();
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("omits malformed hostile telemetry while recording lifecycle and keeping the run successful", async () => {
		process.env.PI_CURSOR_RUNTIME = "cloud";
		process.env.PI_CURSOR_CLOUD_ALLOW_LOCAL_STATE = "1";
		process.env.PI_CURSOR_CLOUD_ACK = "1";
		const hostile = `remote\u0085\u2028${"x".repeat(500)}`;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
			totalUsage: { inputTokens: -1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, totalTokens: 8 },
		}), { status: 200 }));
		const pi = createPiHarness();
		registerCursorCloudLifecycleLedger(pi);
		mockCreatedAgent({
			agentId: CLOUD_AGENT_ID,
			listArtifacts: vi.fn().mockResolvedValue([
				{ path: "artifacts/bad.txt" },
				{ path: hostile, sizeBytes: 1, updatedAt: hostile },
			]),
			send: vi.fn().mockResolvedValue({
				id: hostile,
				agentId: CLOUD_AGENT_ID,
				status: "finished",
				wait: vi.fn().mockResolvedValue({
					id: hostile,
					status: "finished",
					result: "cloud done",
					git: { branches: [null, { repoUrl: 7 }, { repoUrl: hostile, branch: hostile, prUrl: hostile }] },
				}),
				cancel: vi.fn(),
				supports: () => true,
				unsupportedReason: () => undefined,
			}),
		});

		try {
			const events = await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), { apiKey: "test-key" }));
			const display = collectThinkingDeltas(events);

			expect(getDoneEvent(events).message.stopReason).toBe("stop");
			expect(display).toContain("Cursor cloud run:");
			expect(display.split("\n").every((line) => !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(line))).toBe(true);
			expect(display.length).toBeLessThan(2500);
			expect(display).not.toContain("raw usage");
			expect(pi.appendEntry).toHaveBeenCalledWith(CLOUD_LIFECYCLE_ENTRY_TYPE, expect.objectContaining({
				agentId: CLOUD_AGENT_ID,
				runId: expect.stringMatching(/…$/),
			}));
			const ledger = JSON.stringify(pi.appendEntry.mock.calls[0]?.[1]);
			expect(ledger).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u);
			expect(pi.appendEntry.mock.calls[0]?.[1]).not.toHaveProperty("artifacts");
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("keeps local runs out of cloud completion telemetry", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
		const listArtifacts = vi.fn().mockResolvedValue([{ path: "artifacts/report.txt", sizeBytes: 12, updatedAt: "now" }]);
		mockCreatedAgent({
			listArtifacts,
			send: vi.fn().mockResolvedValue({
				id: "run-1",
				agentId: "agent-1",
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "local done" }),
				cancel: vi.fn(),
				supports: () => true,
				unsupportedReason: () => undefined,
			}),
		});

		try {
			const events = await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), { apiKey: "test-key" }));

			expect(collectThinkingDeltas(events)).not.toContain("Cursor cloud run:");
			expect(listArtifacts).not.toHaveBeenCalled();
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
		}
	});
});
