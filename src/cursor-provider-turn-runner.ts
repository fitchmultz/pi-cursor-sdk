import { assertCursorNativeToolsRuntime, resolveCursorNativeToolsEnabled } from "./cursor-native-tools.js";
import { CursorLiveRunAbortError } from "./cursor-live-run-coordinator.js";
import { cursorLiveRuns, drainExistingCursorLiveRunBeforeSend } from "./cursor-provider-live-run-drain.js";
import { installCursorSdkProcessErrorGuard } from "./cursor-sdk-process-error-guard.js";
import type { CursorRuntime } from "./cursor-config.js";
import { CursorSdkEventDebugSink } from "./cursor-sdk-event-debug.js";
import { awaitFinalizeCursorRunOutcome } from "./cursor-provider-turn-finalize.js";
import {
	discardIncompleteToolsFromPrepared,
	emitCursorLiveTurn,
} from "./cursor-provider-turn-emit.js";
import { CursorRunFinalizer } from "./cursor-provider-run-finalizer.js";
import {
	prepareCursorProviderTurn,
	requireCursorApiKey,
	resolveCursorProviderTurnConfig,
} from "./cursor-provider-turn-prepare.js";
import { sendCursorProviderTurn } from "./cursor-provider-turn-send.js";
import type {
	CursorProviderTurnPhase,
	CursorProviderTurnRunnerParams,
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
		let phase: CursorProviderTurnPhase = { kind: "unprepared" };
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

			// Resolved once here, before any drain await, so the drain decision and the
			// prepare dispatch below always act on the same config snapshot.
			const resolvedConfig = resolveCursorProviderTurnConfig(cwd, scope.projectTrusted, scope.scopeKey);
			this.runtimeTarget = resolvedConfig.runtime.value;
			const nativeToolsEnabled = resolveCursorNativeToolsEnabled();
			assertCursorNativeToolsRuntime(this.runtimeTarget, nativeToolsEnabled);
			this.sdkEventDebug = CursorSdkEventDebugSink.maybeCreate({
				cwd,
				modelId: model.id,
				provider: model.provider,
				scope,
			});
			sdkEventDebugRef.current = this.sdkEventDebug;
			this.sdkEventDebug?.recordContextSnapshot(context);
			if (resolvedConfig.runtime.value === "local" && this.params.request.purpose === "normal") {
				const drained = await drainExistingCursorLiveRunBeforeSend(stream, partial, model, context, options?.signal, this.sdkEventDebug, scope.scopeKey, this.params.request.occupancyFloor, nativeToolsEnabled);
				// A toolUse or terminal drain already ended this provider turn.
				if (drained !== "continueSend") return;
			}
			this.throwIfAborted();

			this.resolvedApiKey = requireCursorApiKey(options);
			const prepared = await prepareCursorProviderTurn({
				params: this.params,
				cwd,
				resolvedApiKey: this.resolvedApiKey,
				sdkEventDebug: this.sdkEventDebug,
				throwIfAborted: () => this.throwIfAborted(),
				resolvedConfig,
				nativeToolsEnabled,
			});
			phase = { kind: "prepared", prepared };

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
			const started: StartedCursorProviderTurn = { ...prepared, usage };
			phase = { kind: "started", prepared: started };
			if (started.runtime.liveRun) {
				started.runtime.liveRun.onAbandon = async () => {
					try {
						await usage.recordTerminal({ status: "abandon" });
					} catch (error) {
						usage.notePersistenceFailure(error);
					}
				};
			}

			const { send, abortRegistration } = await sendCursorProviderTurn({
				params: this.params,
				prepared: started,
				sdkEventDebug: this.sdkEventDebug,
				sdkProcessErrorGuard,
				throwIfAborted: () => this.throwIfAborted(),
				resolvedApiKey: this.resolvedApiKey,
			});
			phase = { kind: "sent", prepared: started, abortRegistration };

			if (started.runtime.kind === "live") {
				const livePrepared = requireLocalLivePreparedTurn(started);
				const completion = runFinalizer.startLiveRunCompletion({
					send,
					prepared: livePrepared,
					modelId: model.id,
					discardIncompleteTools: (outcome) => discardIncompleteToolsFromPrepared(livePrepared, outcome),
				});
				// Pi can end this turn (`toolUse`) while the SDK run continues, so cleanup moves to its completion.
				phase = { kind: "liveCompletionOwnsCleanup", prepared: livePrepared, abortRegistration, completion };
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
				contextWindowAgentId: started.contextWindowAgentId,
			});
			started.lifecycle.trackRunCompletion(outcomePromise);
			const finalized = await outcomePromise;
			await runFinalizer.applyTerminalEvent({
				kind: "direct",
				prepared: started,
				outcome: finalized.outcome,
				displayOnlyTraceBlock: finalized.displayOnlyTraceBlock,
			});
		} catch (error) {
			// This body owns the session turn lease; a queued request aborted before
			// entry must not release another request's run in handleOuterCatch().
			if (phase.kind === "unprepared" && (error instanceof CursorLiveRunAbortError || options?.signal?.aborted)) {
				const pending = cursorLiveRuns.getActiveForScope(this.params.scope.scopeKey);
				if (pending) await cursorLiveRuns.release(pending);
			}
			await runFinalizer.applyTerminalEvent({ kind: "error", prepared: phase.kind === "unprepared" ? undefined : phase.prepared, error });
		} finally {
			await runFinalizer.cleanup(phase);
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
		await runFinalizer.cleanup({ kind: "unprepared" });
	}
}
