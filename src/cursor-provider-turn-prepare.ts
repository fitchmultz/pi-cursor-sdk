import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import { installCursorMcpToolTimeoutOverride } from "./cursor-mcp-timeout-override.js";
import { installCursorSdkOutputFilter, suppressCursorSdkOutput } from "./cursor-sdk-output-filter.js";
import {
	acquireSessionCursorAgent,
	buildCursorSessionSendPrompt,
	planCursorSessionSend,
	resetSessionCursorAgent,
} from "./cursor-session-agent.js";
import type { CursorPiBridgeToolRequest } from "./cursor-pi-tool-bridge.js";
import { estimateCursorPromptInputTokens, getCursorPromptOptions } from "./cursor-usage-accounting.js";
import { getActiveContextToolNames } from "./cursor-context-tools.js";
import type { CursorLiveRun } from "./cursor-live-run-coordinator.js";
import { abandonSessionCursorAgent, cursorLiveRuns } from "./cursor-provider-live-run-drain.js";
import { createCursorNativeReplayId } from "./cursor-provider-live-run-drain.js";
import { getEffectiveCursorAgentMode, getEffectiveFastForModelId } from "./cursor-state.js";
import { buildCursorModelSelection } from "./model-discovery.js";
import { getEffectiveCursorSettingSources } from "./cursor-setting-sources.js";
import { resolveCursorPiToolBridgeEnabled } from "./cursor-pi-tool-bridge-snapshot.js";
import {
	buildCursorToolManifestText,
	resolveCursorToolManifestEnabled,
} from "./cursor-tool-manifest.js";
import { isCursorNativeToolDisplayRuntimeEnabled } from "./cursor-native-tool-display.js";
import { MISSING_CURSOR_API_KEY_MESSAGE } from "./cursor-provider-errors.js";
import { CursorSdkTurnCoordinator } from "./cursor-provider-turn-coordinator.js";
import { resolveCursorApiKey } from "./cursor-provider-turn-api-key.js";
import { loadCursorSdk } from "./cursor-sdk-runtime.js";
import type {
	CursorProviderTurnPrepareResult,
	CursorProviderTurnRunnerParams,
} from "./cursor-provider-turn-types.js";
import type { CursorSdkEventDebugSink } from "./cursor-sdk-event-debug.js";

export interface PrepareCursorProviderTurnParams {
	params: CursorProviderTurnRunnerParams;
	cwd: string;
	resolvedApiKey: string;
	sdkEventDebug: CursorSdkEventDebugSink | undefined;
	throwIfAborted: () => void;
}

