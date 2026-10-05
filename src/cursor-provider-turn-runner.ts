import { CursorLiveRunAbortError } from "./cursor-live-run-coordinator.js";
import { drainExistingCursorLiveRunBeforeSend } from "./cursor-provider-live-run-drain.js";
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
	StartedCursorProviderTurn,
} from "./cursor-provider-turn-types.js";

export type { CursorProviderTurnRunnerParams } from "./cursor-provider-turn-types.js";

type LocalLivePreparedTurn = StartedCursorProviderTurn & LocalCursorProviderTurnPrepareResult & { runtime: LiveCursorProviderTurnRuntime };

function requireLocalLivePreparedTurn(prepared: StartedCursorProviderTurn): LocalLivePreparedTurn {
	if (prepared.runtimeTarget !== "local" || prepared.execution !== "conversation" || prepared.runtime.kind !== "live") {
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
		const { stream, partial, model, context, options, sdkEventDebugRef } = this.params;
		let prepared: CursorProviderTurnPrepareResult | undefined;
		let started: StartedCursorProviderTurn | undefined;
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
			const { scope } = this.params;
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
			const resolvedConfig = resolveCursorProviderTurnConfig(cwd, scope.projectTrusted, scope.scopeKey);
			this.runtimeTarget = resolvedConfig.runtime.value;
			if (resolvedConfig.runtime.value === "local" && this.params.request.purpose === "normal") {
				if (
					(await drainExistingCursorLiveRunBeforeSend(stream, partial, model, context, options?.signal, this.sdkEventDebug, scope.scopeKey, this.params.request.occupancyFloor)) ===
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

			const usage = await this.params.usageRecorder.start({
				agent: prepared.agent,
				runtime: prepared.runtimeTarget,
				model: { id: model.id, provider: model.provider, cost: { ...model.cost } },
				modelSelection: prepared.meta.modelSelection,
				purpose: this.params.request.purpose,
				...(prepared.runtimeTarget === "local" ? { storeIdentity: prepared.storeIdentity.stateRoot } : {}),
				resumed: prepared.runtimeTarget === "local" && prepared.execution === "conversation" && prepared.sessionAgentLease.resumed === true,
				newlyCreated: prepared.runtimeTarget !== "local" || prepared.execution === "summary" || (prepared.sessionAgentLease.created && !prepared.sessionAgentLease.resumed),
			}).catch(error => {
				this.params.usageRecorder.notePersistenceFailure(error);
				throw error;
			});
			started = { ...prepared, usage };
			if (started.runtime.liveRun) {
				started.runtime.liveRun.onAbandon = async () => {
					try {
						await usage.recordTerminal({ status: "abandon" });
					} catch (error) {
						usage.notePersistenceFailure(error);
					}
				};
			}

			sendResult = await sendCursorProviderTurn({
				params: this.params,
				prepared: started,
				sdkEventDebug: this.sdkEventDebug,
				sdkProcessErrorGuard,
				throwIfAborted: () => this.throwIfAborted(),
				resolvedApiKey: this.resolvedApiKey,
			});
			const { send } = sendResult;

			if (prepared.runtime.kind === "live") {
				const livePrepared = requireLocalLivePreparedTurn(started);
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
				prepared: started,
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
				prepared: started,
				outcome: finalized.outcome,
				displayOnlyTraceBlock: finalized.displayOnlyTraceBlock,
			});
		} catch (error) {
			await runFinalizer.applyTerminalEvent({ kind: "error", prepared: started ?? prepared, error });
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
