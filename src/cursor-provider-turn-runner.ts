import { CursorLiveRunAbortError } from "./cursor-live-run-coordinator.js";
import { drainExistingCursorLiveRunBeforeSend } from "./cursor-provider-live-run-drain.js";
import { invalidateSessionAgent } from "./cursor-session-agent.js";
import { installCursorSdkProcessErrorGuard } from "./cursor-sdk-process-error-guard.js";
import type { CursorRuntime } from "./cursor-config.js";
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

export class CursorProviderTurnRunner {
	private sdkEventDebug: CursorSdkEventDebugSink | undefined;
	private resolvedApiKey: string | undefined;
	private runtimeTarget: CursorRuntime | undefined;

	constructor(private readonly params: CursorProviderTurnRunnerParams) {}

	private get options() {
		return this.params.options;
	}

	private throwIfAborted(): void {
		if (this.options?.signal?.aborted) throw new CursorLiveRunAbortError();
	}

	async run(sdkProcessErrorGuard: ReturnType<typeof installCursorSdkProcessErrorGuard>): Promise<void> {
		const { stream, partial, model, context, options, scope, sdkEventDebugRef } = this.params;
		let prepared: CursorProviderTurnPrepareResult | undefined;
		let sendResult: CursorProviderTurnSendResult | undefined;
		let liveCompletion: CursorLiveRunCompletion | undefined;
		const runFinalizer = new CursorRunFinalizer({
			runnerParams: this.params,
			sdkEventDebug: () => this.sdkEventDebug,
			sdkProcessErrorGuard,
			resolvedApiKey: () => this.resolvedApiKey,
			runtimeTarget: () => this.runtimeTarget,
		});

		try {
			this.throwIfAborted();
			const cwd = scope.cwd;
			this.sdkEventDebug = CursorSdkEventDebugSink.maybeCreate({
				cwd,
				modelId: model.id,
				provider: model.provider,
				scope,
			});
			sdkEventDebugRef.current = this.sdkEventDebug;
			this.sdkEventDebug?.recordContextSnapshot(context);
			// Resolved once here, before any drain await, so the drain decision and the
			// prepare dispatch below always act on the same config snapshot.
			const resolvedConfig = resolveCursorProviderTurnConfig(scope);
			this.runtimeTarget = resolvedConfig.runtime.value;
			if (resolvedConfig.runtime.value === "local") {
				// The observed local-executor closed-pipe EPIPE is contained only from this
				// turn's pre-send live-run drain through run completion; for live runs the
				// finalizer holds the guard until run.wait() settles. A hit marks
				// this scope's pooled agent transport dead so the next acquire recreates it.
				const localScopeKey = scope.scopeKey;
				sdkProcessErrorGuard.containLocalTransportClosedPipe(() =>
					invalidateSessionAgent(localScopeKey, { deadTransport: true }),
				);
				if (
					(await drainExistingCursorLiveRunBeforeSend(
						stream,
						partial,
						model,
						context,
						options?.signal,
						this.sdkEventDebug,
						localScopeKey,
					)) ===
					"stream_ended"
				) {
					return;
				}
			}
			this.throwIfAborted();

			this.resolvedApiKey = requireCursorApiKey(options);
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
			await runFinalizer.applyTerminalEvent({
				kind: "direct",
				prepared,
				outcome: finalized.outcome,
				displayOnlyTraceBlock: finalized.displayOnlyTraceBlock,
			});
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
			runtimeTarget: () => this.runtimeTarget,
		});
		await runFinalizer.applyTerminalEvent({ kind: "error", prepared: undefined, error });
		await runFinalizer.cleanup(undefined, undefined, undefined);
	}
}
