import type { Context, SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import type { AgentModeOption, ModelSelection, SDKAgent } from "@cursor/sdk";
import { configureCursorSdkHttp1 } from "./cursor-http1.js";
import { installCursorMcpToolTimeoutOverride } from "./cursor-mcp-timeout-override.js";
import { ensureCursorRipgrepPath } from "./cursor-ripgrep-path.js";
import { installCursorSdkOutputFilter, suppressCursorSdkOutput } from "./cursor-sdk-output-filter.js";
import {
	acquireSessionCursorAgent,
	buildCursorSessionSendPrompt,
	planCursorSessionSend,
	resetSessionCursorAgent,
	type CursorSessionSendPlan,
} from "./cursor-session-agent.js";
import type { CursorPiBridgeToolRequest } from "./cursor-pi-tool-bridge.js";
import { buildCursorPrompt, estimateCursorPromptTokens } from "./context.js";
import { getCursorPromptOptions } from "./cursor-usage-accounting.js";
import { getActiveContextToolNames } from "./cursor-context-tools.js";
import type { CursorLiveRun } from "./cursor-live-run-coordinator.js";
import {
	abandonSessionCursorAgent,
	createCursorNativeReplayId,
	cursorLiveRuns,
	getActiveCursorLiveRunForCurrentScope,
	getPendingCursorLiveRun,
} from "./cursor-provider-live-run-drain.js";
import {
	getCursorProviderAgentModeOrThrow,
	getEffectiveFastForModelId,
} from "./cursor-state.js";
import { resolveEffectiveCursorConfig } from "./cursor-runtime-state.js";
import type { CursorResolvedSdkConfig } from "./cursor-config.js";
import { buildCursorModelSelection } from "./model-discovery.js";
import { getEffectiveCursorSettingSources } from "./cursor-setting-sources.js";
import {
	formatCursorCloudPreflightError,
	buildCursorCloudAgentOptions,
	preflightCursorCloudRuntime,
} from "./cursor-cloud-options.js";
import { inspectCursorCloudLocalState } from "./cursor-cloud-local-state.js";
import { getCursorSessionName, getCursorSessionProjectTrusted } from "./cursor-session-scope.js";
import { resolveCursorPiToolBridgeEnabled } from "./cursor-pi-tool-bridge-env.js";
import {
	buildCursorToolManifestText,
	resolveCursorToolManifestEnabled,
} from "./cursor-tool-manifest.js";
import { isCursorNativeToolDisplayRuntimeEnabled } from "./cursor-native-tool-display-state.js";
import {
	createCursorCloudLifecyclePersistenceError,
	recordCursorCloudLifecycleSafely,
} from "./cursor-cloud-lifecycle.js";
import { MISSING_CURSOR_API_KEY_MESSAGE } from "./cursor-provider-errors.js";
import { CursorSdkTurnCoordinator } from "./cursor-provider-turn-coordinator.js";
import { resolveCursorApiKey } from "./cursor-api-key.js";
import { loadCursorSdk } from "./cursor-sdk-runtime.js";
import type {
	CloudCursorProviderTurnPrepareResult,
	CursorProviderTurnLifecycle,
	CursorProviderTurnPrepareResult,
	CursorProviderTurnRunnerParams,
	LocalCursorProviderTurnPrepareResult,
} from "./cursor-provider-turn-types.js";
import type { CursorSdkEventDebugSink } from "./cursor-sdk-event-debug.js";
import type { SessionCursorAgentLease } from "./cursor-session-agent.js";

export interface PrepareCursorProviderTurnParams {
	params: CursorProviderTurnRunnerParams;
	cwd: string;
	resolvedApiKey: string;
	sdkEventDebug: CursorSdkEventDebugSink | undefined;
	throwIfAborted: () => void;
	/** Snapshot resolved once by the runner before draining; reused unchanged through prepare. */
	resolvedConfig: CursorResolvedSdkConfig;
}

interface PrepareCursorProviderTurnContext extends PrepareCursorProviderTurnParams {
	agentMode: AgentModeOption;
	selection: ModelSelection;
	fastEnabled: boolean | undefined;
}

function buildCursorCloudPromptContext(context: Context, handoff: "fresh" | "bootstrap" | "never"): Context {
	if (handoff === "bootstrap") return context;
	for (let index = context.messages.length - 1; index >= 0; index -= 1) {
		const message = context.messages[index];
		if (message.role === "user") return { ...context, messages: [message] };
	}
	return { ...context, messages: context.messages.slice(-1) };
}

const CLOUD_SEND_PLAN: CursorSessionSendPlan = { mode: "bootstrap", resetAgent: false, reason: "initial" };

export function resolveCursorProviderTurnConfig(cwd: string) {
	return resolveEffectiveCursorConfig({ cwd, projectTrusted: getCursorSessionProjectTrusted() });
}

function buildCloudCursorProviderTurnLifecycle(agent: SDKAgent): CursorProviderTurnLifecycle {
	return {
		trackRunCompletion: () => {},
		commitSend: () => {},
		abandon: async () => {},
		dispose: async () => {
			await agent[Symbol.asyncDispose]?.();
		},
	};
}

function buildLocalCursorProviderTurnLifecycle(
	lease: SessionCursorAgentLease,
	scopeKey: string,
): CursorProviderTurnLifecycle {
	return {
		trackRunCompletion: (completion) => lease.trackRunCompletion(completion),
		commitSend: (context, bootstrapped) => lease.commitSend(context, bootstrapped),
		abandon: () => abandonSessionCursorAgent(scopeKey),
		dispose: async () => {},
	};
}

async function prepareCursorCloudProviderTurn(
	prepareParams: PrepareCursorProviderTurnContext,
): Promise<CloudCursorProviderTurnPrepareResult> {
	const { params, cwd, resolvedApiKey, sdkEventDebug, throwIfAborted, resolvedConfig, agentMode, selection, fastEnabled } = prepareParams;
	const { model, context, options } = params;

	let restoreCursorSdkOutputFilter: (() => void) | undefined;
	let cloudAgentForCleanup: SDKAgent | undefined;
	let completed = false;

	try {
		const preflight = preflightCursorCloudRuntime({
			resolvedConfig,
			localState: resolvedConfig.cloud.allowLocalState.value
				? { insideGitRepo: false }
				: inspectCursorCloudLocalState(cwd, {
					repo: resolvedConfig.cloud.repo.value,
					branch: resolvedConfig.cloud.branch.value,
				}),
			hasPriorContext: context.messages.length > 1,
		});
		if (!preflight.ok) throw new Error(formatCursorCloudPreflightError(preflight));
		if (getPendingCursorLiveRun(context) || getActiveCursorLiveRunForCurrentScope()) {
			throw new Error("Cursor cloud runtime cannot start while a local Cursor live run is pending; finish or abort the local run, then retry.");
		}

		const { Agent } = await loadCursorSdk();
		restoreCursorSdkOutputFilter = installCursorSdkOutputFilter();
		const promptOptions = {
			...getCursorPromptOptions(model),
			agentMode,
			includePiBridgeGuidance: false,
			includePiAskQuestionGuidance: false,
		};
		const prompt = buildCursorPrompt(
			buildCursorCloudPromptContext(context, resolvedConfig.cloud.contextHandoff.value),
			promptOptions,
		);
		const promptInputTokens = estimateCursorPromptTokens(prompt, promptOptions);
		const agent = await suppressCursorSdkOutput(() =>
			Agent.create(buildCursorCloudAgentOptions({
				apiKey: resolvedApiKey,
				modelSelection: selection,
				agentMode,
				resolvedConfig,
				name: getCursorSessionName(),
			})),
		);
		cloudAgentForCleanup = agent;
		if (!recordCursorCloudLifecycleSafely({ agentId: agent.agentId }, resolvedApiKey)) {
			throw createCursorCloudLifecyclePersistenceError(agent.agentId, "intent", undefined, resolvedApiKey);
		}
		sdkEventDebug?.recordProviderMeta({ runtime: "cloud", cloudAgentId: agent.agentId, phase: "agent_created" });
		throwIfAborted();

		const textDeltas: string[] = [];
		const nativeReplayId = createCursorNativeReplayId();
		const turnCoordinator = new CursorSdkTurnCoordinator({
			stream: params.stream,
			partial: params.partial,
			cwd,
			resolvedApiKey,
			useNativeToolReplay: false,
			nativeReplayId,
			textDeltas,
			debugRecorder: sdkEventDebug,
		});
		sdkEventDebug?.recordProviderMeta({
			runtime: "cloud",
			cloudAgentId: agent.agentId,
			model: {
				id: model.id,
				provider: model.provider,
				api: model.api,
				reasoning: options?.reasoning ?? "off",
				fastEnabled,
				selection,
			},
			contextHandoff: resolvedConfig.cloud.contextHandoff.value,
			sendPlan: CLOUD_SEND_PLAN,
			promptOptions,
			agentMode,
			localForce: false,
		});

		completed = true;
		cloudAgentForCleanup = undefined;
		return {
			runtimeTarget: "cloud",
			agent,
			cwd,
			payload: {
				text: prompt.text,
				images: prompt.images.length > 0 ? prompt.images : undefined,
			},
			meta: {
				sendPlan: CLOUD_SEND_PLAN,
				prompt,
				bootstrap: true,
				promptInputTokens,
				useNativeToolReplay: false,
				bridgeEnabled: false,
				nativeReplayId,
				agentMode,
				modelSelection: selection,
			},
			contextWindowAgentId: agent.agentId,
			textDeltas,
			restoreCursorSdkOutputFilter,
			lifecycle: buildCloudCursorProviderTurnLifecycle(agent),
			runtime: { kind: "direct", turnCoordinator },
		};
	} finally {
		if (!completed) {
			await cloudAgentForCleanup?.[Symbol.asyncDispose]?.().catch(() => {});
			restoreCursorSdkOutputFilter?.();
		}
	}
}

async function prepareCursorLocalProviderTurn(
	prepareParams: PrepareCursorProviderTurnContext,
): Promise<LocalCursorProviderTurnPrepareResult> {
	const { params, cwd, resolvedApiKey, sdkEventDebug, throwIfAborted, resolvedConfig, agentMode, selection, fastEnabled } = prepareParams;
	const { model, context, options } = params;

	let restoreCursorSdkOutputFilter: (() => void) | undefined;
	let sessionAgentScopeKey: string | undefined;
	let liveRun: CursorLiveRun | undefined;
	let completed = false;

	try {
		ensureCursorRipgrepPath();
		const localSafety = {
			autoReview: resolvedConfig.local.autoReview.value,
			sandboxEnabled: resolvedConfig.local.sandboxEnabled.value,
		};
		const sdk = await loadCursorSdk();
		const { Agent } = sdk;
		const useHttp1ForAgent = configureCursorSdkHttp1(
			sdk,
			resolvedConfig.local.useHttp1ForAgent,
		);

		installCursorMcpToolTimeoutOverride();
		restoreCursorSdkOutputFilter = installCursorSdkOutputFilter();
		const settingSources = getEffectiveCursorSettingSources();
		const queuedBridgeRequestsBeforeLiveRun: CursorPiBridgeToolRequest[] = [];
		let liveRunForBridgeQueue: CursorLiveRun | undefined;

		const sessionAgentAcquireParams = {
			apiKey: resolvedApiKey,
			agentMode,
			cwd,
			modelSelection: selection,
			settingSources,
			localSafety,
			localResume: resolvedConfig.local.resume.value,
			useHttp1ForAgent,
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

		let bridgeToolNames = new Set(sessionAgentLease.bridgeRun?.snapshot.tools.map((tool) => tool.mcpToolName) ?? []);
		let includePiBridgeGuidance = bridgeToolNames.size > 0;
		const buildPromptOptions = (plan: ReturnType<typeof planCursorSessionSend>) => {
			const promptOptions = {
				...getCursorPromptOptions(model),
				agentMode,
				includePiBridgeGuidance,
				includePiAskQuestionGuidance: bridgeToolNames.has("pi__cursor_ask_question"),
			};
			if (plan.mode !== "bootstrap" || !resolveCursorToolManifestEnabled()) {
				return promptOptions;
			}
			return {
				...promptOptions,
				toolManifest: buildCursorToolManifestText({
					bridgeSnapshot: sessionAgentLease.bridgeRun?.snapshot,
					piBridgeEnabled: resolveCursorPiToolBridgeEnabled(),
					includePiBridgeGuidance,
				}),
			};
		};
		let sendPlan = planCursorSessionSend(sessionAgentLease.sendState, context);
		if (sessionAgentLease.created && sessionAgentLease.resumed && sendPlan.mode === "incremental") {
			sendPlan = { mode: "bootstrap", resetAgent: false, reason: "process_resume" };
		}
		let promptOptions = buildPromptOptions(sendPlan);
		let prompt = buildCursorSessionSendPrompt(context, promptOptions, sendPlan);
		if (sendPlan.resetAgent) {
			await resetSessionCursorAgent(sessionAgentScopeKey);
			sessionAgentLease = await acquireSessionCursorAgent({ ...sessionAgentAcquireParams, forceCreate: true });
			sessionAgentScopeKey = sessionAgentLease.scopeKey;
			bridgeToolNames = new Set(sessionAgentLease.bridgeRun?.snapshot.tools.map((tool) => tool.mcpToolName) ?? []);
			includePiBridgeGuidance = bridgeToolNames.size > 0;
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
		const promptInputTokens = estimateCursorPromptTokens(prompt, promptOptions);
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
			localForce: resolvedConfig.local.force.value,
			localResume: resolvedConfig.local.resume.value,
			resumedAgent: sessionAgentLease.resumed,
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
			runtimeTarget: "local",
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
				modelSelection: selection,
				...(sessionAgentLease.resumeNotice ? { resumeNotice: sessionAgentLease.resumeNotice } : {}),
			},
			contextWindowAgentId: agent.agentId,
			textDeltas,
			sessionAgentScopeKey,
			sessionAgentLease,
			localForce: resolvedConfig.local.force,
			restoreCursorSdkOutputFilter,
			lifecycle: buildLocalCursorProviderTurnLifecycle(sessionAgentLease, sessionAgentScopeKey),
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

/** Resolves the runtime target from the caller-supplied snapshot and dispatches to the owning branch. */
export async function prepareCursorProviderTurn(
	prepareParams: PrepareCursorProviderTurnParams,
): Promise<CursorProviderTurnPrepareResult> {
	const { params, resolvedConfig } = prepareParams;
	const { model, options } = params;

	const agentMode = getCursorProviderAgentModeOrThrow();
	const fastEnabled = resolvedConfig.runtime.value === "cloud" ? undefined : getEffectiveFastForModelId(model.id);
	const selection = buildCursorModelSelection(model.id, options?.reasoning ?? "off", fastEnabled);
	const context: PrepareCursorProviderTurnContext = { ...prepareParams, agentMode, selection, fastEnabled };

	return resolvedConfig.runtime.value === "cloud"
		? prepareCursorCloudProviderTurn(context)
		: prepareCursorLocalProviderTurn(context);
}

export function requireCursorApiKey(options: SimpleStreamOptions | undefined): string {
	const apiKey = resolveCursorApiKey(options?.apiKey);
	if (!apiKey) throw new Error(MISSING_CURSOR_API_KEY_MESSAGE);
	return apiKey;
}
