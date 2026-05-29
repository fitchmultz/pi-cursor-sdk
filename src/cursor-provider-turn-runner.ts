import { CursorLiveRunAbortError } from "./cursor-live-run-coordinator.js";
import { drainExistingCursorLiveRunBeforeSend } from "./cursor-provider-live-run-drain.js";
import { getCursorSessionCwd } from "./cursor-session-cwd.js";
import { installCursorSdkProcessErrorGuard } from "./cursor-sdk-process-error-guard.js";
import { CursorSdkEventDebugSink } from "./cursor-sdk-event-debug.js";
import { awaitFinalizeCursorRunOutcome } from "./cursor-provider-turn-finalize.js";
import {
	discardIncompleteToolsFromPrepared,
	emitCursorLiveTurn,
} from "./cursor-provider-turn-emit.js";
import { CursorRunFinalizer, type CursorLiveRunCompletion } from "./cursor-provider-run-finalizer.js";
import { prepareCursorProviderTurn, requireCursorApiKey } from "./cursor-provider-turn-prepare.js";
import { sendCursorProviderTurn } from "./cursor-provider-turn-send.js";
import type {
	CursorProviderTurnPrepareResult,
	CursorProviderTurnRunnerParams,
	CursorProviderTurnSendResult,
} from "./cursor-provider-turn-types.js";

export { resolveCursorApiKey } from "./cursor-provider-turn-api-key.js";
export type { CursorProviderTurnRunnerParams } from "./cursor-provider-turn-types.js";

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

	private discardIncompleteTools(
		prepared: CursorProviderTurnPrepareResult | undefined,
		outcome: import("./cursor-incomplete-tool-visibility.js").IncompleteCursorToolRunOutcomeInput,
	): void {
		discardIncompleteToolsFromPrepared(prepared, outcome);
	}

	async run(sdkProcessErrorGuard: ReturnType<typeof installCursorSdkProcessErrorGuard>): Promise<void> {
		const { stream, partial, model, context, options, sdkEventDebugRef } = this.params;
		let prepared: CursorProviderTurnPrepareResult | undefined;
		let sendResult: CursorProviderTurnSendResult | undefined;
		let liveCompletion: CursorLiveRunCompletion | undefined;
		const runFinalizer = new CursorRunFinalizer({
			runnerParams: this.params,
			sdkEventDebug: () => this.sdkEventDebug,
			sdkProcessErrorGuard,
			resolvedApiKey: () => this.resolvedApiKey,
		});

		try {
			stream.push({ type: "start", partial });
			this.throwIfAborted();
			const cwd = getCursorSessionCwd();
			this.sdkEventDebug = CursorSdkEventDebugSink.maybeCreate({
				cwd,
				modelId: model.id,
				provider: model.provider,
			});
			sdkEventDebugRef.current = this.sdkEventDebug;
			this.sdkEventDebug?.recordContextSnapshot(context);
			if (
				(await drainExistingCursorLiveRunBeforeSend(stream, partial, model, context, options?.signal, this.sdkEventDebug)) ===
				"stream_ended"
			) {
				return;
			}

			this.resolvedApiKey = requireCursorApiKey(options);
			prepared = await prepareCursorProviderTurn({
				params: this.params,
				cwd,
				resolvedApiKey: this.resolvedApiKey,
				sdkEventDebug: this.sdkEventDebug,
				throwIfAborted: () => this.throwIfAborted(),
			});

			sendResult = await sendCursorProviderTurn({
				params: this.params,
				prepared,
				sdkEventDebug: this.sdkEventDebug,
				sdkProcessErrorGuard,
				throwIfAborted: () => this.throwIfAborted(),
			});
			const { send } = sendResult;

			if (prepared.runtime.kind === "live") {
				liveCompletion = runFinalizer.startLiveRunCompletion({
					send,
					prepared,
					modelId: model.id,
					discardIncompleteTools: (outcome) => this.discardIncompleteTools(prepared, outcome),
				});
				await emitCursorLiveTurn({
					params: this.params,
					prepared,
					sdkEventDebug: this.sdkEventDebug,
					discardIncompleteTools: (outcome) => this.discardIncompleteTools(prepared, outcome),
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
				resolvedApiKey: this.resolvedApiKey,
				optionsApiKey: options?.apiKey,
				sdkEventDebug: this.sdkEventDebug,
				contextWindowAgentId: prepared.contextWindowAgentId,
			});
			prepared.sessionAgentLease.trackRunCompletion(outcomePromise);
			const outcome = await outcomePromise;
			await runFinalizer.applyTerminalEvent({ kind: "direct", prepared, outcome });
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
