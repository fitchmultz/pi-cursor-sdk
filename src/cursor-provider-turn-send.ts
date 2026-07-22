import type { SendOptions } from "@cursor/sdk";
import { countCursorAgentMessages } from "./cursor-agent-message-web-tools.js";
import {
	createCursorCloudLifecyclePersistenceError,
	recordCursorCloudLifecycleSafely,
} from "./cursor-cloud-lifecycle.js";
import { CursorLiveRunAbortError } from "./cursor-live-run-coordinator.js";
import { cursorLiveRuns } from "./cursor-provider-live-run-drain.js";
import { consumeCursorLocalForceOverride } from "./cursor-runtime-state.js";
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
	resolvedApiKey?: string;
}

const CLOUD_LEDGER_CANCEL_TIMEOUT_MS = 5000;

async function requestBoundedCloudRunCancellation(run: Awaited<ReturnType<CursorProviderTurnPrepareResult["agent"]["send"]>>): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<false>((resolve) => {
		timer = setTimeout(() => resolve(false), CLOUD_LEDGER_CANCEL_TIMEOUT_MS);
		timer.unref?.();
	});
	try {
		return await Promise.race([
			Promise.resolve().then(() => run.cancel()).then(() => true, () => false),
			timeout,
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function recordDebug(action: () => void): void {
	try {
		action();
	} catch {
		// Debug capture is optional and must never change provider execution.
	}
}

export async function sendCursorProviderTurn(sendParams: SendCursorProviderTurnParams): Promise<CursorProviderTurnSendResult> {
	const { params, prepared, sdkEventDebug, sdkProcessErrorGuard, throwIfAborted, resolvedApiKey } = sendParams;
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
		let cursorAgentMessageOffset: number | undefined;
		if (prepared.runtimeTarget === "local") {
			try {
				cursorAgentMessageOffset = await countCursorAgentMessages(agent.agentId, cwd, prepared.sessionAgentLease.store);
			} catch (error) {
				recordDebug(() => sdkEventDebug?.recordError("cursor_agent_message_count", error));
			}
		}
		throwIfAborted();
		recordDebug(() => sdkEventDebug?.recordSendMeta({
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
		}));
		recordDebug(() => sdkEventDebug?.recordSendPayload(payload));
		recordDebug(() => sdkEventDebug?.recordProviderEvent("agent_send_start", payload));
		const sendOptions: SendOptions = {
			mode: meta.agentMode,
			model: meta.modelSelection,
			onDelta: (args) => {
				recordDebug(() => sdkEventDebug?.recordOnDelta(args.update));
				turnCoordinator.handleDelta(args.update);
			},
			onStep: (args) => {
				recordDebug(() => sdkEventDebug?.recordOnStep(args.step));
				turnCoordinator.handleStep(args.step);
			},
		};
		throwIfAborted();
		if (prepared.runtimeTarget === "local" && consumeCursorLocalForceOverride(prepared.localForce)) {
			sendOptions.local = { force: true };
		}
		const run = await agent.send(payload, sendOptions);
		sdkRun = run;
		if (prepared.runtimeTarget === "cloud" && !recordCursorCloudLifecycleSafely({ agentId: run.agentId, runId: run.id }, resolvedApiKey)) {
			const cancellationConfirmed = await requestBoundedCloudRunCancellation(run);
			throw createCursorCloudLifecyclePersistenceError(run.agentId, "run", cancellationConfirmed, resolvedApiKey);
		}
		recordDebug(() => sdkEventDebug?.recordRunMeta({
			runId: run.id,
			requestId: run.requestId,
			agentId: run.agentId,
			status: run.status,
		}));
		recordDebug(() => sdkEventDebug?.attachRunStream(run));
		recordDebug(() => sdkEventDebug?.recordProviderEvent("agent_send_returned", {
			runId: run.id,
			requestId: run.requestId,
			agentId: run.agentId,
			status: run.status,
		}));
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
