import { CursorLiveRunAbortError } from "./cursor-live-run-coordinator.js";
import { drainExistingCursorLiveRunBeforeSend } from "./cursor-provider-live-run-drain.js";
import { getCursorSessionCwd } from "./cursor-session-scope.js";
import { resetSessionCursorAgent } from "./cursor-session-agent.js";
import { installCursorSdkProcessErrorGuard } from "./cursor-sdk-process-error-guard.js";
import { CursorSdkEventDebugSink } from "./cursor-sdk-event-debug.js";
import { awaitFinalizeCursorRunOutcome } from "./cursor-provider-turn-finalize.js";
import {
	discardIncompleteToolsFromPrepared,
	emitCursorLiveTurn,
} from "./cursor-provider-turn-emit.js";
import { CursorRunFinalizer, type CursorLiveRunCompletion } from "./cursor-provider-run-finalizer.js";
import {
	prepareCursorProviderTurn,
	requireCursorApiKey,
	resolveCursorProviderTurnConfig,
} from "./cursor-provider-turn-prepare.js";
import { sendCursorProviderTurn } from "./cursor-provider-turn-send.js";
import {
	CursorStaleSessionAuthRetryError,
	isRetryableStaleCursorSessionAuthError,
	shouldRetryPreparedStaleSessionAuth,
} from "./cursor-provider-stale-auth-retry.js";
import { classifyCursorRunEmission } from "./cursor-provider-run-outcome.js";
import type {
	CursorProviderTurnPrepareResult,
	CursorProviderTurnRunnerParams,
	CursorProviderTurnSendResult,
	LiveCursorProviderTurnRuntime,
	LocalCursorProviderTurnPrepareResult,
} from "./cursor-provider-turn-types.js";

export type { CursorProviderTurnRunnerParams } from "./cursor-provider-turn-types.js";

type LocalLivePreparedTurn = LocalCursorProviderTurnPrepareResult & { runtime: LiveCursorProviderTurnRuntime };

function requireLocalLivePreparedTurn(prepared: CursorProviderTurnPrepareResult): LocalLivePreparedTurn {
	if (prepared.runtimeTarget !== "local" || prepared.runtime.kind !== "live") {
		throw new Error("Cursor live run requires a local live prepared turn");
	}
	return prepared as LocalLivePreparedTurn;
}

function unwrapStaleAuthRetryError(error: unknown): unknown {
	return error instanceof CursorStaleSessionAuthRetryError ? error.causeError : error;
}

export class CursorProviderTurnRunner {
	private sdkEventDebug: CursorSdkEventDebugSink | undefined;
	private resolvedApiKey: string | undefined;

	constructor(private readonly params: CursorProviderTurnRunnerParams) {}

	private get options() {
		return this.params.options;
	}

	private throwIfAborted(): void {
		if (this.options?.signal?.aborted) throw new CursorLiveRunAbortError();
	}

