import { describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, AssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { LocalAgentStore, SDKAgent } from "@cursor/sdk";
import { buildIncompleteCursorToolRunOutcome } from "../src/cursor-incomplete-tool-visibility.js";
import { CursorRunFinalizer } from "../src/cursor-provider-run-finalizer.js";
import { CursorSdkTurnCoordinator } from "../src/cursor-provider-turn-coordinator.js";
import type { LiveCursorProviderTurnRuntime, LocalCursorProviderTurnPrepareResult, StartedCursorProviderTurn } from "../src/cursor-provider-turn-types.js";
import { installCursorSdkProcessErrorGuard } from "../src/cursor-sdk-process-error-guard.js";
import type { CursorSdkEventDebugSink } from "../src/cursor-sdk-event-debug.js";
import { createCursorLiveRunAccountingState } from "../src/cursor-live-run-accounting.js";
import { captureProviderTestOwnership, createProviderTestTurnUsage } from "./helpers/cursor-provider-ownership.js";
import { asMockCursorRun } from "./helpers/cursor-provider-harness.js";
import { collectAssistantEvents, makeAssistantMessage, makeContext, makeModel } from "./helpers/pi-harness.js";

const { mockAwaitFinalizeCursorRunOutcome } = vi.hoisted(() => {
	const waitCompletion = new Promise<void>(() => {});
	return { mockAwaitFinalizeCursorRunOutcome: vi.fn(() => waitCompletion) };
});

vi.mock("../src/cursor-provider-turn-finalize.js", async (importOriginal) => ({
	...await importOriginal<typeof import("../src/cursor-provider-turn-finalize.js")>(),
	awaitFinalizeCursorRunOutcome: mockAwaitFinalizeCursorRunOutcome,
}));

function makePrepared(
	stream: AssistantMessageEventStream,
	partial: AssistantMessage,
	commitSend = () => {},
	trackRunCompletion = (_completion: Promise<unknown>) => {},
): StartedCursorProviderTurn & LocalCursorProviderTurnPrepareResult {
	const agent = { agentId: "agent-1" } as SDKAgent;
	const store = {} as LocalAgentStore;
	const storeIdentity = { version: 1 as const, stateRoot: "/tmp/store" };
	return {
		usage: createProviderTestTurnUsage(),
		runtimeTarget: "local", execution: "conversation", agent, store, storeIdentity,
		cwd: process.cwd(), payload: { text: "hello" },
		meta: {
			sendPlan: { mode: "incremental", reason: "incremental", resetAgent: false },
			prompt: { text: "hello", images: [] }, bootstrap: false, promptInputTokens: 0,
			useNativeToolReplay: false, bridgeEnabled: false, nativeReplayId: "replay-1",
			agentMode: "agent", modelSelection: { id: "composer-2.5" },
		},
		localForce: { value: false, source: "builtin", trustLevel: "builtin" },
		contextWindowAgentId: "agent-1", textDeltas: [], sessionAgentScopeKey: "scope-1",
		sessionAgentLease: {
			scopeKey: "scope-1", poolKey: "pool-1", instanceId: 1, agent, store, storeIdentity,
			sendState: { bootstrapped: false, contextFingerprint: "", incrementalSendCount: 0 },
			created: false, commitSend, trackRunCompletion,
		},
		restoreCursorSdkOutputFilter: () => {},
		lifecycle: { commitSend, trackRunCompletion, abandon: async () => {}, dispose: async () => {} },
		runtime: {
			kind: "direct",
			turnCoordinator: new CursorSdkTurnCoordinator({
				stream, partial, cwd: process.cwd(), useNativeToolReplay: false,
				nativeReplayId: "replay-1", textDeltas: [],
			}),
		},
	};
}

const finishedOutcome = () => ({
	kind: "finished" as const,
	waitResult: { id: "run-1", status: "finished" as const, result: "ok", durationMs: 1, model: { id: "composer-2.5" } },
	finalText: "ok",
	incompleteTools: buildIncompleteCursorToolRunOutcome({ status: "finished", assistantTextProduced: true }),
	assistantTextProduced: true,
});

function makeFinalizer(stream: AssistantMessageEventStream, partial: AssistantMessage, debugSink: CursorSdkEventDebugSink, signal?: AbortSignal) {
	const guard = installCursorSdkProcessErrorGuard();
	const finalizer = new CursorRunFinalizer({
		runnerParams: { ...captureProviderTestOwnership(makeModel(), makeContext()), model: makeModel(), context: makeContext(), stream, partial, options: { signal }, sdkEventDebugRef: {} },
		sdkEventDebug: () => debugSink, sdkProcessErrorGuard: guard,
		resolvedApiKey: () => "test-key", runtimeTarget: () => "local",
	});
	return { finalizer, guard };
}

describe("CursorRunFinalizer", () => {
	it.each([false, true])("settles live-run ownership before debug writes after wait failure (aborted: %s)", async aborted => {
		const trackRunCompletion = vi.fn();
		mockAwaitFinalizeCursorRunOutcome.mockRejectedValueOnce(new Error("run wait failed"));
		const stream = createAssistantMessageEventStream();
		const partial = makeAssistantMessage("");
		const base = makePrepared(stream, partial, () => {}, trackRunCompletion);
		const prepared: StartedCursorProviderTurn & LocalCursorProviderTurnPrepareResult & { runtime: LiveCursorProviderTurnRuntime } = {
			...base,
			runtime: {
				kind: "live", turnCoordinator: base.runtime.turnCoordinator,
				liveRun: {
					id: "replay-1", agent: base.agent, sessionAgentScopeKey: "scope-1",
					accounting: createCursorLiveRunAccountingState(0), pendingEvents: [], textDeltas: [],
					emittedText: "", recordedToolDisplayIds: [], done: false, cancelled: false,
					disposed: false, chainUserInputAfterCompletion: false,
				},
			},
		};
		const captureRunArtifacts = vi.fn(() => new Promise<void>(() => {}));
		const debugSink = {
			recordWaitResult: () => { throw new Error("debug wait write failed"); },
			recordError: () => { throw new Error("debug error write failed"); },
			captureRunArtifacts,
		} as unknown as CursorSdkEventDebugSink;
		const { finalizer, guard } = makeFinalizer(stream, partial, debugSink, aborted ? AbortSignal.abort() : undefined);
		try {
			finalizer.startLiveRunCompletion({
				send: { run: asMockCursorRun({ id: "run-1", agentId: "agent-1", status: "running", wait: vi.fn(), cancel: vi.fn() }), cursorAgentMessageOffset: 0 },
				prepared, modelId: "composer-2.5", discardIncompleteTools: () => {},
			});
			expect(mockAwaitFinalizeCursorRunOutcome).toHaveBeenCalledTimes(1);
			expect(trackRunCompletion).toHaveBeenCalledTimes(1);
			await expect(trackRunCompletion.mock.calls[0]?.[0]).resolves.toBeUndefined();
			expect(prepared.runtime.liveRun).toMatchObject(aborted
				? { done: true, cancelled: true, abortMessage: "Cancelled: prompt interrupted." }
				: { done: true, errorMessage: "run wait failed" });
			expect(captureRunArtifacts).not.toHaveBeenCalled();
		} finally { guard.dispose(); }
	});

	it("allows the error terminal path after direct terminal handling throws before emitting", async () => {
		const stream = createAssistantMessageEventStream();
		const partial = makeAssistantMessage("");
		const commitSend = () => { throw new Error("commit failed before terminal event"); };
		const prepared = makePrepared(stream, partial, commitSend);
		const debugSink = { recordError: () => { throw new Error("debug provider error write failed"); } } as unknown as CursorSdkEventDebugSink;
		const { finalizer, guard } = makeFinalizer(stream, partial, debugSink);
		try {
			await expect(finalizer.applyTerminalEvent({ kind: "direct", prepared, outcome: finishedOutcome() })).rejects.toThrow("commit failed before terminal event");
			await finalizer.applyTerminalEvent({ kind: "error", prepared, error: new Error("commit failed before terminal event") });
			stream.end();
			const events = await collectAssistantEvents(stream);
			expect(events.some(event => event.type === "error" && event.error.errorMessage?.includes("commit failed"))).toBe(true);
		} finally { guard.dispose(); }
	});

	it("does not reclassify a completed direct turn when debug cleanup fails", async () => {
		const stream = createAssistantMessageEventStream();
		const partial = makeAssistantMessage("");
		const prepared = makePrepared(stream, partial);
		const debugSink = { recordFinalPartial: () => {}, finalize: async () => { throw new Error("debug finalize failed"); } } as unknown as CursorSdkEventDebugSink;
		const { finalizer, guard } = makeFinalizer(stream, partial, debugSink);
		try {
			await finalizer.applyTerminalEvent({ kind: "direct", prepared, outcome: finishedOutcome() });
			await expect(finalizer.cleanup(prepared, undefined, undefined)).resolves.toBeUndefined();
			stream.end();
			const events = await collectAssistantEvents(stream);
			expect(events.filter(event => event.type === "done")).toHaveLength(1);
			expect(events.some(event => event.type === "error")).toBe(false);
		} finally { guard.dispose(); }
	});
});
