import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isCursorModel } from "./cursor-model.js";
import { registerCursorModelLifecycle, type CursorModelLifecycleExtensionApi } from "./cursor-model-lifecycle.js";
import { getCursorSessionScopeKey } from "./cursor-session-scope.js";
import type { CursorModelFallbackIssue } from "./model-discovery.js";

export type CursorFallbackWarningExtensionApi = CursorModelLifecycleExtensionApi;

export function registerCursorFallbackIssueWarning(
	pi: CursorFallbackWarningExtensionApi,
	issueOrGetter: CursorModelFallbackIssue | (() => CursorModelFallbackIssue | undefined),
): void {
	const getIssue =
		typeof issueOrGetter === "function"
			? issueOrGetter
			: () => issueOrGetter;
	const warnedSessionScopeKeys = new Set<string>();

	registerCursorModelLifecycle(pi, (ctx: ExtensionContext) => {
		const issue = getIssue();
		if (!issue || !isCursorModel(ctx.model) || !ctx.hasUI) return;
		const scopeKey = getCursorSessionScopeKey();
		if (warnedSessionScopeKeys.has(scopeKey)) return;
		warnedSessionScopeKeys.add(scopeKey);
		ctx.ui.notify(issue.message, "warning");
	});
}
