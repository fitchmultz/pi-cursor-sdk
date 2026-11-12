import { asRecord } from "./cursor-record-utils.js";
import type { CursorLiveRun } from "./cursor-live-run-coordinator.js";
import {
	mergeShellOutputDeltasIntoCursorToolCall,
	type CursorShellOutputTracker,
} from "./cursor-provider-turn-shell-output.js";
import { getCursorToolCallIdentity, type CursorToolCompletionLedger } from "./cursor-provider-turn-tool-ledger.js";

export type CursorToolCompletionSource = "delta" | "step";

function mergeCursorToolCalls(startedToolCall: unknown, completedToolCall: unknown): unknown {
	const started = asRecord(startedToolCall);
	const completed = asRecord(completedToolCall);
	if (!started) return completedToolCall;
	if (!completed) return startedToolCall;
	return {
		...started,
		...completed,
		name: completed.name ?? started.name,
		type: completed.type ?? started.type,
		args: completed.args ?? started.args,
		input: completed.input ?? started.input,
		result: completed.result ?? started.result,
	};
}

export type ToolCompletionResolution =
	| { action: "ignore-bridge"; identity?: string }
	| {
			action: "handle";
			toolCall: unknown;
			identity?: string;
			source?: "started" | "fallback";
			matchedStartedCallId?: string;
	  };

export interface ResolveCursorToolCompletionOptions {
	source: CursorToolCompletionSource;
	callId: unknown;
	toolCall: unknown;
	startedToolCall?: unknown;
	liveRun?: CursorLiveRun;
	ledger: CursorToolCompletionLedger;
	shellOutput: CursorShellOutputTracker;
	onClearStartedCallId?: (callId: string) => void;
}

export function resolveCursorToolCompletion(options: ResolveCursorToolCompletionOptions): ToolCompletionResolution {
	// Missing IDs are looked up as "" and an empty ID is falsy below, so a "" bridge start never short-circuits.
	const bridgeStartedCallId = options.ledger.takeBridgeStartedCallId(
		typeof options.callId === "string" ? options.callId : "",
	);
	if (bridgeStartedCallId) {
		const bridgeIdentity = getCursorToolCallIdentity(bridgeStartedCallId);
		options.ledger.recordCompletedIdentity(bridgeIdentity);
		return { action: "ignore-bridge", identity: bridgeIdentity };
	}

	let matchedStartedCallId: string | undefined;
	let resolvedToolCall: unknown;
	let identity: string | undefined;
	let source: "started" | "fallback" | undefined;

	if (options.source === "delta") {
		const callId = options.callId;
		identity = typeof callId === "string" ? getCursorToolCallIdentity(callId) : undefined;
		resolvedToolCall = mergeCursorToolCalls(options.startedToolCall, options.toolCall);
		if (typeof callId === "string" && options.ledger.hasStartedToolCall(callId)) {
			options.onClearStartedCallId?.(callId);
			options.ledger.clearStartedToolCall(callId);
		} else {
			matchedStartedCallId = options.ledger.removeStartedToolCallForStep(options.toolCall, callId);
			if (matchedStartedCallId) options.onClearStartedCallId?.(matchedStartedCallId);
		}
		resolvedToolCall = mergeShellOutputDeltasIntoCursorToolCall(
			resolvedToolCall,
			matchedStartedCallId
				? options.shellOutput.takeDeltasForCall(matchedStartedCallId)
				: typeof callId === "string"
					? options.shellOutput.takeDeltasForCall(callId)
					: undefined,
		);
		source = identity || matchedStartedCallId ? "started" : "fallback";
	} else {
		matchedStartedCallId = options.ledger.removeStartedToolCallForStep(options.toolCall, options.callId);
		if (matchedStartedCallId) {
			options.onClearStartedCallId?.(matchedStartedCallId);
		}
		resolvedToolCall = mergeShellOutputDeltasIntoCursorToolCall(
			options.toolCall,
			matchedStartedCallId ? options.shellOutput.takeDeltasForCall(matchedStartedCallId) : undefined,
		);
		const identityId = typeof options.callId === "string" ? options.callId : matchedStartedCallId;
		identity = identityId ? getCursorToolCallIdentity(identityId) : undefined;
	}

	if (options.liveRun?.bridgeRun?.isBridgeMcpToolCall(resolvedToolCall)) {
		const bridgeIdentity =
			options.source === "step" && matchedStartedCallId ? getCursorToolCallIdentity(matchedStartedCallId) : identity;
		if (bridgeIdentity) options.ledger.recordCompletedIdentity(bridgeIdentity);
		return { action: "ignore-bridge", identity: bridgeIdentity };
	}

	if (options.source === "delta") {
		return { action: "handle", toolCall: resolvedToolCall, identity, source, matchedStartedCallId };
	}
	return {
		action: "handle",
		toolCall: resolvedToolCall,
		identity,
		matchedStartedCallId,
	};
}
