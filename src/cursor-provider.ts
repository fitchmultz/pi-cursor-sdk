import {
	type Api,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type AssistantMessage,
} from "@earendil-works/pi-ai";
import { Agent, createAgentPlatform } from "@cursor/sdk";
import type { SDKAgent } from "@cursor/sdk";
import { installCursorMcpToolTimeoutOverride } from "./cursor-mcp-timeout-override.js";
import { installCursorSdkOutputFilter, suppressCursorSdkOutput } from "./cursor-sdk-output-filter.js";
import {
	acquireSessionCursorAgent,
	buildCursorSessionSendPrompt,
	commitSessionAgentSend,
	disposeAllSessionCursorAgents,
	planCursorSessionSend,
	resetSessionCursorAgent,
} from "./cursor-session-agent.js";
import {
	type CursorPiBridgeToolRequest,
	type CursorPiToolBridgeRun,
} from "./cursor-pi-tool-bridge.js";
import {
	applyCursorApproximateUsage,
	estimateCursorPromptInputTokens,
	getCursorPromptOptions,
} from "./cursor-usage-accounting.js";
import { getCursorSessionCwd } from "./cursor-session-cwd.js";
import { getActiveContextToolNames } from "./cursor-context-tools.js";
import { CursorLiveRunAbortError, type CursorLiveRun } from "./cursor-live-run-coordinator.js";
import {
	abandonSessionCursorAgent,
	createCursorNativeReplayId,
	cursorLiveRuns,
	drainCursorLiveRunTurn,
	drainExistingCursorLiveRunBeforeSend,
	DEFAULT_CURSOR_NATIVE_REPLAY_IDLE_DISPOSE_MS,
	getPendingCursorLiveRun,
	hasTrailingUserMessagesAfterToolResults,
	releaseAllPendingCursorLiveRunsForTests,
	resetCursorNativeReplayIdleDisposeMs,
	selectCursorFinalText,
	setCursorNativeReplayIdleDisposeMs,
	settleCursorLiveToolBatch,
} from "./cursor-provider-live-run-drain.js";
import { getEffectiveFastForModelId } from "./cursor-state.js";
import { buildCursorModelSelection } from "./model-discovery.js";
import { getCheckpointContextWindow, saveCachedContextWindow } from "./context-window-cache.js";
import {
	attachCursorSdkEventDebugPiStreamTap,
	CursorSdkEventDebugSink,
} from "./cursor-sdk-event-debug.js";
import { CursorSdkTurnCoordinator } from "./cursor-provider-turn-coordinator.js";
import { isCursorNativeToolDisplayRuntimeEnabled } from "./cursor-native-tool-display.js";
import {
	formatCursorSdkAbortMessage,
	formatCursorSdkRunFailureDetail,
	MISSING_CURSOR_API_KEY_MESSAGE,
	resolveCursorSdkAbortCause,
	sanitizeCursorProviderError,
} from "./cursor-provider-errors.js";
import { getEffectiveCursorSettingSources } from "./cursor-setting-sources.js";
import { hasUsableText } from "./cursor-record-utils.js";

