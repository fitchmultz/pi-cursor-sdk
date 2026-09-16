import type {
	ExtensionContext,
	ExtensionHandler,
	SessionBeforeTreeEvent,
	SessionCompactEvent,
	SessionShutdownEvent,
	SessionStartEvent,
	SessionTreeEvent,
} from "@earendil-works/pi-coding-agent";
import { clearCursorSdkHttp1 } from "./cursor-http1.js";
import {
	associateCursorSessionScopeSignal,
	resolveCursorSessionScopeFromContext,
	takePreviousCursorSessionScopeKey,
} from "./cursor-session-scope.js";
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
	on(event: "model_select", handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void): void;
}

export function registerCursorSessionAgentLifecycle(pi: CursorSessionAgentLifecycleExtensionApi): void {
	pi.on("session_start", async (_event, ctx) => {
		const previousScopeKey = takePreviousCursorSessionScopeKey(ctx);
		if (previousScopeKey) await disposeSessionCursorAgent(previousScopeKey);
	});
	pi.on("session_shutdown", async (event, ctx) => {
		const scope = resolveCursorSessionScopeFromContext(ctx);
		try {
			if (event.reason === "reload") {
				await resetSessionCursorAgent(scope.scopeKey);
				return;
			}
			await disposeSessionCursorAgent(scope);
		} finally {
			clearCursorSdkHttp1();
		}
	});
	pi.on("session_compact", (_event, ctx) => {
		invalidateSessionAgent(resolveCursorSessionScopeFromContext(ctx).scopeKey);
	});
	pi.on("session_before_tree", (event, ctx) => {
		const scope = associateCursorSessionScopeSignal(event.signal, ctx);
		invalidateSessionAgent(scope.scopeKey);
	});
	pi.on("session_tree", async (_event, ctx) => {
		await resetSessionCursorAgent(resolveCursorSessionScopeFromContext(ctx).scopeKey);
	});
	pi.on("model_select", (_event, ctx) => {
		invalidateSessionAgent(resolveCursorSessionScopeFromContext(ctx).scopeKey);
	});
}
