import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	collectEvents,
	getErrorEvent,
	getEventsOfType,
	makeContext,
	makeModel,
	mockedCreate,
	registerNativeToolDisplayForTest,
	resetCursorProviderTestState,
	mockCreatedAgent,
} from "./helpers/cursor-provider-harness.js";
import { streamCursor } from "../src/cursor-provider.js";
import { __testUtils as cursorSdkProcessGuardTestUtils } from "../src/cursor-sdk-process-error-guard.js";

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

function makeCursorSdkNetworkConnectError(): Error & { rawMessage: string; code: number; cause: NodeJS.ErrnoException } {
	const error = new Error("[aborted] read ECONNRESET") as Error & {
		rawMessage: string;
		code: number;
		cause: NodeJS.ErrnoException;
	};
	error.name = "ConnectError";
	error.rawMessage = "read ECONNRESET";
	error.code = 10;
	error.cause = Object.assign(new Error("read ECONNRESET"), {
		code: "ECONNRESET",
		syscall: "read",
	});
	error.stack =
		"ConnectError: [aborted] read ECONNRESET\n" +
		"    at file:///repo/node_modules/@connectrpc/connect-node/dist/esm/node-universal-client.js:293:63\n" +
		"    at file:///repo/node_modules/@cursor/sdk/dist/esm/index.js:8:1086456";
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
		mockCreatedAgent({ send: mockSend });

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
		mockCreatedAgent({ send: mockSend });

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

	it("suppresses duplicate process-level network ConnectError during an active provider turn", async () => {
		const connectError = makeCursorSdkNetworkConnectError();
		let processListenerCalled = false;
		const processListener = () => {
			processListenerCalled = true;
		};
		process.once("uncaughtException", processListener);
		const mockSend = vi.fn().mockResolvedValue({
			id: "run-network-reset",
			agentId: "agent-1",
			status: "running",
			wait: vi.fn().mockImplementation(async () => {
				process.emit("uncaughtException", connectError, "uncaughtException");
				throw connectError;
			}),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		});
		mockCreatedAgent({ send: mockSend });

		try {
			const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
			const errors = getEventsOfType(events, "error");

			expect(errors).toHaveLength(1);
			expect(errors[0].reason).toBe("error");
			expect(errors[0].error.errorMessage).toContain("timed out during network I/O");
			expect(errors[0].error.errorMessage).toContain("Check your connection and retry");
			expect(processListenerCalled).toBe(false);
			expect(cursorSdkProcessGuardTestUtils.activeProviderTurnCount()).toBe(0);
		} finally {
			process.removeListener("uncaughtException", processListener);
		}
	});
});
