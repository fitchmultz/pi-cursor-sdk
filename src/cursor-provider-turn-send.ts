import type { SendOptions } from "@cursor/sdk";
import { CursorLiveRunAbortError } from "./cursor-live-run-coordinator.js";
import { cursorLiveRuns } from "./cursor-provider-live-run-drain.js";
import { getCursorAgentMessageOffset } from "./cursor-provider-turn-message-offset.js";
import type { installCursorSdkProcessErrorGuard } from "./cursor-sdk-process-error-guard.js";
import type {
	CursorProviderTurnRunnerParams,
	CursorProviderTurnPrepareResult,
	CursorProviderTurnSendResult,
} from "./cursor-provider-turn-types.js";
import type { CursorSdkEventDebugSink } from "./cursor-sdk-event-debug.js";

export interface SendCursorProviderTurnParams {
	params: CursorProviderTurnRunnerParams;
	prepared: CursorProviderTurnPrepareResult;
	sdkEventDebug: CursorSdkEventDebugSink | undefined;
	sdkProcessErrorGuard: ReturnType<typeof installCursorSdkProcessErrorGuard>;
	throwIfAborted: () => void;
}

export async function sendCursorProviderTurn(sendParams: SendCursorProviderTurnParams): Promise<CursorProviderTurnSendResult> {
	const { params, prepared, sdkEventDebug, sdkProcessErrorGuard, throwIfAborted } = sendParams;
	const { options } = params;
	const { agent, cwd, payload, meta, runtime } = prepared;
	const { turnCoordinator, liveRun } = runtime;

	let completed = false;
	let sdkRun: Awaited<ReturnType<typeof agent.send>> | null = null;
	const abortListener = () => {
		sdkProcessErrorGuard.suppressAbortErrors();
		liveRun?.bridgeRun?.cancel("Cursor SDK run aborted");
		if (sdkRun) {
			sdkRun.cancel().catch(() => {});
		}
	};
	const abortSignal = options?.signal;
	const abortRegistration = abortSignal
		? { signal: abortSignal, listener: abortListener }
		: undefined;

	try {
		abortRegistration?.signal.addEventListener("abort", abortListener, { once: true });
		throwIfAborted();
		const cursorAgentMessageOffset = await getCursorAgentMessageOffset(agent.agentId, cwd, sdkEventDebug);
		throwIfAborted();
		sdkEventDebug?.recordSendMeta({
			mode: meta.sendPlan.mode,
			reason: meta.sendPlan.reason,
			resetAgent: meta.sendPlan.resetAgent,
			bootstrap: meta.bootstrap,
			promptText: meta.prompt.text,
			imageCount: meta.prompt.images.length,
			useNativeToolReplay: meta.useNativeToolReplay,
			bridgeEnabled: meta.bridgeEnabled,
			nativeReplayId: meta.nativeReplayId,
			promptInputTokens: meta.promptInputTokens,
			agentMode: meta.agentMode,
		});
		sdkEventDebug?.recordSendPayload(payload);
		sdkEventDebug?.recordProviderEvent("agent_send_start", payload);
		const sendOptions: SendOptions = {
			mode: meta.agentMode,
			onDelta: (args) => {
				sdkEventDebug?.recordOnDelta(args.update);
				turnCoordinator.handleDelta(args.update);
			},
			onStep: (args) => {
				sdkEventDebug?.recordOnStep(args.step);
				turnCoordinator.handleStep(args.step);
			},
		};
		const run = await agent.send(payload, sendOptions);
		sdkRun = run;
		sdkEventDebug?.recordRunMeta({
			runId: run.id,
			agentId: run.agentId,
			status: run.status,
		});
		sdkEventDebug?.attachRunStream(run);
		sdkEventDebug?.recordProviderEvent("agent_send_returned", {
			runId: run.id,
			agentId: run.agentId,
			status: run.status,
		});
		if (liveRun) cursorLiveRuns.attachSdkRun(liveRun, run);
		if (options?.signal?.aborted) {
			sdkProcessErrorGuard.suppressAbortErrors();
			liveRun?.bridgeRun?.cancel("Cursor SDK run aborted");
			await run.cancel().catch(() => {});
			throw new CursorLiveRunAbortError();
		}

		completed = true;
		return {
			send: { run, cursorAgentMessageOffset },
			abortRegistration,
		};
	} finally {
		if (!completed && abortRegistration) {
			abortRegistration.signal.removeEventListener("abort", abortRegistration.listener);
		}
	}
}