export async function prepareCursorProviderTurn(
	prepareParams: PrepareCursorProviderTurnParams,
): Promise<CursorProviderTurnPrepareResult> {
	const { params, cwd, resolvedApiKey, sdkEventDebug, throwIfAborted } = prepareParams;
	const { model, context, options } = params;

	let restoreCursorSdkOutputFilter: (() => void) | undefined;
	let sessionAgentScopeKey: string | undefined;
	let liveRun: CursorLiveRun | undefined;
	let completed = false;

	try {
		const fastEnabled = getEffectiveFastForModelId(model.id);
		const agentMode = getEffectiveCursorAgentMode();
		const selection = buildCursorModelSelection(model.id, options?.reasoning ?? "off", fastEnabled);
		const settingSources = getEffectiveCursorSettingSources();
		const { Agent } = await loadCursorSdk();

		installCursorMcpToolTimeoutOverride();
		restoreCursorSdkOutputFilter = installCursorSdkOutputFilter();
		const queuedBridgeRequestsBeforeLiveRun: CursorPiBridgeToolRequest[] = [];
		let liveRunForBridgeQueue: CursorLiveRun | undefined;

		const sessionAgentAcquireParams = {
			apiKey: resolvedApiKey,
			agentMode,
			cwd,
			modelSelection: selection,
			settingSources,
			debugRecorder: sdkEventDebug,
			onBridgeToolRequest: (request: CursorPiBridgeToolRequest) => {
				if (liveRunForBridgeQueue && !liveRunForBridgeQueue.disposed) {
					cursorLiveRuns.queueEvent(liveRunForBridgeQueue, { type: "bridge-tool", request });
				} else {
					queuedBridgeRequestsBeforeLiveRun.push(request);
				}
			},
			createAgent: (createOptions: Parameters<typeof Agent.create>[0]) =>
				suppressCursorSdkOutput(() => Agent.create(createOptions)),
		};
		let sessionAgentLease = await acquireSessionCursorAgent(sessionAgentAcquireParams);
		sessionAgentScopeKey = sessionAgentLease.scopeKey;
		throwIfAborted();

		const buildPromptOptions = (plan: ReturnType<typeof planCursorSessionSend>) => {
			const promptOptions = getCursorPromptOptions(model);
			if (plan.mode !== "bootstrap" || !resolveCursorToolManifestEnabled()) {
				return promptOptions;
			}
			return {
				...promptOptions,
				toolManifest: buildCursorToolManifestText({
					bridgeSnapshot: sessionAgentLease.bridgeRun?.snapshot,
					piBridgeEnabled: resolveCursorPiToolBridgeEnabled(),
				}),
			};
		};
		let sendPlan = planCursorSessionSend(sessionAgentLease.sendState, context);
		let promptOptions = buildPromptOptions(sendPlan);
		let prompt = buildCursorSessionSendPrompt(context, promptOptions, sendPlan);
		if (sendPlan.resetAgent) {
			await resetSessionCursorAgent(sessionAgentScopeKey);
			sessionAgentLease = await acquireSessionCursorAgent(sessionAgentAcquireParams);
			sessionAgentScopeKey = sessionAgentLease.scopeKey;
			sendPlan = planCursorSessionSend(sessionAgentLease.sendState, context);
			promptOptions = buildPromptOptions(sendPlan);
			prompt = buildCursorSessionSendPrompt(context, promptOptions, sendPlan);
		}
		const bootstrap = sendPlan.mode === "bootstrap";
		const agent = sessionAgentLease.agent;
		const bridgeRun = sessionAgentLease.bridgeRun;
		const sendPayload = {
			text: prompt.text,
			images: prompt.images.length > 0 ? prompt.images : undefined,
		};
		const sessionBridgeRun = bridgeRun;
		const promptInputTokens = estimateCursorPromptInputTokens(prompt, promptOptions);
		const useNativeToolReplay = isCursorNativeToolDisplayRuntimeEnabled();
		const activeToolNames = getActiveContextToolNames(context);
		sdkEventDebug?.recordProviderMeta({
			model: {
				id: model.id,
				provider: model.provider,
				api: model.api,
				reasoning: options?.reasoning ?? "off",
				fastEnabled,
				selection,
			},
			settingSources: settingSources ?? null,
			sendState: sessionAgentLease.sendState,
			sendPlan,
			promptOptions,
			toolManifestEnabled: resolveCursorToolManifestEnabled(),
			agentMode,
			activeToolNames: activeToolNames ? [...activeToolNames] : [],
			sessionAgentScopeKey,
			bridgeRunId: bridgeRun?.id,
		});
		const nativeReplayId = createCursorNativeReplayId();
		const textDeltas: string[] = [];
		const useLiveRun = useNativeToolReplay || bridgeRun !== undefined;
		liveRun = useLiveRun
			? cursorLiveRuns.start({
					id: useNativeToolReplay ? nativeReplayId : bridgeRun?.id ?? nativeReplayId,
					agent,
					bridgeRun,
					sessionBridgeRun,
					sessionAgentScopeKey,
					promptInputTokens,
					textDeltas,
					debugRecorder: sdkEventDebug,
				})
			: undefined;
		if (liveRun) {
			liveRunForBridgeQueue = liveRun;
			for (const request of queuedBridgeRequestsBeforeLiveRun.splice(0)) {
				cursorLiveRuns.queueEvent(liveRun, { type: "bridge-tool", request });
			}
		}
		const turnCoordinator = new CursorSdkTurnCoordinator({
			stream: params.stream,
			partial: params.partial,
			cwd,
			resolvedApiKey,
			liveRun,
			useNativeToolReplay,
			activeToolNames,
			nativeReplayId,
			textDeltas,
			debugRecorder: sdkEventDebug,
		});

		completed = true;
		return {
			agent,
			cwd,
			payload: sendPayload,
			meta: {
				sendPlan,
				prompt,
				bootstrap,
				promptInputTokens,
				useNativeToolReplay,
				bridgeEnabled: bridgeRun !== undefined,
				nativeReplayId,
				agentMode,
			},
			contextWindowAgentId: agent.agentId,
			textDeltas,
			sessionAgentScopeKey,
			sessionAgentLease,
			restoreCursorSdkOutputFilter,
			runtime: liveRun
				? { kind: "live", liveRun, turnCoordinator }
				: { kind: "direct", turnCoordinator },
		};
	} finally {
		if (!completed) {
			if (liveRun && !liveRun.disposed) {
				await cursorLiveRuns
					.release(liveRun)
					.catch(() => abandonSessionCursorAgent(sessionAgentScopeKey).catch(() => {}));
			} else {
				await abandonSessionCursorAgent(sessionAgentScopeKey).catch(() => {});
			}
			restoreCursorSdkOutputFilter?.();
		}
	}
}

export function requireCursorApiKey(options: SimpleStreamOptions | undefined): string {
	const apiKey = resolveCursorApiKey(options?.apiKey);
	if (!apiKey) throw new Error(MISSING_CURSOR_API_KEY_MESSAGE);
	return apiKey;
}
