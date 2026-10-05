import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isCursorModel } from "./cursor-model.js";
import { registerCursorModelLifecycle, type CursorModelLifecycleExtensionApi } from "./cursor-model-lifecycle.js";
import { cursorSessionScopeKeyForManager } from "./cursor-session-scope.js";
import type { CursorModelFallbackIssue } from "./model-discovery.js";

export type CursorFallbackWarningExtensionApi = CursorModelLifecycleExtensionApi;

export function registerCursorFallbackIssueWarning(
	pi: CursorFallbackWarningExtensionApi,
	issue?: CursorModelFallbackIssue,
): (nextIssue: CursorModelFallbackIssue | undefined) => void {
	const warnedSessionScopeKeys = new Set<string>();

	registerCursorModelLifecycle(pi, (ctx: ExtensionContext) => {
		if (!issue || !isCursorModel(ctx.model) || !ctx.hasUI) return;
		const scopeKey = cursorSessionScopeKeyForManager(ctx.sessionManager);
		if (warnedSessionScopeKeys.has(scopeKey)) return;
		warnedSessionScopeKeys.add(scopeKey);
		ctx.ui.notify(issue.message, "warning");
	});
	return (nextIssue) => {
		if (nextIssue?.reason !== issue?.reason || nextIssue?.message !== issue?.message) warnedSessionScopeKeys.clear();
		issue = nextIssue;
	};
}
