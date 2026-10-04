import type { LocalAgentStore, RunError, SDKAgent } from "@cursor/sdk";
import { loadCursorTranscriptWebToolCallsAfterOffset } from "./cursor-agent-message-web-tools.js";
import {
	collectCursorCloudRunReport,
	formatCursorCloudRunReport,
	type CursorCloudRunReport,
} from "./cursor-cloud-reporting.js";
import { getCheckpointContextWindow, saveCachedContextWindow } from "./context-window-cache.js";
import { scrubSensitiveText } from "./cursor-sensitive-text.js";
import type { CursorSdkEventDebugSink } from "./cursor-sdk-event-debug.js";
import type { CursorSdkTurnCoordinator } from "./cursor-provider-turn-coordinator.js";
import {
	isCursorRunFinishedSuccessfully,
	resolveCursorRunOutcome,
	type CursorRunOutcome,
} from "./cursor-provider-run-outcome.js";
import type { StartedCursorProviderTurn } from "./cursor-provider-turn-types.js";
import { loadCursorSdk } from "./cursor-sdk-runtime.js";

export async function cacheSdkContextWindow(
	agentId: string,
	modelId: string,
	cwd?: string,
	store?: LocalAgentStore,
): Promise<void> {
	try {
		const { createAgentPlatform } = await loadCursorSdk();
		const platform = await createAgentPlatform(
			cwd || store
				? {
						...(cwd ? { workspaceRef: cwd, scopedWorkspaceRef: cwd } : {}),
						...(store ? { localStore: store } : {}),
					}
				: undefined,
		);
		const checkpoint = await platform.checkpointStore.loadLatest(agentId);
		const contextWindow = getCheckpointContextWindow(checkpoint);
		if (contextWindow) saveCachedContextWindow(modelId, contextWindow);
	} catch {
		// Context-window cache failures must not affect response streaming.
	}
}

export interface BuildCursorRunOutcomeParams {
	waitResult: Awaited<ReturnType<Awaited<ReturnType<SDKAgent["send"]>>["wait"]>>;
	prepared: StartedCursorProviderTurn;
	signal?: AbortSignal;
	runResultFallback?: string;
	runErrorFallback?: RunError;
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
		runErrorFallback: params.runErrorFallback,
		resolvedApiKey: params.resolvedApiKey,
		optionsApiKey: params.optionsApiKey,
		runtimeTarget: prepared.runtimeTarget,
	});
}

