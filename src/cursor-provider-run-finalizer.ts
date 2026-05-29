import type { AssistantMessage } from "@earendil-works/pi-ai";
import { cursorLiveRuns } from "./cursor-provider-live-run-drain.js";
import { abandonSessionCursorAgent } from "./cursor-provider-live-run-drain.js";
import {
	classifyCursorRunEmission,
	getCursorRunAbortMessage,
	type CursorRunOutcome,
} from "./cursor-provider-run-outcome.js";
import {
	formatCursorSdkAbortMessage,
	resolveCursorSdkAbortCause,
	sanitizeCursorProviderError,
} from "./cursor-provider-errors.js";
import { CursorLiveRunAbortError } from "./cursor-live-run-coordinator.js";
import type { IncompleteCursorToolRunOutcomeInput } from "./cursor-incomplete-tool-visibility.js";
import type { installCursorSdkProcessErrorGuard } from "./cursor-sdk-process-error-guard.js";
import type { CursorSdkEventDebugSink } from "./cursor-sdk-event-debug.js";
import { awaitFinalizeCursorRunOutcome } from "./cursor-provider-turn-finalize.js";
import type {
	CursorProviderTurnPrepareResult,
	CursorProviderTurnRunnerParams,
	CursorProviderTurnSend,
	CursorProviderTurnSendResult,
} from "./cursor-provider-turn-types.js";
import { applyCursorApproximateUsage } from "./cursor-usage-accounting.js";
import { hasUsableText } from "./cursor-record-utils.js";
import { buildIncompleteCursorToolRunOutcome } from "./cursor-incomplete-tool-visibility.js";

export type CursorTurnTerminalEvent =
	| {
			kind: "direct";
			prepared: CursorProviderTurnPrepareResult;
			outcome: CursorRunOutcome;
	  }
	| { kind: "error"; prepared: CursorProviderTurnPrepareResult | undefined; error: unknown };

function applyLiveRunOutcome(
	outcome: CursorRunOutcome,
	prepared: CursorProviderTurnPrepareResult,
	context: CursorProviderTurnRunnerParams["context"],
): void {
	if (prepared.runtime.kind !== "live" || prepared.runtime.liveRun.disposed) return;
	const { liveRun } = prepared.runtime;
	switch (classifyCursorRunEmission(outcome)) {
		case "finished":
			prepared.sessionAgentLease.commitSend(context, prepared.meta.bootstrap);
			cursorLiveRuns.markFinished(liveRun, outcome.kind === "finished" ? outcome.finalText : "");
			break;
		case "cancelled":
			cursorLiveRuns.markCancelled(liveRun, getCursorRunAbortMessage(outcome));
			break;
		case "failed":
			cursorLiveRuns.markError(liveRun, outcome.kind === "error" ? outcome.errorMessage : "Cursor SDK run failed.");
			break;
	}
}

export interface CursorLiveRunCompletion {
	waitCompletion: Promise<void>;
	prepared: CursorProviderTurnPrepareResult;
}

export interface CursorRunFinalizerParams {
	runnerParams: CursorProviderTurnRunnerParams;
	sdkEventDebug: () => CursorSdkEventDebugSink | undefined;
	sdkProcessErrorGuard: ReturnType<typeof installCursorSdkProcessErrorGuard>;
	resolvedApiKey: () => string | undefined;
}

export interface StartCursorLiveRunCompletionParams {
	send: CursorProviderTurnSend;
	prepared: CursorProviderTurnPrepareResult;
	modelId: string;
	discardIncompleteTools: (outcome: IncompleteCursorToolRunOutcomeInput) => void;
}

export class CursorRunFinalizer {
	private terminalApplied = false;

	constructor(private readonly params: CursorRunFinalizerParams) {}

	startLiveRunCompletion(startParams: StartCursorLiveRunCompletionParams): CursorLiveRunCompletion {
		const { runnerParams } = this.params;
		const sdkEventDebug = this.params.sdkEventDebug();
		const { send, prepared, modelId, discardIncompleteTools } = startParams;
		const { run, cursorAgentMessageOffset } = send;
		if (prepared.runtime.kind !== "live") throw new Error("startLiveRunCompletion requires a live run");
		const { liveRun } = prepared.runtime;
		const waitCompletion = awaitFinalizeCursorRunOutcome({
			run,
			prepared,
			cursorAgentMessageOffset,
			modelId,
			signal: runnerParams.options?.signal,
			runResultFallback: run.result,
			resolvedApiKey: this.params.resolvedApiKey(),
			optionsApiKey: runnerParams.options?.apiKey,
			sdkEventDebug,
			cacheContextWindow: true,
			contextWindowAgentId: liveRun.agent.agentId,
		})
			.then(async (outcome) => {
				applyLiveRunOutcome(outcome, prepared, runnerParams.context);
			})
			.catch(async (error: unknown) => {
				sdkEventDebug?.recordWaitResult({ status: "error", error: String(error) });
				sdkEventDebug?.recordError("run_wait", error);
				discardIncompleteTools({ status: "error" });
				await sdkEventDebug?.captureRunArtifacts(run);
				if (liveRun.disposed) return;
				cursorLiveRuns.markError(
					liveRun,
					sanitizeCursorProviderError(error, this.params.resolvedApiKey() ?? runnerParams.options?.apiKey),
				);
			});
		// Mark the pooled agent busy as soon as the SDK run exists so auto-compaction summarization
		// (and other concurrent acquires) wait for run.wait() instead of hitting AgentBusyError.
		prepared.sessionAgentLease.trackRunCompletion(waitCompletion);
		return { waitCompletion, prepared };
	}

