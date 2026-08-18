import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { AgentModeOption, ModelSelection, SDKAgent, SDKImage } from "@cursor/sdk";
import type { CursorLiveRun } from "./cursor-live-run-coordinator.js";
import type { SessionCursorAgentLease } from "./cursor-session-agent.js";
import type { planCursorSessionSend } from "./cursor-session-agent.js";
import type { CursorSdkEventDebugSink } from "./cursor-sdk-event-debug.js";
import type { CursorSdkTurnCoordinator } from "./cursor-provider-turn-coordinator.js";
import type { CursorPrompt } from "./context.js";
import type { CursorResolvedSetting } from "./cursor-config.js";
import type { CursorSdkTurnUsage } from "./cursor-usage-accounting.js";

export interface CursorProviderTurnRunnerParams {
	model: Model<Api>;
	context: Context;
	stream: AssistantMessageEventStream;
	partial: AssistantMessage;
	options?: SimpleStreamOptions;
	sdkEventDebugRef: { current?: CursorSdkEventDebugSink };
}

export interface CursorProviderTurnSendPayload {
	text: string;
	images?: SDKImage[];
}

export interface CursorProviderTurnSendMeta {
	sendPlan: ReturnType<typeof planCursorSessionSend>;
	prompt: CursorPrompt;
	bootstrap: boolean;
	promptInputTokens: number;
	useNativeToolReplay: boolean;
	bridgeEnabled: boolean;
	nativeReplayId: string;
	agentMode: AgentModeOption;
	modelSelection: ModelSelection;
	resumeNotice?: string;
}

interface CursorProviderTurnRuntimeBase {
	turnCoordinator: CursorSdkTurnCoordinator;
	billedTurnUsage?: CursorSdkTurnUsage;
}

/**
 * Runtime-agnostic lifecycle operations for a prepared turn.
 *
 * Local implementations delegate to the session agent lease; cloud
 * implementations no-op the local-only operations (commitSend,
 * trackRunCompletion, abandon) and dispose the cloud agent instead.
 */
export interface CursorProviderTurnLifecycle {
	trackRunCompletion(completion: Promise<unknown>): void;
	commitSend(context: Context, bootstrapped: boolean): void;
	abandon(): Promise<void>;
	dispose(): Promise<void>;
}

export interface DirectCursorProviderTurnRuntime extends CursorProviderTurnRuntimeBase {
	kind: "direct";
	liveRun?: undefined;
}

export interface LiveCursorProviderTurnRuntime extends CursorProviderTurnRuntimeBase {
	kind: "live";
	liveRun: CursorLiveRun;
}

export type CursorProviderTurnRuntime = DirectCursorProviderTurnRuntime | LiveCursorProviderTurnRuntime;

interface CursorProviderTurnPrepareResultBase {
	agent: SDKAgent;
	cwd: string;
	payload: CursorProviderTurnSendPayload;
	meta: CursorProviderTurnSendMeta;
	contextWindowAgentId: string;
	textDeltas: string[];
	restoreCursorSdkOutputFilter: () => void;
	lifecycle: CursorProviderTurnLifecycle;
}

export interface LocalCursorProviderTurnPrepareResult extends CursorProviderTurnPrepareResultBase {
	runtimeTarget: "local";
	runtime: CursorProviderTurnRuntime;
	sessionAgentScopeKey: string;
	sessionAgentLease: SessionCursorAgentLease;
	localForce: CursorResolvedSetting<boolean>;
}

export interface CloudCursorProviderTurnPrepareResult extends CursorProviderTurnPrepareResultBase {
	runtimeTarget: "cloud";
	runtime: DirectCursorProviderTurnRuntime;
	sessionAgentScopeKey?: undefined;
	sessionAgentLease?: undefined;
}

/**
 * Single owned model for a prepared provider turn.
 *
 * Send, finalize, and cleanup phases receive this immutable object instead of
 * keeping parallel liveRun/turnCoordinator/resource bags in sync by convention.
 */
export type CursorProviderTurnPrepareResult =
	| LocalCursorProviderTurnPrepareResult
	| CloudCursorProviderTurnPrepareResult;

export interface CursorProviderTurnSend {
	run: Awaited<ReturnType<SDKAgent["send"]>>;
	cursorAgentMessageOffset: number | undefined;
}

export interface CursorProviderTurnSendResult {
	send: CursorProviderTurnSend;
	abortRegistration: { signal: AbortSignal; listener: () => void } | undefined;
}
