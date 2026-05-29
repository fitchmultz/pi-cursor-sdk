import { describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { SDKAgent } from "@cursor/sdk";
import { buildIncompleteCursorToolRunOutcome } from "../src/cursor-incomplete-tool-visibility.js";
import { CursorRunFinalizer } from "../src/cursor-provider-run-finalizer.js";
import { CursorSdkTurnCoordinator } from "../src/cursor-provider-turn-coordinator.js";
import type { CursorProviderTurnPrepareResult } from "../src/cursor-provider-turn-types.js";
import { installCursorSdkProcessErrorGuard } from "../src/cursor-sdk-process-error-guard.js";
import type { CursorSdkEventDebugSink } from "../src/cursor-sdk-event-debug.js";
import type { SessionCursorAgentLease } from "../src/cursor-session-agent.js";
import { createCursorLiveRunAccountingState } from "../src/cursor-live-run-accounting.js";
import { asMockCursorRun } from "./helpers/cursor-provider-harness.js";
import { collectAssistantEvents, makeAssistantMessage, makeContext, makeModel } from "./helpers/pi-harness.js";

const { mockAwaitFinalizeCursorRunOutcome, trackedWaitCompletion } = vi.hoisted(() => {
	const waitCompletion = new Promise<void>(() => {});
	return {
		trackedWaitCompletion: waitCompletion,
		mockAwaitFinalizeCursorRunOutcome: vi.fn(() => waitCompletion),
	};
});

vi.mock("../src/cursor-provider-turn-finalize.js", () => ({
	awaitFinalizeCursorRunOutcome: mockAwaitFinalizeCursorRunOutcome,
	cacheSdkContextWindow: vi.fn(),
}));

describe("CursorRunFinalizer", () => {
	it("marks the pooled session agent busy when live run completion starts", () => {
		const trackRunCompletion = vi.fn();
		const prepared: CursorProviderTurnPrepareResult = {
			agent: { agentId: "agent-1" } as SDKAgent,
			cwd: process.cwd(),
			payload: { text: "hello" },
			meta: {
				sendPlan: { mode: "incremental", reason: "incremental", resetAgent: false },
				prompt: { text: "hello", images: [] },
				bootstrap: false,
				promptInputTokens: 0,
				useNativeToolReplay: true,
				bridgeEnabled: false,
				nativeReplayId: "replay-1",
				agentMode: "agent",
			},
			contextWindowAgentId: "agent-1",
			textDeltas: [],
			sessionAgentScopeKey: "scope-1",
			sessionAgentLease: {
				scopeKey: "scope-1",
				poolKey: "pool-1",
				instanceId: 1,
				agent: { agentId: "agent-1" } as SDKAgent,
				sendState: { bootstrapped: false, contextFingerprint: "", incrementalSendCount: 0 },
				created: false,
				commitSend: () => {},
				trackRunCompletion,
			} satisfies SessionCursorAgentLease,
			restoreCursorSdkOutputFilter: () => {},
			runtime: {
				kind: "live",
				liveRun: {
					id: "replay-1",
					agent: { agentId: "agent-1" } as SDKAgent,
					sessionAgentScopeKey: "scope-1",
					accounting: createCursorLiveRunAccountingState(0),
					pendingEvents: [],
					textDeltas: [],
					emittedText: "",
					recordedToolDisplayIds: [],
					done: false,
					cancelled: false,
					disposed: false,
					chainUserInputAfterCompletion: false,
				},
				turnCoordinator: new CursorSdkTurnCoordinator({
					stream: createAssistantMessageEventStream(),
					partial: makeAssistantMessage(""),
					cwd: process.cwd(),
					useNativeToolReplay: true,
					nativeReplayId: "replay-1",
					textDeltas: [],
				}),
			},
		};
		const finalizer = new CursorRunFinalizer({
			runnerParams: {
				model: makeModel(),
				context: makeContext(),
				stream: createAssistantMessageEventStream(),
				partial: makeAssistantMessage(""),
				sdkEventDebugRef: {},
			},
			sdkEventDebug: () => undefined,
			sdkProcessErrorGuard: installCursorSdkProcessErrorGuard(),
			resolvedApiKey: () => "test-key",
		});
		finalizer.startLiveRunCompletion({
			send: {
				run: asMockCursorRun({
					id: "run-1",
					agentId: "agent-1",
					status: "running",
					wait: vi.fn(),
					cancel: vi.fn(),
				}),
				cursorAgentMessageOffset: 0,
			},
			prepared,
			modelId: "composer-2.5",
			discardIncompleteTools: () => {},
		});

		expect(mockAwaitFinalizeCursorRunOutcome).toHaveBeenCalledTimes(1);
		expect(trackRunCompletion).toHaveBeenCalledWith(trackedWaitCompletion);
	});

	it("allows the error terminal path after direct terminal handling throws before emitting", async () => {
		const stream = createAssistantMessageEventStream();
		const partial = makeAssistantMessage("");
		const context = makeContext();
		const model = makeModel();
		const sdkProcessErrorGuard = installCursorSdkProcessErrorGuard();
		const turnCoordinator = new CursorSdkTurnCoordinator({
			stream,
			partial,
			cwd: process.cwd(),
			useNativeToolReplay: false,
			nativeReplayId: "replay-1",
			textDeltas: [],
		});
		const prepared: CursorProviderTurnPrepareResult = {
			agent: { agentId: "agent-1" } as SDKAgent,
			cwd: process.cwd(),
			payload: { text: "hello" },
			meta: {
				sendPlan: { mode: "incremental", reason: "incremental", resetAgent: false },
				prompt: { text: "hello", images: [] },
				bootstrap: false,
				promptInputTokens: 0,
				useNativeToolReplay: false,
				bridgeEnabled: false,
				nativeReplayId: "replay-1",
				agentMode: "agent",
			},
			contextWindowAgentId: "agent-1",
			textDeltas: [],
			sessionAgentScopeKey: "scope-1",
			sessionAgentLease: {
				scopeKey: "scope-1",
				poolKey: "pool-1",
				instanceId: 1,
				agent: { agentId: "agent-1" } as SDKAgent,
				sendState: { bootstrapped: false, contextFingerprint: "", incrementalSendCount: 0 },
				created: true,
				commitSend: () => {
					throw new Error("commit failed before terminal event");
				},
				trackRunCompletion: () => {},
			} satisfies SessionCursorAgentLease,
			restoreCursorSdkOutputFilter: () => {},
			runtime: { kind: "direct", turnCoordinator },
		};
		const finalizer = new CursorRunFinalizer({
			runnerParams: {
				model,
				context,
				stream,
				partial,
				sdkEventDebugRef: {},
			},
			sdkEventDebug: () => undefined,
			sdkProcessErrorGuard,
			resolvedApiKey: () => undefined,
		});

		await expect(
			finalizer.applyTerminalEvent({
				kind: "direct",
				prepared,
				outcome: {
					kind: "finished",
					waitResult: {
						id: "run-1",
						status: "finished",
						result: "ok",
						durationMs: 1,
						model: { id: "composer-2.5" },
					},
					finalText: "ok",
					incompleteTools: buildIncompleteCursorToolRunOutcome({ status: "finished", assistantTextProduced: true }),
					assistantTextProduced: true,
				},
			}),
		).rejects.toThrow("commit failed before terminal event");

		await finalizer.applyTerminalEvent({
			kind: "error",
			prepared,
			error: new Error("commit failed before terminal event"),
		});

		stream.end();
		const events = await collectAssistantEvents(stream);
		expect(events.some((event) => event.type === "error" && event.error.errorMessage?.includes("commit failed"))).toBe(true);
		sdkProcessErrorGuard.dispose();
	});

	it("does not reclassify a completed direct turn when debug cleanup fails", async () => {
		const stream = createAssistantMessageEventStream();
		const partial = makeAssistantMessage("");
		const context = makeContext();
		const model = makeModel();
		const sdkProcessErrorGuard = installCursorSdkProcessErrorGuard();
		const turnCoordinator = new CursorSdkTurnCoordinator({
			stream,
			partial,
			cwd: process.cwd(),
			useNativeToolReplay: false,
			nativeReplayId: "replay-1",
			textDeltas: [],
		});
		const prepared: CursorProviderTurnPrepareResult = {
			agent: { agentId: "agent-1" } as SDKAgent,
			cwd: process.cwd(),
			payload: { text: "hello" },
			meta: {
				sendPlan: { mode: "incremental", reason: "incremental", resetAgent: false },
				prompt: { text: "hello", images: [] },
				bootstrap: false,
				promptInputTokens: 0,
				useNativeToolReplay: false,
				bridgeEnabled: false,
				nativeReplayId: "replay-1",
				agentMode: "agent",
			},
			contextWindowAgentId: "agent-1",
			textDeltas: [],
			sessionAgentScopeKey: "scope-1",
			sessionAgentLease: {
				scopeKey: "scope-1",
				poolKey: "pool-1",
				instanceId: 1,
				agent: { agentId: "agent-1" } as SDKAgent,
				sendState: { bootstrapped: false, contextFingerprint: "", incrementalSendCount: 0 },
				created: true,
				commitSend: () => {},
				trackRunCompletion: () => {},
			} satisfies SessionCursorAgentLease,
			restoreCursorSdkOutputFilter: () => {},
			runtime: { kind: "direct", turnCoordinator },
		};
		const debugSink = {
			recordFinalPartial: () => {},
			finalize: async () => {
				throw new Error("debug finalize failed");
			},
		} as unknown as CursorSdkEventDebugSink;
		const finalizer = new CursorRunFinalizer({
			runnerParams: {
				model,
				context,
				stream,
				partial,
				sdkEventDebugRef: {},
			},
			sdkEventDebug: () => debugSink,
			sdkProcessErrorGuard,
			resolvedApiKey: () => undefined,
		});

		await finalizer.applyTerminalEvent({
			kind: "direct",
			prepared,
			outcome: {
				kind: "finished",
				waitResult: {
					id: "run-1",
					status: "finished",
					result: "ok",
					durationMs: 1,
					model: { id: "composer-2.5" },
				},
				finalText: "ok",
				incompleteTools: buildIncompleteCursorToolRunOutcome({ status: "finished", assistantTextProduced: true }),
				assistantTextProduced: true,
			},
		});
		await expect(finalizer.cleanup(prepared, undefined, undefined)).resolves.toBeUndefined();

		stream.end();
		const events = await collectAssistantEvents(stream);
		expect(events.filter((event) => event.type === "done")).toHaveLength(1);
		expect(events.some((event) => event.type === "error")).toBe(false);
	});
});
