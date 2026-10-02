import { CursorLiveRunAbortError } from "./cursor-live-run-coordinator.js";
import { CursorPartialContentEmitter } from "./cursor-partial-content-emitter.js";
import {
	cursorLiveRuns,
	drainCursorLiveRunTurn,
	flushPendingCursorLiveRunTraceEventsToStream,
	settleCursorLiveToolBatch,
} from "./cursor-provider-live-run-drain.js";
import {
	buildIncompleteCursorToolRunOutcome,
	type IncompleteCursorToolRunOutcomeInput,
} from "./cursor-incomplete-tool-visibility.js";
import type {
	CursorProviderTurnPrepareResult,
	CursorProviderTurnRunnerParams,
} from "./cursor-provider-turn-types.js";
import type { CursorSdkEventDebugSink } from "./cursor-sdk-event-debug.js";

export interface EmitCursorLiveTurnParams {
	params: CursorProviderTurnRunnerParams;
	prepared: CursorProviderTurnPrepareResult;
	sdkEventDebug: CursorSdkEventDebugSink | undefined;
	discardIncompleteTools: (outcome: IncompleteCursorToolRunOutcomeInput) => void;
}

export async function emitCursorLiveTurn(emitParams: EmitCursorLiveTurnParams): Promise<void> {
	const { params, prepared, sdkEventDebug, discardIncompleteTools } = emitParams;
	if (prepared.runtime.kind !== "live") throw new Error("emitCursorLiveTurn requires a live run");
	const { liveRun, turnCoordinator } = prepared.runtime;

	const { options, model } = params;
	// Drain and abort recovery write to the same partial. Keep its open text block
	// and deferred message boundary together; a new Pi turn still gets a new emitter.
	const emitter = new CursorPartialContentEmitter(params.stream, params.partial, -1, true);
	try {
		await cursorLiveRuns.withRunLease(liveRun, options?.signal, async () => {
			await cursorLiveRuns.waitForProgress(liveRun, options?.signal);
			await settleCursorLiveToolBatch(liveRun);
			turnCoordinator.closeTraceBlock();
			await drainCursorLiveRunTurn(params.stream, params.partial, model, params.context, liveRun, 0, {
				mode: "emit",
				emitter,
				signal: options?.signal,
				debugRecorder: sdkEventDebug,
			});
		});
	} catch (caught) {
		if (caught instanceof CursorLiveRunAbortError) {
			discardIncompleteTools({ status: "cancelled", signalAborted: true });
			turnCoordinator.closeTraceBlock();
			flushPendingCursorLiveRunTraceEventsToStream(params.stream, params.partial, liveRun, {
				includeTracesBehindQueuedTools: true,
				emitter,
			});
		}
		throw caught;
	}
}

export function discardIncompleteToolsFromPrepared(
	prepared: CursorProviderTurnPrepareResult | undefined,
	outcome: IncompleteCursorToolRunOutcomeInput,
): void {
	prepared?.runtime.turnCoordinator.discardIncompleteStartedToolCalls(buildIncompleteCursorToolRunOutcome(outcome));
}