	async run(sdkProcessErrorGuard: ReturnType<typeof installCursorSdkProcessErrorGuard>): Promise<void> {
		const { stream, partial, model, context, options, sdkEventDebugRef } = this.params;
		let prepared: CursorProviderTurnPrepareResult | undefined;
		let sendResult: CursorProviderTurnSendResult | undefined;
		let liveCompletion: CursorLiveRunCompletion | undefined;
		let alreadyRetriedStaleAuth = false;
		const runFinalizer = new CursorRunFinalizer({
			runnerParams: this.params,
			sdkEventDebug: () => this.sdkEventDebug,
			sdkProcessErrorGuard,
			resolvedApiKey: () => this.resolvedApiKey,
		});

		const cleanupAttemptSideEffects = async (): Promise<void> => {
			const abortRegistration = sendResult?.abortRegistration;
			if (abortRegistration) {
				abortRegistration.signal.removeEventListener("abort", abortRegistration.listener);
			}
			sendResult = undefined;
			liveCompletion = undefined;
			try {
				prepared?.restoreCursorSdkOutputFilter();
			} catch {
				// Cleanup must not block stale-auth retry.
			}
			const scopeKey = prepared?.sessionAgentScopeKey;
			prepared = undefined;
			if (scopeKey) {
				await resetSessionCursorAgent(scopeKey).catch(() => {});
			}
		};

		try {
			this.throwIfAborted();
			const cwd = getCursorSessionCwd();
			this.sdkEventDebug = CursorSdkEventDebugSink.maybeCreate({
				cwd,
				modelId: model.id,
				provider: model.provider,
			});
			sdkEventDebugRef.current = this.sdkEventDebug;
			this.sdkEventDebug?.recordContextSnapshot(context);
			// Resolved once here, before any drain await, so the drain decision and the
			// prepare dispatch below always act on the same config snapshot.
			const resolvedConfig = resolveCursorProviderTurnConfig(cwd);
			if (resolvedConfig.runtime.value === "local") {
				if (
					(await drainExistingCursorLiveRunBeforeSend(stream, partial, model, context, options?.signal, this.sdkEventDebug)) ===
					"stream_ended"
				) {
					return;
				}
			}
			this.throwIfAborted();
			this.resolvedApiKey = requireCursorApiKey(options);

			for (let attempt = 0; attempt < 2; attempt++) {
				alreadyRetriedStaleAuth = attempt > 0;
				try {
					prepared = await prepareCursorProviderTurn({
						params: this.params,
						cwd,
						resolvedApiKey: this.resolvedApiKey,
						sdkEventDebug: this.sdkEventDebug,
						throwIfAborted: () => this.throwIfAborted(),
						resolvedConfig,
					});

					sendResult = await sendCursorProviderTurn({
						params: this.params,
						prepared,
						sdkEventDebug: this.sdkEventDebug,
						sdkProcessErrorGuard,
						throwIfAborted: () => this.throwIfAborted(),
						resolvedApiKey: this.resolvedApiKey,
					});
					const { send } = sendResult;

					if (prepared.runtime.kind === "live") {
						const livePrepared = requireLocalLivePreparedTurn(prepared);
						liveCompletion = runFinalizer.startLiveRunCompletion({
							send,
							prepared: livePrepared,
							modelId: model.id,
							discardIncompleteTools: (outcome) => discardIncompleteToolsFromPrepared(livePrepared, outcome),
							allowStaleAuthRetry: !alreadyRetriedStaleAuth,
						});
						await emitCursorLiveTurn({
							params: this.params,
							prepared: livePrepared,
							sdkEventDebug: this.sdkEventDebug,
							discardIncompleteTools: (outcome) => discardIncompleteToolsFromPrepared(livePrepared, outcome),
						});
						return;
					}

					const outcomePromise = awaitFinalizeCursorRunOutcome({
						run: send.run,
						prepared,
						cursorAgentMessageOffset: send.cursorAgentMessageOffset,
						modelId: model.id,
						signal: options?.signal,
						runResultFallback: send.run.result,
						runErrorFallback: send.run.error,
						resolvedApiKey: this.resolvedApiKey,
						optionsApiKey: options?.apiKey,
						sdkEventDebug: this.sdkEventDebug,
						contextWindowAgentId: prepared.contextWindowAgentId,
					});
					prepared.lifecycle.trackRunCompletion(outcomePromise);
					const finalized = await outcomePromise;
					if (
						classifyCursorRunEmission(finalized.outcome) === "failed" &&
						shouldRetryPreparedStaleSessionAuth({
							error: finalized.outcome.kind === "error" ? finalized.outcome.errorMessage : finalized.outcome,
							prepared,
							alreadyRetried: alreadyRetriedStaleAuth,
							signalAborted: options?.signal?.aborted,
						})
					) {
						await cleanupAttemptSideEffects();
						continue;
					}
					await runFinalizer.applyTerminalEvent({
						kind: "direct",
						prepared,
						outcome: finalized.outcome,
						displayOnlyTraceBlock: finalized.displayOnlyTraceBlock,
					});
					return;
				} catch (error) {
					const cause = unwrapStaleAuthRetryError(error);
					if (
						shouldRetryPreparedStaleSessionAuth({
							error: cause,
							prepared,
							alreadyRetried: alreadyRetriedStaleAuth,
							signalAborted: options?.signal?.aborted,
						}) ||
						(error instanceof CursorStaleSessionAuthRetryError && !alreadyRetriedStaleAuth)
					) {
						await cleanupAttemptSideEffects();
						continue;
					}
					await runFinalizer.applyTerminalEvent({
						kind: "error",
						prepared,
						error: cause,
						staleSessionAuthExhausted:
							alreadyRetriedStaleAuth && isRetryableStaleCursorSessionAuthError(cause),
					});
					return;
				}
			}
		} catch (error) {
			await runFinalizer.applyTerminalEvent({ kind: "error", prepared, error });
		} finally {
			await runFinalizer.cleanup(prepared, sendResult, liveCompletion);
		}
	}

	async handleOuterCatch(error: unknown): Promise<void> {
		const runFinalizer = new CursorRunFinalizer({
			runnerParams: this.params,
			sdkEventDebug: () => this.sdkEventDebug,
			sdkProcessErrorGuard: installCursorSdkProcessErrorGuard(),
			resolvedApiKey: () => this.resolvedApiKey,
		});
		await runFinalizer.applyTerminalEvent({ kind: "error", prepared: undefined, error });
		await runFinalizer.cleanup(undefined, undefined, undefined);
	}
}
