import { describe, it, expect, vi, beforeEach } from "vitest";
import { Type } from "typebox";
import {
	resetCursorProviderTestState,
	mockedCreate,
	mockedCreateAgentPlatform,
	makeModel,
	makeContext,
	makeAssistantMessage,
	collectEvents,
	collectTextDeltas,
	collectThinkingDeltas,
	getEventsOfType,
	getDoneEvent,
	getErrorEvent,
	getTextEndEvent,
	hasEventType,
	isToolCallBlock,
	isCursorToolStreamEvent,
	getCreatedAgentOptions,
	createMockAgentPlatform,
	registerBridgeForProviderTest,
	registerNativeToolDisplayForTest,
	connectMcpClient,
	createBuiltinToolInfo,
	createBridgeToolInfo,
	cursorModelItems,
	type CursorDeltaHandler,
	type CursorStepHandler,
	type RegisteredTool,
} from "./helpers/cursor-provider-harness.js";
import { streamCursor, __testUtils as cursorProviderTestUtils } from "../src/cursor-provider.js";
import { __testUtils as contextWindowCacheTestUtils } from "../src/context-window-cache.js";
import { __testUtils as modelDiscoveryTestUtils } from "../src/model-discovery.js";
import type { Context } from "@earendil-works/pi-ai";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";



describe("streamCursor auth and abort", () => {
	beforeEach(resetCursorProviderTestState);

it("aborts after agent creation without sending a prompt when already cancelled", async () => {
		const controller = new AbortController();
		const mockDispose = vi.fn().mockResolvedValue(undefined);
		const mockSend = vi.fn();
		mockedCreate.mockImplementation(async () => {
			controller.abort();
			return {
				send: mockSend,
				[Symbol.asyncDispose]: mockDispose,
			};
		});

		const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key", signal: controller.signal });
		const events = await collectEvents(stream);
		const error = getErrorEvent(events);

		expect(error.reason).toBe("aborted");
		expect(error.error.stopReason).toBe("aborted");
		expect(error.error.errorMessage).toBe("Cancelled: prompt interrupted.");
		expect(mockSend).not.toHaveBeenCalled();
		expect(mockDispose).toHaveBeenCalledTimes(1);
	});

	it("emits actionable error when no API key", async () => {
		const stream = streamCursor(makeModel(), makeContext(), { apiKey: undefined });
		const events = await collectEvents(stream);

		const error = getErrorEvent(events);
		expect(error.error.errorMessage).toContain("/login");
		expect(error.error.errorMessage).toContain("CURSOR_API_KEY");
		expect(error.error.errorMessage).toContain("--api-key");
	});

	it("treats unresolved CURSOR_API_KEY provider placeholders as a missing API key", async () => {
		const originalKey = process.env.CURSOR_API_KEY;
		delete process.env.CURSOR_API_KEY;
		try {
			const stream = streamCursor(makeModel(), makeContext(), { apiKey: "CURSOR_API_KEY" });
			const events = await collectEvents(stream);

			const error = getErrorEvent(events);
			expect(error).toBeDefined();
			expect(error.error.errorMessage).toBe(
				"Cursor SDK runs require a Cursor API key. Run /login -> Use an API key -> Cursor, set CURSOR_API_KEY before starting pi, or restart pi with --api-key.",
			);
			expect(mockedCreate).not.toHaveBeenCalled();
		} finally {
			if (originalKey === undefined) {
				delete process.env.CURSOR_API_KEY;
			} else {
				process.env.CURSOR_API_KEY = originalKey;
			}
		}
	});

	it("resolves CURSOR_API_KEY provider placeholders through the env var when present", async () => {
		const originalKey = process.env.CURSOR_API_KEY;
		process.env.CURSOR_API_KEY = "env-key-123";
		try {
			const mockSend = vi.fn().mockResolvedValue({
				id: "run-1",
				agentId: "agent-1",
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
				cancel: vi.fn(),
				supports: () => true,
				unsupportedReason: () => undefined,
			});
			mockedCreate.mockResolvedValue({
				send: mockSend,
				[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
			});

			const stream = streamCursor(makeModel(), makeContext(), { apiKey: "CURSOR_API_KEY" });
			await collectEvents(stream);

			expect(mockedCreate).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "env-key-123" }));
		} finally {
			if (originalKey === undefined) {
				delete process.env.CURSOR_API_KEY;
			} else {
				process.env.CURSOR_API_KEY = originalKey;
			}
		}
	});

	it("turns generic Cursor SDK failures into actionable setup errors", async () => {
		mockedCreate.mockRejectedValueOnce(new Error("Error"));

		const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
		const events = await collectEvents(stream);

		const error = getErrorEvent(events);
		expect(error.error.errorMessage).toContain("Cursor SDK request failed");
		expect(error.error.errorMessage).toContain("/login");
		expect(error.error.errorMessage).toContain("CURSOR_API_KEY");
		expect(error.error.errorMessage).toContain("--api-key");
		expect(error.error.errorMessage).not.toBe("Error");
	});

	it("labels likely auth failures without leaking the supplied API key", async () => {
		mockedCreate.mockRejectedValueOnce(new Error("Unauthorized Bearer super-secret-key-12345"));

		const stream = streamCursor(makeModel(), makeContext(), { apiKey: "super-secret-key-12345" });
		const events = await collectEvents(stream);

		const error = getErrorEvent(events);
		const message = error.error.errorMessage;
		expect(message).toContain("invalid or unauthorized");
		expect(message).toContain("/login");
		expect(message).toContain("CURSOR_API_KEY");
		expect(message).not.toContain("super-secret-key-12345");
	});

	it("cancels run on abort signal", async () => {
		const controller = new AbortController();
		const mockCancel = vi.fn().mockResolvedValue(undefined);
		let resolveWait: () => void;
		const waitPromise = new Promise<{ id: string; status: string }>((resolve) => {
			resolveWait = () => resolve({ id: "run-1", status: "cancelled" });
		});
		const mockSend = vi.fn().mockImplementation(async () => {
			return {
				id: "run-1",
				agentId: "agent-1",
				status: "running",
				wait: vi.fn().mockReturnValue(waitPromise),
				cancel: mockCancel,
				supports: () => true,
				unsupportedReason: () => undefined,
			};
		});
		mockedCreate.mockResolvedValue({
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(makeModel(), makeContext(), {
			apiKey: "test-key",
			signal: controller.signal,
		});

		// Give the async IIFE time to start the run
		await vi.waitFor(() => expect(mockSend).toHaveBeenCalled());

		// Now abort
		controller.abort();

		// Let the run resolve
		resolveWait!();

		await collectEvents(stream);

		expect(mockCancel).toHaveBeenCalled();
	});
});
