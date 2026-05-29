import type { SDKAgent } from "@cursor/sdk";
import { loadCursorTranscriptWebToolCallsAfterOffset } from "./cursor-agent-message-web-tools.js";
import { getCheckpointContextWindow, saveCachedContextWindow } from "./context-window-cache.js";
import type { CursorSdkEventDebugSink } from "./cursor-sdk-event-debug.js";
import type { CursorSdkTurnCoordinator } from "./cursor-provider-turn-coordinator.js";
import {
	isCursorRunFinishedSuccessfully,
	resolveCursorRunOutcome,
	type CursorRunOutcome,
} from "./cursor-provider-run-outcome.js";
import type { CursorProviderTurnPrepareResult } from "./cursor-provider-turn-types.js";
import { loadCursorSdk } from "./cursor-sdk-runtime.js";

export async function cacheSdkContextWindow(agentId: string, modelId: string): Promise<void> {
	try {
		const { createAgentPlatform } = await loadCursorSdk();
		const platform = await createAgentPlatform();
		const checkpoint = await platform.checkpointStore.loadLatest(agentId);
		const contextWindow = getCheckpointContextWindow(checkpoint);
		if (contextWindow) saveCachedContextWindow(modelId, contextWindow);
	} catch {
		// Context-window cache failures must not affect response streaming.
	}
}

export interface BuildCursorRunOutcomeParams {
	waitResult: Awaited<ReturnType<Awaited<ReturnType<SDKAgent["send"]>>["wait"]>>;
	prepared: CursorProviderTurnPrepareResult;
	signal?: AbortSignal;
	runResultFallback?: string;
	resolvedApiKey?: string;
	optionsApiKey?: string;
}

export function buildCursorRunOutcomeFromWait(params: BuildCursorRunOutcomeParams): CursorRunOutcome {
	const { waitResult, prepared } = params;
	const { turnCoordinator, liveRun } = prepared.runtime;
	const { textDeltas } = prepared;
	return resolveCursorRunOutcome({
		waitResult,
		signalAborted: params.signal?.aborted,
		textDeltas: liveRun?.textDeltas ?? textDeltas,
		emittedText: liveRun?.emittedText ?? textDeltas.join(""),
		planTextCandidate: turnCoordinator.planTextCandidate,
		selectFinalTextOptions: liveRun ? undefined : { allowPartialPrefix: true },
		runResultFallback: params.runResultFallback,
		resolvedApiKey: params.resolvedApiKey,
		optionsApiKey: params.optionsApiKey,
	});
}

async function replayCursorTranscriptWebToolCalls(
	agentId: string,
	cwd: string,
	messageOffset: number | undefined,
	turnCoordinator: CursorSdkTurnCoordinator,
	sdkEventDebug: CursorSdkEventDebugSink | undefined,
): Promise<void> {
	try {
		const transcriptToolCalls = await loadCursorTranscriptWebToolCallsAfterOffset({
			agentId,
			cwd,
			offset: messageOffset,
		});
		if (transcriptToolCalls.length === 0) return;
		sdkEventDebug?.recordCoordinatorEvent("cursor-transcript-web-tools", {
			agentId,
			messageOffset,
			count: transcriptToolCalls.length,
		});
		turnCoordinator.handleTranscriptCompletedToolCalls(transcriptToolCalls);
	} catch (error) {
		sdkEventDebug?.recordError("cursor_transcript_web_tools", error);
	}
}

export interface AwaitFinalizeCursorRunOutcomeParams {
	run: Awaited<ReturnType<SDKAgent["send"]>>;
	prepared: CursorProviderTurnPrepareResult;
	cursorAgentMessageOffset: number | undefined;
	modelId: string;
	signal?: AbortSignal;
	runResultFallback?: string;
	resolvedApiKey?: string;
	optionsApiKey?: string;
	sdkEventDebug?: CursorSdkEventDebugSink;
	waitResult?: Awaited<ReturnType<Awaited<ReturnType<SDKAgent["send"]>>["wait"]>>;
	cacheContextWindow?: boolean;
	/** Session agent id for checkpoint cache; defaults to run.agentId when omitted. */
	contextWindowAgentId?: string;
}

/** Single wait/finalize path for SDK runs: wait, debug capture, transcript replay, incomplete tools, artifacts, context cache. */
export async function awaitFinalizeCursorRunOutcome(params: AwaitFinalizeCursorRunOutcomeParams): Promise<CursorRunOutcome> {
	const waitResult = params.waitResult ?? (await params.run.wait());
	params.sdkEventDebug?.recordWaitResult(waitResult);
	const outcome = buildCursorRunOutcomeFromWait({
		waitResult,
		prepared: params.prepared,
		signal: params.signal,
		runResultFallback: params.runResultFallback,
		resolvedApiKey: params.resolvedApiKey,
		optionsApiKey: params.optionsApiKey,
	});
	if (isCursorRunFinishedSuccessfully(outcome)) {
		await replayCursorTranscriptWebToolCalls(
			params.run.agentId,
			params.prepared.cwd,
			params.cursorAgentMessageOffset,
			params.prepared.runtime.turnCoordinator,
			params.sdkEventDebug,
		);
	}
	params.prepared.runtime.turnCoordinator.discardIncompleteStartedToolCalls(outcome.incompleteTools);
	await params.sdkEventDebug?.captureRunArtifacts(params.run);
	if (params.cacheContextWindow !== false) {
		await cacheSdkContextWindow(params.contextWindowAgentId ?? params.run.agentId, params.modelId);
	}
	return outcome;
}
