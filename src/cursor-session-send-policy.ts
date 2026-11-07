import type { Context } from "@earendil-works/pi-ai";
import {
	buildCursorIncrementalPrompt,
	buildCursorPrompt,
	shouldBootstrapCursorContext,
	type CursorPrompt,
	type CursorPromptOptions,
} from "./context.js";
import type { SessionCursorAgentSendState } from "./cursor-session-agent.js";

// Long-lived SDK session agents can drift tool-call behavior; recreate the agent after this many successful incremental sends.
export const MAX_COMPLETED_INCREMENTAL_SENDS_BEFORE_REBOOTSTRAP = 20;

/** Each reason fixes its mode and agent reset; only threshold and context divergence replace the agent before bootstrapping. */
export type CursorSessionSendPlan =
	| { mode: "bootstrap"; resetAgent: false; reason: "initial" | "process_resume" }
	| { mode: "bootstrap"; resetAgent: true; reason: "incremental_threshold" | "context_divergence" }
	| { mode: "incremental"; resetAgent: false; reason: "incremental" };

export type CursorSessionSendMode = CursorSessionSendPlan["mode"];

export type CursorSessionSendReason = CursorSessionSendPlan["reason"];

export function planCursorSessionSend(sendState: SessionCursorAgentSendState, context: Context, nativeSourceRoles?: readonly string[]): CursorSessionSendPlan {
	if (!sendState.bootstrapped) {
		return { mode: "bootstrap", resetAgent: false, reason: "initial" };
	}
	if (sendState.incrementalSendCount >= MAX_COMPLETED_INCREMENTAL_SENDS_BEFORE_REBOOTSTRAP) {
		return { mode: "bootstrap", resetAgent: true, reason: "incremental_threshold" };
	}
	if (shouldBootstrapCursorContext(sendState, context, nativeSourceRoles)) {
		return { mode: "bootstrap", resetAgent: true, reason: "context_divergence" };
	}
	return { mode: "incremental", resetAgent: false, reason: "incremental" };
}

export function buildCursorSessionSendPrompt(
	context: Context,
	options: CursorPromptOptions,
	plan: CursorSessionSendPlan,
): CursorPrompt {
	return plan.mode === "bootstrap" ? buildCursorPrompt(context, options) : buildCursorIncrementalPrompt(context, options);
}
