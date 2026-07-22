import type { SDKAgent } from "@cursor/sdk";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { makeAssistantMessage, makeContext, makeModel } from "./helpers/pi-harness.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createCursorLiveRunCoordinator,
	hasTrailingUserMessagesAfterToolResults,
	type CursorLiveRun,
} from "../src/cursor-live-run-coordinator.js";
import type { CursorNativeToolDisplayItem } from "../src/cursor-native-tool-display-state.js";
import type { CursorPiToolBridgeRun } from "../src/cursor-pi-tool-bridge.js";
import {
	cursorLiveRuns,
	drainCursorLiveRunTurn,
} from "../src/cursor-provider-live-run-drain.js";
import { __testUtils as cursorSdkProcessGuardTestUtils } from "../src/cursor-sdk-process-error-guard.js";

function makeAgent(agentId = "agent-1"): SDKAgent {
	return { agentId } as SDKAgent;
}

function makeToolDisplay(id: string): CursorNativeToolDisplayItem {
	return {
		id,
		toolName: "read",
		args: { path: "README.md" },
		result: { content: [{ type: "text", text: "ok" }] },
		isError: false,
	};
}

function makeCursorSdkAbortConnectError(): Error & { rawMessage: string; code: number; cause: DOMException } {
	const error = new Error("[canceled] This operation was aborted") as Error & {
		rawMessage: string;
		code: number;
		cause: DOMException;
	};
	error.name = "ConnectError";
	error.rawMessage = "This operation was aborted";
	error.code = 1;
	error.cause = new DOMException("This operation was aborted", "AbortError");
	error.stack =
		"ConnectError: [canceled] This operation was aborted\n" +
		"    at file:///repo/node_modules/@connectrpc/connect-node/dist/esm/node-universal-client.js:293:63\n" +
		"    at file:///repo/node_modules/@cursor/sdk/dist/esm/index.js:8:1086456\n" +
		"Caused by: AbortError";
	return error;
}

function makeBridgeRun(id: string, pendingPiToolCallIds: string[] = []): CursorPiToolBridgeRun {
	const pending = new Set(pendingPiToolCallIds);
	return {
		id,
		enabled: true,
		snapshot: { tools: [], mcpToolNameToPiToolName: new Map(), piToolNameToMcpToolName: new Map() },
		takeQueuedToolRequests: vi.fn(() => []),
		resolveToolResults: vi.fn().mockResolvedValue(undefined),
		resolveToolResultsFromContext: vi.fn().mockResolvedValue(undefined),
		hasPendingPiToolCallId: vi.fn((piToolCallId: string) => pending.has(piToolCallId)),
		isBridgeMcpToolCall: vi.fn(() => false),
		setOnToolRequest: vi.fn(),
		setDebugRecorder: vi.fn(),
		cancel: vi.fn(),
		dispose: vi.fn().mockResolvedValue(undefined),
	};
}

function makeCoordinator(options: { scopeKey?: string; idleDisposeMs?: number } = {}) {
	const deleteNativeToolDisplay = vi.fn();
	const abandonSessionAgent = vi.fn().mockResolvedValue(undefined);
	const coordinator = createCursorLiveRunCoordinator({
		getScopeKey: () => options.scopeKey ?? "scope-1",
		getIdleDisposeMs: () => options.idleDisposeMs ?? 10,
		deleteNativeToolDisplay,
		abandonSessionAgent,
	});
	return { coordinator, deleteNativeToolDisplay, abandonSessionAgent };
}

function startRun(coordinator: ReturnType<typeof makeCoordinator>["coordinator"], options: { id?: string; scopeKey?: string; bridgeRun?: CursorPiToolBridgeRun; sessionBridgeRun?: CursorPiToolBridgeRun } = {}): CursorLiveRun {
	return coordinator.start({
		id: options.id ?? "cursor-replay-1",
		agent: makeAgent(),
		bridgeRun: options.bridgeRun,
		sessionBridgeRun: options.sessionBridgeRun,
		sessionAgentScopeKey: options.scopeKey,
		promptInputTokens: 12,
	});
}

