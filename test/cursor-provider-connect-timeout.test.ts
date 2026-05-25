import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	collectEvents,
	getErrorEvent,
	makeContext,
	makeModel,
	mockedCreate,
	registerNativeToolDisplayForTest,
	resetCursorProviderTestState,
} from "./helpers/cursor-provider-harness.js";
import { streamCursor } from "../src/cursor-provider.js";

function trackUnhandledRejections(): { rejections: unknown[]; restore: () => void } {
	const rejections: unknown[] = [];
	const onUnhandledRejection = (reason: unknown) => {
		rejections.push(reason);
	};
	process.on("unhandledRejection", onUnhandledRejection);
	return {
		rejections,
		restore: () => {
			process.off("unhandledRejection", onUnhandledRejection);
		},
	};
}

function makeConnectTimeoutError(): Error {
	const error = new Error("ConnectError: [unavailable] read ETIMEDOUT");
	error.name = "ConnectError";
	return error;
}

describe("streamCursor connect timeout boundary", () => {
	beforeEach(resetCursorProviderTestState);
	afterEach(() => {
		delete process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY;
	});

	it("surfaces ConnectError from run.wait on the text-only path without unhandled rejections", async () => {
		const { rejections, restore } = trackUnhandledRejections();
		const connectError = makeConnectTimeoutError();
		const mockSend = vi.fn().mockResolvedValue({
			id: "run-timeout",
			agentId: "agent-1",
			status: "running",
			wait: vi.fn().mockRejectedValue(connectError),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		});
		mockedCreate.mockResolvedValue({
			agentId: "agent-1",
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		try {
			const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
			const error = getErrorEvent(events);
			expect(error.reason).toBe("error");
			expect(error.error.errorMessage).toContain("timed out during network I/O");
			expect(error.error.errorMessage).toContain("Check your connection and retry");
			expect(rejections).toEqual([]);
		} finally {
			restore();
		}
	});

	it("surfaces ConnectError from background run.wait on the live-run path without unhandled rejections", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		await registerNativeToolDisplayForTest([]);
		const { rejections, restore } = trackUnhandledRejections();
		const connectError = makeConnectTimeoutError();
		const mockSend = vi.fn().mockResolvedValue({
			id: "run-live-timeout",
			agentId: "agent-1",
			status: "running",
			wait: vi.fn().mockRejectedValue(connectError),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		});
		mockedCreate.mockResolvedValue({
			agentId: "agent-1",
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		try {
			const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
			const error = getErrorEvent(events);
			expect(error.reason).toBe("error");
			expect(error.error.errorMessage).toContain("timed out during network I/O");
			expect(rejections).toEqual([]);
		} finally {
			restore();
		}
	});
});
