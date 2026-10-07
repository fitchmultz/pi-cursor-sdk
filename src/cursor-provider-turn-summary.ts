import type { ModelSelection, SDKAgent } from "@cursor/sdk";
import { buildCursorSummaryPrompt, estimateCursorPromptTokens } from "./context.js";
import { configureCursorSdkHttp1 } from "./cursor-http1.js";
import { createCursorNativeReplayId } from "./cursor-provider-live-run-drain.js";
import type { PrepareCursorProviderTurnParams } from "./cursor-provider-turn-prepare.js";
import { CursorSdkTurnCoordinator } from "./cursor-provider-turn-coordinator.js";
import type { CursorProviderTurnLifecycle, SummaryCursorProviderTurnPrepareResult } from "./cursor-provider-turn-types.js";
import { ensureCursorRipgrepPath } from "./cursor-ripgrep-path.js";
import { loadCursorSdk } from "./cursor-sdk-runtime.js";
import { installCursorSdkOutputFilter, suppressCursorSdkOutput } from "./cursor-sdk-output-filter.js";
import { buildCursorLocalAgentOptions } from "./cursor-session-agent.js";
import { openCursorSessionStoreForScope, type OpenCursorSessionStore } from "./cursor-session-store.js";
import { getCursorPromptOptions } from "./cursor-usage-accounting.js";

function summaryLifecycle(agent: SDKAgent, sessionStore: OpenCursorSessionStore): CursorProviderTurnLifecycle {
	let disposal: Promise<void> | undefined;
	const dispose = () => disposal ??= (async () => {
		try {
			await agent[Symbol.asyncDispose]();
		} finally {
			await sessionStore.dispose();
		}
	})();
	return { trackRunCompletion: () => {}, commitSend: () => {}, abandon: dispose, dispose };
}

/** A native summary never enters the conversation pool or inherits its tool/mode/resume state. */
export async function prepareCursorSummaryProviderTurn(
	prepareParams: PrepareCursorProviderTurnParams,
	selection: ModelSelection,
): Promise<SummaryCursorProviderTurnPrepareResult> {
	const { params, cwd, resolvedApiKey, resolvedConfig, sdkEventDebug, throwIfAborted } = prepareParams;
	let sessionStore: OpenCursorSessionStore | undefined;
	let agent: SDKAgent | undefined;
	let restoreCursorSdkOutputFilter: (() => void) | undefined;
	let completed = false;
	try {
		ensureCursorRipgrepPath();
		const sdk = await loadCursorSdk();
		configureCursorSdkHttp1(sdk, resolvedConfig.local.useHttp1ForAgent);
		restoreCursorSdkOutputFilter = installCursorSdkOutputFilter();
		sessionStore = (await openCursorSessionStoreForScope({
			cwd, scopeKey: params.scope.persistentScopeKey ?? params.scope.scopeKey, persistent: false,
		})).sessionStore;
		throwIfAborted();
		agent = await suppressCursorSdkOutput(() => sdk.Agent.create({
			apiKey: resolvedApiKey,
			model: selection,
			mode: "agent",
			tools: [],
			local: buildCursorLocalAgentOptions({ cwd, store: sessionStore!.store, settingSources: [] }),
		}));
		throwIfAborted();
		const prompt = buildCursorSummaryPrompt(params.context);
		const promptInputTokens = estimateCursorPromptTokens(prompt, getCursorPromptOptions(params.model));
		const nativeReplayId = createCursorNativeReplayId();
		const textDeltas: string[] = [];
		const turnCoordinator = new CursorSdkTurnCoordinator({
			stream: params.stream, partial: params.partial, cwd, resolvedApiKey,
			useNativeToolReplay: false, nativeReplayId, textDeltas, debugRecorder: sdkEventDebug,
		});
		sdkEventDebug?.recordProviderMeta({
			purpose: params.request.purpose,
			runtime: "local",
			summaryAgentId: agent.agentId,
			model: { id: params.model.id, provider: params.model.provider, selection },
			agentMode: "agent", settingSources: [], tools: [], resumedAgent: false,
		});
		completed = true;
		return {
			runtimeTarget: "local", execution: "summary", agent, cwd,
			store: sessionStore.store, storeIdentity: sessionStore.identity,
			payload: { text: prompt.text },
			meta: {
				sendPlan: { mode: "bootstrap", resetAgent: false, reason: "initial" },
				prompt, bootstrap: true, promptInputTokens,
				useNativeToolReplay: false, bridgeEnabled: false, nativeReplayId,
				agentMode: "agent", modelSelection: selection,
			},
			contextWindowAgentId: agent.agentId, textDeltas, restoreCursorSdkOutputFilter,
			lifecycle: summaryLifecycle(agent, sessionStore),
			runtime: { kind: "direct", turnCoordinator },
		};
	} finally {
		if (!completed) {
			try {
				await agent?.[Symbol.asyncDispose]().catch(() => {});
			} finally {
				await sessionStore?.dispose().catch(() => {});
				restoreCursorSdkOutputFilter?.();
			}
		}
	}
}
