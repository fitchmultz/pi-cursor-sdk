import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	asMockSdkAgent,
	collectEvents,
	createPiHarness,
	getErrorEvent,
	makeContext,
	makeModel,
	mockCreatedAgent,
	mockedCreate,
	resetCursorProviderTestState,
} from "./helpers/cursor-provider-harness.js";
import { streamCursor } from "./helpers/cursor-provider-ownership.js";
import { registerCursorRuntimeControls } from "../src/cursor-state.js";
import { registerCursorSessionScope } from "../src/cursor-session-scope.js";

function finishedRun() {
	return {
		id: "run-1",
		agentId: "agent-1",
		status: "finished" as const,
		wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
		cancel: vi.fn(),
		supports: () => true,
		unsupportedReason: () => undefined,
	};
}

describe("Cursor local force consumption", () => {
	beforeEach(resetCursorProviderTestState);

	it("does not force local sends by default", async () => {
		const mockSend = vi.fn().mockResolvedValue(finishedRun());
		mockCreatedAgent({ send: mockSend });

		await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), { apiKey: "test-key" }));

		expect(mockSend.mock.calls[0]?.[1]).not.toHaveProperty("local");
	});

	it("consumes environment local force on one actual Agent.send", async () => {
		process.env.PI_CURSOR_LOCAL_FORCE = "1";
		const mockSend = vi.fn().mockResolvedValue(finishedRun());
		mockCreatedAgent({ send: mockSend });

		await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), { apiKey: "test-key" }));
		await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), { apiKey: "test-key" }));

		expect(mockedCreate.mock.calls[0][0].local).not.toHaveProperty("force");
		expect(mockSend.mock.calls[0]?.[1]).toMatchObject({ local: { force: true } });
		expect(mockSend.mock.calls[0]?.[1]).not.toHaveProperty("idempotencyKey");
		expect(mockSend.mock.calls[1]?.[1]).not.toHaveProperty("local");
	});

	it("preserves environment local force after pre-send failure", async () => {
		process.env.PI_CURSOR_LOCAL_FORCE = "1";
		mockedCreate.mockRejectedValueOnce(new Error("pre-send create failed"));
		const mockSend = vi.fn().mockResolvedValue(finishedRun());

		const failed = await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), { apiKey: "test-key" }));
		mockCreatedAgent({ send: mockSend });
		await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), { apiKey: "test-key" }));
		await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), { apiKey: "test-key" }));

		expect(getErrorEvent(failed).error.errorMessage).toContain("pre-send create failed");
		expect(mockSend.mock.calls[0]?.[1]).toMatchObject({ local: { force: true } });
		expect(mockSend.mock.calls[1]?.[1]).not.toHaveProperty("local");
	});

	it("preserves environment local force when aborted after Agent.create but before send", async () => {
		process.env.PI_CURSOR_LOCAL_FORCE = "1";
		const abortController = new AbortController();
		const mockSend = vi.fn().mockResolvedValue(finishedRun());
		mockedCreate.mockImplementationOnce(async () => {
			abortController.abort();
			return asMockSdkAgent({ send: mockSend });
		});

		await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), { apiKey: "test-key", signal: abortController.signal }));
		mockCreatedAgent({ send: mockSend });
		await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), { apiKey: "test-key" }));

		expect(mockSend).toHaveBeenCalledTimes(1);
		expect(mockSend.mock.calls[0]?.[1]).toMatchObject({ local: { force: true } });
	});

	it("does not rearm consumed CLI force on session_start reload", async () => {
		const pi = createPiHarness({ flagValues: { "cursor-local-force": true } });
		registerCursorSessionScope(pi);
		registerCursorRuntimeControls(pi);
		await pi.runSessionStart({ model: makeModel("gpt-5.5@1m") });
		const mockSend = vi.fn().mockResolvedValue(finishedRun());
		mockCreatedAgent({ send: mockSend });

		await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), { apiKey: "test-key" }));
		await pi.runSessionStart({ model: makeModel("gpt-5.5@1m") }, { reason: "reload" });
		await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), { apiKey: "test-key" }));

		expect(mockSend.mock.calls[0]?.[1]).toMatchObject({ local: { force: true } });
		expect(mockSend.mock.calls[1]?.[1]).not.toHaveProperty("local");
	});
});
