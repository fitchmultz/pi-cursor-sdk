import type {
	ExtensionHandler,
	SessionBeforeTreeEvent,
	SessionCompactEvent,
	SessionShutdownEvent,
	SessionTreeEvent,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { clearCursorSdkHttp1 } from "./cursor-http1.js";
import { releaseCursorLiveRunOffBranch } from "./cursor-provider-live-run-drain.js";
import { cursorRuntimeSessionScopeKeyForManager, hasLiveCursorSessions, onCursorSessionScopeKeyChange } from "./cursor-session-scope.js";
import {
	disposeSessionCursorAgent,
	invalidateSessionAgent,
	resetSessionCursorAgent,
} from "./cursor-session-agent.js";

export interface CursorSessionAgentLifecycleExtensionApi {
	on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): void;
	on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>): void;
	on(event: "session_compact", handler: ExtensionHandler<SessionCompactEvent>): void;
	on(event: "session_before_tree", handler: ExtensionHandler<SessionBeforeTreeEvent>): void;
	on(event: "session_tree", handler: ExtensionHandler<SessionTreeEvent>): void;
	on(event: "model_select", handler: () => Promise<void> | void): void;
}

export function registerCursorSessionAgentLifecycle(pi: CursorSessionAgentLifecycleExtensionApi): void {
	let scopeKey: string | undefined;
	pi.on("session_start", (_event, ctx) => { scopeKey = cursorRuntimeSessionScopeKeyForManager(ctx.sessionManager); });
	onCursorSessionScopeKeyChange(pi, async (previousScopeKey) => {
		await disposeSessionCursorAgent(previousScopeKey);
	});
	pi.on("session_shutdown", async (event) => {
		try {
			if (scopeKey === undefined) return;
			if (event.reason === "reload") {
				await resetSessionCursorAgent(scopeKey);
				return;
			}
			await disposeSessionCursorAgent(scopeKey);
		} finally {
			if (!hasLiveCursorSessions()) clearCursorSdkHttp1();
		}
	});
	pi.on("session_compact", () => {
		if (scopeKey !== undefined) invalidateSessionAgent(scopeKey);
	});
	pi.on("session_before_tree", () => {
		if (scopeKey !== undefined) invalidateSessionAgent(scopeKey);
	});
	pi.on("session_tree", async (_event, ctx) => {
		if (scopeKey === undefined) return;
		const disposition = await releaseCursorLiveRunOffBranch(scopeKey, ctx.sessionManager.getBranch().flatMap((entry) =>
			entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []));
		// A run kept by the selected branch still owns its agent and bridge; the before-tree invalidation replaces that
		// agent at the next acquisition, which follows the run's release. Otherwise, like compaction, reset after release.
		if (disposition !== "kept") await resetSessionCursorAgent(scopeKey);
	});
	pi.on("model_select", () => {
		if (scopeKey !== undefined) invalidateSessionAgent(scopeKey);
	});
}