function replayIdFromToolCallId(toolCallId: string): string | undefined {
	return /^(cursor-replay-\d+)-tool-\d+$/.exec(toolCallId)?.[1];
}

describe("cursor live run coordinator", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("matches context tool results after trailing user messages and ignores disposed runs", async () => {
		const { coordinator } = makeCoordinator();
		const run = startRun(coordinator, { id: "cursor-replay-1" });
		const context = makeContext([
			{ role: "user", content: "run a tool", timestamp: 1 },
			{ role: "toolResult", toolCallId: "cursor-replay-1-tool-1", toolName: "read", content: [], isError: false, timestamp: 2 },
			{ role: "user", content: "and summarize it", timestamp: 3 },
		]);

		expect(hasTrailingUserMessagesAfterToolResults(context)).toBe(true);
		expect(coordinator.getPendingFromContext(context, replayIdFromToolCallId)).toBe(run);

		await coordinator.release(run);

		expect(coordinator.getPendingFromContext(context, replayIdFromToolCallId)).toBeUndefined();
	});

	it("drops bridge events whose pending call expired before tool emission", () => {
		const { coordinator } = makeCoordinator();
		const bridgeRun = makeBridgeRun("bridge-1", ["tool-live"]);
		const run = startRun(coordinator, { bridgeRun });
		for (const piToolCallId of ["tool-expired", "tool-live"]) {
			coordinator.queueEvent(run, {
				type: "bridge-tool",
				request: {
					runId: bridgeRun.id,
					bridgeCallId: `call-${piToolCallId}`,
					piToolCallId,
					piToolName: "read",
					mcpToolName: "pi__read",
					args: {},
				},
			});
		}

		expect(coordinator.collectBridgeToolBatch(run).map((request) => request.piToolCallId)).toEqual(["tool-live"]);
		expect(run.pendingEvents).toEqual([]);
	});

	it("does not emit an empty tool-use turn when every queued bridge call expired", async () => {
		const bridgeRun = makeBridgeRun("bridge-expired");
		const run = cursorLiveRuns.start({
			id: "expired-bridge-drain",
			agent: makeAgent(),
			bridgeRun,
			sessionAgentScopeKey: "expired-bridge-drain-scope",
			promptInputTokens: 1,
		});
		cursorLiveRuns.queueEvent(run, {
			type: "bridge-tool",
			request: {
				runId: bridgeRun.id,
				bridgeCallId: "expired-call",
				piToolCallId: "expired-tool",
				piToolName: "read",
				mcpToolName: "pi__read",
				args: {},
			},
		});
		cursorLiveRuns.markFinished(run, "done");
		const stream = createAssistantMessageEventStream();
		const push = vi.spyOn(stream, "push");

		const outcome = await drainCursorLiveRunTurn(
			stream,
			makeAssistantMessage(""),
			makeModel(),
			makeContext(),
			run,
			0,
			{ mode: "emit" },
		);

		expect(outcome).toBe("stop");
		expect(push.mock.calls.map(([event]) => event.type)).not.toContain("toolcall_start");
		expect(push.mock.calls.some(([event]) => event.type === "done" && event.reason === "toolUse")).toBe(false);
	});

	it("indexes active runs per scope without letting an older release clear a newer run", async () => {
		const { coordinator } = makeCoordinator();
		const older = startRun(coordinator, { id: "older", scopeKey: "scope-a" });
		const newer = startRun(coordinator, { id: "newer", scopeKey: "scope-a" });
		const otherScope = startRun(coordinator, { id: "other", scopeKey: "scope-b" });

		expect(coordinator.getActiveForScope("scope-a")).toBe(newer);
		expect(coordinator.getActiveForScope("scope-b")).toBe(otherScope);

		await coordinator.release(older);

		expect(coordinator.getActiveForScope("scope-a")).toBe(newer);
		expect(coordinator.getActiveForScope("scope-b")).toBe(otherScope);
	});

	it("ignores future SDK turn usage after a split turn times out", async () => {
		vi.useFakeTimers();
		const { coordinator } = makeCoordinator();
		const run = startRun(coordinator);

		coordinator.ignoreFutureSdkTurnUsage(run);
		coordinator.queueEvent(run, { type: "text-delta", text: "next turn started" });
		coordinator.recordSdkTurnEnded(run, { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 });
		await vi.advanceTimersByTimeAsync(1000);
		coordinator.recordSdkTurnEnded(run, { inputTokens: 5, outputTokens: 6, cacheReadTokens: 7, cacheWriteTokens: 8 });

		expect(coordinator.takeSdkTurnUsage(run)).toBeUndefined();
	});

	it("serializes run leases", async () => {
		const { coordinator } = makeCoordinator();
		const run = startRun(coordinator);
		const order: string[] = [];
		let releaseFirst: () => void = () => {};

		const firstLease = coordinator.withRunLease(run, undefined, async () => {
			order.push("first-enter");
			await new Promise<void>((resolve) => {
				releaseFirst = resolve;
			});
			order.push("first-exit");
		});
		const secondLease = coordinator.withRunLease(run, undefined, async () => {
			order.push("second-enter");
		});

		await vi.waitFor(() => expect(order).toEqual(["first-enter"]));
		releaseFirst();
		await Promise.all([firstLease, secondLease]);

		expect(order).toEqual(["first-enter", "first-exit", "second-enter"]);
	});

	it("defers idle disposal while a run is leased", async () => {
		vi.useFakeTimers();
		const { coordinator, abandonSessionAgent } = makeCoordinator({ idleDisposeMs: 5 });
		const run = startRun(coordinator);
		const sdkCancel = vi.fn().mockResolvedValue(undefined);
		coordinator.attachSdkRun(run, { cancel: sdkCancel });
		let releaseLease: () => void = () => {};
		let leaseWaiting = false;

		const lease = coordinator.withRunLease(run, undefined, async () => {
			coordinator.requestIdleDispose(run);
			await vi.advanceTimersByTimeAsync(20);
			expect(coordinator.count()).toBe(1);
			expect(sdkCancel).not.toHaveBeenCalled();
			leaseWaiting = true;
			await new Promise<void>((resolve) => {
				releaseLease = resolve;
			});
		});

		await vi.waitFor(() => expect(leaseWaiting).toBe(true));
		releaseLease();
		await lease;
		await vi.advanceTimersByTimeAsync(4);
		expect(coordinator.count()).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		await vi.waitFor(() => expect(coordinator.count()).toBe(0));
		expect(sdkCancel).toHaveBeenCalledTimes(1);
		expect(abandonSessionAgent).toHaveBeenCalledWith("scope-1");
	});

	it("releases successful runs idempotently without abandoning pooled session resources", async () => {
		vi.useFakeTimers();
		const { coordinator, deleteNativeToolDisplay, abandonSessionAgent } = makeCoordinator({ idleDisposeMs: 5 });
		const bridgeRun = makeBridgeRun("non-session-bridge");
		const sessionBridgeRun = makeBridgeRun("session-bridge");
		const run = startRun(coordinator, { bridgeRun, sessionBridgeRun });
		const sdkCancel = vi.fn().mockResolvedValue(undefined);
		coordinator.attachSdkRun(run, { cancel: sdkCancel });
		run.recordedToolDisplayIds.push("tool-1", "tool-2");
		const waitForProgress = coordinator.waitForProgress(run);

		coordinator.markFinished(run, "done");
		await waitForProgress;
		await coordinator.release(run);
		await coordinator.release(run);
		await vi.advanceTimersByTimeAsync(10);

		expect(coordinator.count()).toBe(0);
		expect(deleteNativeToolDisplay).toHaveBeenCalledTimes(2);
		expect(deleteNativeToolDisplay).toHaveBeenCalledWith("tool-1");
		expect(deleteNativeToolDisplay).toHaveBeenCalledWith("tool-2");
		expect(bridgeRun.cancel).toHaveBeenCalledTimes(1);
		expect(bridgeRun.dispose).toHaveBeenCalledTimes(1);
		expect(sessionBridgeRun.setOnToolRequest).toHaveBeenCalledTimes(1);
		expect(sessionBridgeRun.setOnToolRequest).toHaveBeenCalledWith(undefined);
		expect(sessionBridgeRun.dispose).not.toHaveBeenCalled();
		expect(sdkCancel).not.toHaveBeenCalled();
		expect(abandonSessionAgent).not.toHaveBeenCalled();
	});

	it("releases unsuccessful session-bridge runs idempotently and abandons the session agent", async () => {
		const { coordinator, deleteNativeToolDisplay, abandonSessionAgent } = makeCoordinator();
		const sessionBridgeRun = makeBridgeRun("session-bridge");
		const run = startRun(coordinator, { bridgeRun: sessionBridgeRun, sessionBridgeRun, scopeKey: "scope-error" });
		const sdkCancel = vi.fn().mockResolvedValue(undefined);
		coordinator.attachSdkRun(run, { cancel: sdkCancel });
		run.recordedToolDisplayIds.push("tool-1");
		const waitForProgress = coordinator.waitForProgress(run);

		await coordinator.release(run);
		await waitForProgress;
		await coordinator.release(run);

		expect(coordinator.count()).toBe(0);
		expect(deleteNativeToolDisplay).toHaveBeenCalledOnce();
		expect(sessionBridgeRun.cancel).toHaveBeenCalledTimes(1);
		expect(sessionBridgeRun.setOnToolRequest).toHaveBeenCalledWith(undefined);
		expect(sessionBridgeRun.dispose).not.toHaveBeenCalled();
		expect(sdkCancel).toHaveBeenCalledTimes(1);
		expect(abandonSessionAgent).toHaveBeenCalledOnce();
		expect(abandonSessionAgent).toHaveBeenCalledWith("scope-error");
	});

	it("suppresses process-level SDK abort errors while cancelling an abandoned live run", async () => {
		const { coordinator, abandonSessionAgent } = makeCoordinator();
		const run = startRun(coordinator, { scopeKey: "scope-abort" });
		const sdkCancelError = makeCursorSdkAbortConnectError();
		const sdkCancel = vi.fn().mockImplementation(async () => {
			process.emit("uncaughtException", sdkCancelError, "uncaughtException");
			throw sdkCancelError;
		});
		coordinator.attachSdkRun(run, { cancel: sdkCancel });
		let listenerCalled = false;
		const listener = () => {
			listenerCalled = true;
		};
		process.once("uncaughtException", listener);

		try {
			await coordinator.release(run);
		} finally {
			process.removeListener("uncaughtException", listener);
		}

		expect(listenerCalled).toBe(false);
		expect(sdkCancel).toHaveBeenCalledOnce();
		expect(abandonSessionAgent).toHaveBeenCalledWith("scope-abort");
		expect(cursorSdkProcessGuardTestUtils.activeProviderTurnCount()).toBe(0);
	});

	it("matches bridge tool results when no native replay id is present", () => {
		const { coordinator } = makeCoordinator();
		const bridgeRun = makeBridgeRun("bridge-1", ["pi-call-1"]);
		const run = startRun(coordinator, { id: "bridge-1", bridgeRun });
		const context = makeContext([
			{ role: "user", content: "run bridge", timestamp: 1 },
			{ role: "toolResult", toolCallId: "pi-call-1", toolName: "read", content: [], isError: false, timestamp: 2 },
		]);

		expect(coordinator.getPendingFromContext(context, replayIdFromToolCallId)).toBe(run);
	});
});