	async applyTerminalEvent(event: CursorTurnTerminalEvent): Promise<void> {
		if (this.terminalApplied) return;
		if (event.kind === "direct") {
			await this.applyDirectOutcome(event.prepared, event.outcome);
			this.terminalApplied = true;
			return;
		}
		await this.applyErrorOutcome(event.prepared, event.error);
		this.terminalApplied = true;
	}

	async cleanup(
		prepared: CursorProviderTurnPrepareResult | undefined,
		sendResult: CursorProviderTurnSendResult | undefined,
		liveCompletion: CursorLiveRunCompletion | undefined,
	): Promise<void> {
		this.safeCleanup(() => prepared?.restoreCursorSdkOutputFilter());
		const abortRegistration = sendResult?.abortRegistration;
		if (abortRegistration) {
			this.safeCleanup(() => abortRegistration.signal.removeEventListener("abort", abortRegistration.listener));
		}
		this.params.runnerParams.sdkEventDebugRef.current = undefined;
		if (liveCompletion) {
			void liveCompletion.waitCompletion
				.finally(async () => {
					await this.finalizeSdkEventDebugBestEffort();
					this.safeCleanup(() => this.params.sdkProcessErrorGuard.dispose());
				})
				.catch(() => {});
			return;
		}
		await this.finalizeSdkEventDebugBestEffort();
		this.safeCleanup(() => this.params.sdkProcessErrorGuard.dispose());
	}

	private async applyDirectOutcome(
		prepared: CursorProviderTurnPrepareResult,
		outcome: CursorRunOutcome,
	): Promise<void> {
		const { stream, partial, model, context } = this.params.runnerParams;
		prepared.runtime.turnCoordinator.closeTraceBlock();
		switch (classifyCursorRunEmission(outcome)) {
			case "cancelled":
				await abandonSessionCursorAgent(prepared.sessionAgentScopeKey);
				this.pushTerminalError(partial, "aborted", getCursorRunAbortMessage(outcome));
				break;
			case "failed":
				await abandonSessionCursorAgent(prepared.sessionAgentScopeKey);
				this.pushTerminalError(partial, "error", outcome.kind === "error" ? outcome.errorMessage : "Cursor SDK run failed.");
				break;
			case "finished":
				prepared.sessionAgentLease.commitSend(context, prepared.meta.bootstrap);
				prepared.runtime.turnCoordinator.flushText(
					outcome.kind === "finished" && hasUsableText(outcome.finalText) ? [outcome.finalText] : [],
				);
				applyCursorApproximateUsage(partial, model, context, prepared.meta.promptInputTokens);
				stream.push({ type: "done", reason: "stop", message: partial });
				break;
		}
	}

	private async applyErrorOutcome(prepared: CursorProviderTurnPrepareResult | undefined, error: unknown): Promise<void> {
		this.params.sdkEventDebug()?.recordError("provider_stream", error);
		prepared?.runtime.turnCoordinator.discardIncompleteStartedToolCalls(
			buildIncompleteCursorToolRunOutcome({
				status: error instanceof CursorLiveRunAbortError ? "cancelled" : "error",
				signalAborted: error instanceof CursorLiveRunAbortError,
			}),
		);
		const activeLiveRun = prepared?.runtime.liveRun;
		if (activeLiveRun && !activeLiveRun.disposed) {
			await cursorLiveRuns.release(activeLiveRun);
		} else {
			await abandonSessionCursorAgent(prepared?.sessionAgentScopeKey);
		}
		if (error instanceof CursorLiveRunAbortError) {
			this.params.sdkProcessErrorGuard.suppressAbortErrors();
			this.pushTerminalError(this.params.runnerParams.partial, "aborted", this.abortMessage());
		} else {
			this.pushTerminalError(
				this.params.runnerParams.partial,
				"error",
				sanitizeCursorProviderError(error, this.params.resolvedApiKey() ?? this.params.runnerParams.options?.apiKey),
			);
		}
	}

	private pushTerminalError(partial: AssistantMessage, reason: "error" | "aborted", message: string): void {
		partial.stopReason = reason;
		partial.errorMessage = message;
		this.params.runnerParams.stream.push({ type: "error", reason, error: partial });
	}

	private abortMessage(): string {
		return formatCursorSdkAbortMessage(
			resolveCursorSdkAbortCause({ signalAborted: this.params.runnerParams.options?.signal?.aborted }),
		);
	}

	private safeCleanup(cleanup: () => void): void {
		try {
			cleanup();
		} catch {
			// Cleanup must not reclassify an already-emitted provider turn.
		}
	}

	private async finalizeSdkEventDebugBestEffort(): Promise<void> {
		try {
			this.params.sdkEventDebug()?.recordFinalPartial(this.params.runnerParams.partial);
			await this.params.sdkEventDebug()?.finalize();
		} catch {
			// Debug artifact IO is best-effort and must not emit a second terminal event.
		}
	}
}