function makeInitialMessage(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

const CURSOR_API_KEY_ENV_VAR = "CURSOR_API_KEY";

function resolveCursorApiKey(apiKey?: string): string | undefined {
	const trimmed = apiKey?.trim();
	if (!trimmed) return undefined;
	if (trimmed === CURSOR_API_KEY_ENV_VAR) return process.env.CURSOR_API_KEY?.trim();
	return trimmed;
}

async function cacheSdkContextWindow(agentId: string, modelId: string): Promise<void> {
	try {
		const platform = await createAgentPlatform();
		const checkpoint = await platform.checkpointStore.loadLatest(agentId);
		const contextWindow = getCheckpointContextWindow(checkpoint);
		if (contextWindow) saveCachedContextWindow(modelId, contextWindow);
	} catch {
		// Context-window cache failures must not affect response streaming.
	}
}

export function streamCursor(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const sdkEventDebugRef: { current?: CursorSdkEventDebugSink } = {};
	attachCursorSdkEventDebugPiStreamTap(stream, sdkEventDebugRef);

	(async () => {
		const partial = makeInitialMessage(model);
		let agent: SDKAgent | null = null;
		let activeLiveRun: CursorLiveRun | undefined;
		let bridgeRun: CursorPiToolBridgeRun | undefined;
		let liveRunForBridgeQueue: CursorLiveRun | undefined;
		const queuedBridgeRequestsBeforeLiveRun: CursorPiBridgeToolRequest[] = [];
		let resolvedApiKey: string | undefined;
		let sessionAgentScopeKey = "";
		let abortSignal: AbortSignal | undefined;
		let abortListener: (() => void) | undefined;
		let restoreCursorSdkOutputFilter: (() => void) | undefined;
		let sdkEventDebug: CursorSdkEventDebugSink | undefined;
		let deferSdkEventDebugFinalize = false;

		const pushSanitizedStreamError = (error: unknown, reason: "error" | "aborted" = "error"): void => {
			partial.stopReason = reason;
			partial.errorMessage =
				reason === "aborted"
					? formatCursorSdkAbortMessage(resolveCursorSdkAbortCause({ signalAborted: options?.signal?.aborted }))
					: sanitizeCursorProviderError(error, resolvedApiKey ?? options?.apiKey);
			stream.push({ type: "error", reason, error: partial });
		};

		try {
			try {
			const throwIfAborted = (): void => {
				if (options?.signal?.aborted) throw new CursorLiveRunAbortError();
			};

			stream.push({ type: "start", partial });
			throwIfAborted();

			const cwd = getCursorSessionCwd();
			sdkEventDebug = CursorSdkEventDebugSink.maybeCreate({
				cwd,
				modelId: model.id,
				provider: model.provider,
			});
			sdkEventDebugRef.current = sdkEventDebug;
			sdkEventDebug?.recordContextSnapshot(context);

			if ((await drainExistingCursorLiveRunBeforeSend(stream, partial, model, context, options?.signal, sdkEventDebug)) === "stream_ended") {
				sdkEventDebug?.recordFinalPartial(partial);
				await sdkEventDebug?.finalize();
				sdkEventDebugRef.current = undefined;
				return;
			}

			const apiKey = resolveCursorApiKey(options?.apiKey);
			if (!apiKey) throw new Error(MISSING_CURSOR_API_KEY_MESSAGE);
			resolvedApiKey = apiKey;

			const fastEnabled = getEffectiveFastForModelId(model.id);
			const selection = buildCursorModelSelection(model.id, options?.reasoning ?? "off", fastEnabled);
			const settingSources = getEffectiveCursorSettingSources();

			installCursorMcpToolTimeoutOverride();
			restoreCursorSdkOutputFilter = installCursorSdkOutputFilter();
			const sessionAgentAcquireParams = {
				apiKey,
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
			agent = sessionAgentLease.agent;
			bridgeRun = sessionAgentLease.bridgeRun;
			throwIfAborted();

			const promptOptions = getCursorPromptOptions(model);
			let sendPlan = planCursorSessionSend(sessionAgentLease.sendState, context);
			let prompt = buildCursorSessionSendPrompt(context, promptOptions, sendPlan);
			if (sendPlan.resetAgent) {
				await resetSessionCursorAgent(sessionAgentLease.scopeKey);
				sessionAgentLease = await acquireSessionCursorAgent(sessionAgentAcquireParams);
				sessionAgentScopeKey = sessionAgentLease.scopeKey;
				agent = sessionAgentLease.agent;
				bridgeRun = sessionAgentLease.bridgeRun;
				sendPlan = planCursorSessionSend(sessionAgentLease.sendState, context);
				prompt = buildCursorSessionSendPrompt(context, promptOptions, sendPlan);
			}
			const bootstrap = sendPlan.mode === "bootstrap";
			const sessionBridgeRun = sessionAgentLease.bridgeRun;
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
				activeToolNames: activeToolNames ? [...activeToolNames] : [],
				sessionAgentScopeKey,
				bridgeRunId: bridgeRun?.id,
			});
			const nativeReplayId = createCursorNativeReplayId();
			const textDeltas: string[] = [];
			const useLiveRun = useNativeToolReplay || bridgeRun !== undefined;
			const liveRun: CursorLiveRun | undefined = useLiveRun
				? cursorLiveRuns.start({
						id: useNativeToolReplay ? nativeReplayId : bridgeRun!.id,
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
				activeLiveRun = liveRun;
				liveRunForBridgeQueue = liveRun;
				for (const request of queuedBridgeRequestsBeforeLiveRun.splice(0)) {
					cursorLiveRuns.queueEvent(liveRun, { type: "bridge-tool", request });
				}
			}
			const turnCoordinator = new CursorSdkTurnCoordinator({
				stream,
				partial,
				cwd,
				resolvedApiKey,
				liveRun,
				useNativeToolReplay,
				activeToolNames,
				nativeReplayId,
				textDeltas,
				debugRecorder: sdkEventDebug,
			});

			// Handle abort signal
			let run: Awaited<ReturnType<SDKAgent["send"]>> | null = null;
			abortListener = () => {
				activeLiveRun?.bridgeRun?.cancel("Cursor SDK run aborted");
				if (run) {
					run.cancel().catch(() => {});
				}
			};
			abortSignal = options?.signal;
			abortSignal?.addEventListener("abort", abortListener, { once: true });

			throwIfAborted();
			sdkEventDebug?.recordSendMeta({
				mode: sendPlan.mode,
				reason: sendPlan.reason,
				resetAgent: sendPlan.resetAgent,
				bootstrap,
				promptText: prompt.text,
				imageCount: prompt.images.length,
				useNativeToolReplay,
				bridgeEnabled: bridgeRun !== undefined,
				nativeReplayId,
				promptInputTokens,
			});
			const sendPayload = {
				text: prompt.text,
				images: prompt.images.length > 0 ? prompt.images : undefined,
			};
			sdkEventDebug?.recordSendPayload(sendPayload);
			sdkEventDebug?.recordProviderEvent("agent_send_start", sendPayload);
			run = await agent.send(sendPayload, {
				onDelta: (args) => {
					sdkEventDebug?.recordOnDelta(args.update);
					turnCoordinator.handleDelta(args.update);
				},
				onStep: (args) => {
					sdkEventDebug?.recordOnStep(args.step);
					turnCoordinator.handleStep(args.step);
				},
			});
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
				await run.cancel().catch(() => {});
				throw new CursorLiveRunAbortError();
			}

			if (liveRun) {
				deferSdkEventDebugFinalize = true;
				const waitCompletion = run
					.wait()
					.then(async (result) => {
						sdkEventDebug?.recordWaitResult(result);
						await sdkEventDebug?.captureRunArtifacts(run);
						if (liveRun.disposed) return;
						turnCoordinator.discardIncompleteStartedToolCalls();
						await cacheSdkContextWindow(liveRun.agent.agentId, model.id);
						if (liveRun.disposed) return;
						if (result.status === "finished" && !options?.signal?.aborted) {
							commitSessionAgentSend(sessionAgentScopeKey, context, bootstrap);
							cursorLiveRuns.markFinished(
								liveRun,
								selectCursorFinalText(result.result, liveRun.textDeltas, liveRun.emittedText, turnCoordinator.planTextCandidate),
							);
						} else if (result.status === "cancelled" || options?.signal?.aborted) {
							cursorLiveRuns.markCancelled(
								liveRun,
								formatCursorSdkAbortMessage(
									resolveCursorSdkAbortCause({
										signalAborted: options?.signal?.aborted,
										sdkStatusCancelled: result.status === "cancelled",
									}),
								),
							);
						} else {
							const failureDetail = formatCursorSdkRunFailureDetail(result, run?.result);
							cursorLiveRuns.markError(
								liveRun,
								sanitizeCursorProviderError(failureDetail, resolvedApiKey ?? options?.apiKey),
							);
						}
					})
					.catch(async (error: unknown) => {
						sdkEventDebug?.recordWaitResult({ status: "error", error: String(error) });
						sdkEventDebug?.recordError("run_wait", error);
						await sdkEventDebug?.captureRunArtifacts(run);
						if (liveRun.disposed) return;
						cursorLiveRuns.markError(liveRun, sanitizeCursorProviderError(error, resolvedApiKey ?? options?.apiKey));
					});

				try {
					await cursorLiveRuns.withRunLease(liveRun, options?.signal, async () => {
						await cursorLiveRuns.waitForProgress(liveRun, options?.signal);
						await settleCursorLiveToolBatch(liveRun);
						turnCoordinator.closeTraceBlock();
						await drainCursorLiveRunTurn(stream, partial, model, context, liveRun, 0, {
							mode: "emit",
							signal: options?.signal,
							debugRecorder: sdkEventDebug,
						});
					});
				} catch (error) {
					if (error instanceof CursorLiveRunAbortError) await cursorLiveRuns.release(liveRun);
					throw error;
				} finally {
					sdkEventDebugRef.current = undefined;
					void waitCompletion
						.finally(async () => {
							sdkEventDebug?.recordFinalPartial(partial);
							await sdkEventDebug?.finalize();
						})
						.catch(() => {});
				}
				agent = null;
				return;
			}

			const result = await run.wait();
			sdkEventDebug?.recordWaitResult(result);
			await sdkEventDebug?.captureRunArtifacts(run);
			turnCoordinator.discardIncompleteStartedToolCalls();
			await cacheSdkContextWindow(agent.agentId, model.id);

			// Close any open thinking/activity trace, then use the final run result only when
			// Cursor did not stream text deltas.
			turnCoordinator.closeTraceBlock();

			if (result.status === "cancelled") {
				await abandonSessionCursorAgent(sessionAgentScopeKey);
				partial.stopReason = "aborted";
				partial.errorMessage = formatCursorSdkAbortMessage(
					resolveCursorSdkAbortCause({
						signalAborted: options?.signal?.aborted,
						sdkStatusCancelled: true,
					}),
				);
				stream.push({ type: "error", reason: "aborted", error: partial });
			} else if (result.status === "error") {
				await abandonSessionCursorAgent(sessionAgentScopeKey);
				partial.stopReason = "error";
				const failureDetail = formatCursorSdkRunFailureDetail(result, run.result);
				partial.errorMessage = sanitizeCursorProviderError(failureDetail, resolvedApiKey ?? options?.apiKey);
				stream.push({ type: "error", reason: "error", error: partial });
			} else {
				commitSessionAgentSend(sessionAgentScopeKey, context, bootstrap);
				const finalCursorText = selectCursorFinalText(result.result, textDeltas, textDeltas.join(""), turnCoordinator.planTextCandidate, {
					allowPartialPrefix: true,
				});
				turnCoordinator.flushText(hasUsableText(finalCursorText) ? [finalCursorText] : []);
				applyCursorApproximateUsage(partial, model, context, promptInputTokens);
				stream.push({ type: "done", reason: "stop", message: partial });
			}
			} catch (error) {
				sdkEventDebug?.recordError("provider_stream", error);
				if (activeLiveRun && !activeLiveRun.disposed) await cursorLiveRuns.release(activeLiveRun);
				else await abandonSessionCursorAgent(sessionAgentScopeKey);
				if (error instanceof CursorLiveRunAbortError) {
					pushSanitizedStreamError(error, "aborted");
				} else {
					pushSanitizedStreamError(error, "error");
				}
			} finally {
				if (!deferSdkEventDebugFinalize) {
					sdkEventDebug?.recordFinalPartial(partial);
					await sdkEventDebug?.finalize();
				}
				sdkEventDebugRef.current = undefined;
				restoreCursorSdkOutputFilter?.();

				if (abortSignal && abortListener) {
					abortSignal.removeEventListener("abort", abortListener);
				}
			}
		} catch (error) {
			if (activeLiveRun && !activeLiveRun.disposed) await cursorLiveRuns.release(activeLiveRun).catch(() => {});
			else await abandonSessionCursorAgent(sessionAgentScopeKey).catch(() => {});
			pushSanitizedStreamError(error, "error");
		}

		stream.end();
	})().catch((error: unknown) => {
		const partial = makeInitialMessage(model);
		partial.stopReason = "error";
		partial.errorMessage = sanitizeCursorProviderError(error, resolveCursorApiKey(options?.apiKey));
		stream.push({ type: "error", reason: "error", error: partial });
		stream.end();
	});

	return stream;
}

export const __testUtils = {
	DEFAULT_CURSOR_NATIVE_REPLAY_IDLE_DISPOSE_MS,
	pendingCursorNativeRunCount: cursorLiveRuns.count,
	getPendingCursorLiveRun,
	getActiveCursorLiveRunForScope: cursorLiveRuns.getActiveForScope,
	hasTrailingUserMessagesAfterToolResults,
	setCursorNativeReplayIdleDisposeMs,
	resetCursorNativeReplayIdleDisposeMs,
	releaseAllPendingCursorLiveRunsForTests,
	resetSessionCursorAgents: () => disposeAllSessionCursorAgents(),
};