async function replayCursorTranscriptWebToolCalls(
	agentId: string,
	cwd: string,
	messageOffset: number | undefined,
	turnStore: LocalAgentStore,
	turnCoordinator: CursorSdkTurnCoordinator,
	sdkEventDebug: CursorSdkEventDebugSink | undefined,
): Promise<void> {
	try {
		const transcriptToolCalls = await loadCursorTranscriptWebToolCallsAfterOffset({
			agentId,
			cwd,
			offset: messageOffset,
			store: turnStore,
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

function scrubCursorCloudReportingError(error: unknown, apiKey: string | undefined): Error {
	return new Error(scrubSensitiveText(error instanceof Error ? error.message : String(error), apiKey));
}

function recordCursorCloudReportingError(
	sdkEventDebug: CursorSdkEventDebugSink | undefined,
	error: unknown,
	apiKey: string | undefined,
): void {
	try {
		sdkEventDebug?.recordError("cloud_run_report", scrubCursorCloudReportingError(error, apiKey));
	} catch {
		// Debug reporting must never affect provider execution.
	}
}

export interface AwaitFinalizeCursorRunOutcomeParams {
	run: Awaited<ReturnType<SDKAgent["send"]>>;
	prepared: StartedCursorProviderTurn;
	cursorAgentMessageOffset: number | undefined;
	modelId: string;
	signal?: AbortSignal;
	runResultFallback?: string;
	runErrorFallback?: RunError;
	resolvedApiKey?: string;
	optionsApiKey?: string;
	sdkEventDebug?: CursorSdkEventDebugSink;
	waitResult?: Awaited<ReturnType<Awaited<ReturnType<SDKAgent["send"]>>["wait"]>>;
	cacheContextWindow?: boolean;
	/** Session agent id for checkpoint cache; defaults to run.agentId when omitted. */
	contextWindowAgentId?: string;
}

export interface FinalizedCursorRunOutcome {
	outcome: CursorRunOutcome;
	displayOnlyTraceBlock?: string;
}

export async function recordCursorProviderTerminalUsage(
	prepared: StartedCursorProviderTurn,
	status: "success" | "error" | "abort",
	waitUsage?: unknown,
) {
	if (prepared.runtime.usageTerminalRecorded) return undefined;
	prepared.runtime.usageTerminalRecorded = true;
	try {
		return await prepared.usage.recordTerminal({ status, waitUsage, handleUsage: prepared.runtime.sdkRun?.usage });
	} catch (error) {
		prepared.usage.notePersistenceFailure(error);
		return undefined;
	}
}

/** Single wait/finalize path for SDK runs: accounting, replay, incomplete tools, artifacts, context cache. */
export async function awaitFinalizeCursorRunOutcome(params: AwaitFinalizeCursorRunOutcomeParams): Promise<FinalizedCursorRunOutcome> {
	const apiKey = params.resolvedApiKey ?? params.optionsApiKey;
	params.prepared.runtime.sdkRun = params.run;
	let waitResult: Awaited<ReturnType<typeof params.run.wait>>;
	try {
		waitResult = params.waitResult ?? (await params.run.wait());
	} catch (error) {
		await recordCursorProviderTerminalUsage(params.prepared, params.signal?.aborted ? "abort" : "error");
		throw error;
	}
	const outcome = buildCursorRunOutcomeFromWait({
		waitResult,
		prepared: params.prepared,
		signal: params.signal,
		runResultFallback: params.runResultFallback,
		runErrorFallback: params.runErrorFallback,
		resolvedApiKey: params.resolvedApiKey,
		optionsApiKey: params.optionsApiKey,
	});
	const billing = await recordCursorProviderTerminalUsage(
		params.prepared,
		outcome.kind === "finished" ? "success" : outcome.kind === "cancelled" ? "abort" : "error",
		waitResult.usage,
	);
	let displayOnlyTraceBlock: string | undefined;
	if (params.prepared.runtimeTarget === "cloud" && isCursorRunFinishedSuccessfully(outcome)) {
		let report: CursorCloudRunReport = { agentId: params.run.agentId, runId: params.run.id, branches: [] };
		try {
			report = await collectCursorCloudRunReport({
				agent: params.prepared.agent,
				run: params.run,
				waitResult,
				apiKey,
				agentUsage: billing ? billing.status === "observed-pending-settlement" ? billing.snapshot : null : undefined,
			});
		} catch (error) {
			recordCursorCloudReportingError(params.sdkEventDebug, error, apiKey);
		}
		try {
			params.prepared.recordCloudLifecycle(report, apiKey);
		} catch (error) {
			recordCursorCloudReportingError(params.sdkEventDebug, error, apiKey);
		}
		try {
			params.sdkEventDebug?.recordProviderEvent("cloud_run_report", report);
		} catch (error) {
			recordCursorCloudReportingError(params.sdkEventDebug, error, apiKey);
		}
		try {
			displayOnlyTraceBlock = formatCursorCloudRunReport(report, { apiKey });
		} catch (error) {
			recordCursorCloudReportingError(params.sdkEventDebug, error, apiKey);
		}
	}
	try {
		params.sdkEventDebug?.recordWaitResult(waitResult);
	} catch {
		// Debug reporting must never affect provider execution.
	}
	if (params.prepared.runtimeTarget === "local" && params.prepared.execution === "conversation" && isCursorRunFinishedSuccessfully(outcome)) {
		await replayCursorTranscriptWebToolCalls(
			params.run.agentId,
			params.prepared.cwd,
			params.cursorAgentMessageOffset,
			params.prepared.store,
			params.prepared.runtime.turnCoordinator,
			params.sdkEventDebug,
		);
	}
	params.prepared.runtime.turnCoordinator.discardIncompleteStartedToolCalls(outcome.incompleteTools);
	try {
		await params.sdkEventDebug?.captureRunArtifacts(params.run);
	} catch {
		// Debug artifact failures must never affect provider execution.
	}
	if (params.prepared.runtimeTarget === "local" && params.prepared.execution === "conversation" && params.cacheContextWindow !== false) {
		await cacheSdkContextWindow(
			params.contextWindowAgentId ?? params.run.agentId,
			params.modelId,
			params.prepared.cwd,
			params.prepared.store,
		);
	}
	return { outcome, displayOnlyTraceBlock };
}
