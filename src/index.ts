import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverModels, type CursorModelFallbackIssue } from "./model-discovery.js";
import { registerCursorRuntimeControls } from "./cursor-state.js";
import { registerCursorNativeToolDisplay } from "./cursor-native-tool-display-registration.js";
import { registerCursorPiToolBridge } from "./cursor-pi-tool-bridge.js";
import { registerCursorQuestionTool } from "./cursor-question-tool.js";
import { registerCursorSkillTool } from "./cursor-skill-tool.js";
import { registerCursorProviderBinding } from "./cursor-provider-binding.js";
import { getCursorSessionScopeSnapshot, registerCursorSessionScope } from "./cursor-session-scope.js";
import { registerCursorSessionAgentLifecycle } from "./cursor-session-agent-lifecycle.js";
import { registerCursorSessionAgentLineage } from "./cursor-session-agent-lineage.js";
import { registerCursorSessionAgentResume } from "./cursor-session-agent-resume.js";
import { resolveCursorApiKey, resolveCursorRuntimeApiKey } from "./cursor-api-key.js";
import { clearModelListCache } from "./model-list-cache.js";
import { hasCursorAuthChanged, resolveCursorKeyFingerprint } from "./cursor-model-auth-resync.js";
import { registerCursorFallbackIssueWarning } from "./cursor-fallback-warning.js";
import { registerCursorAgentsContextDedup } from "./cursor-agents-context-registration.js";
import { registerCursorOverflowNormalization } from "./cursor-provider-overflow.js";
import { registerCursorSdkSessionProcessErrorGuard } from "./cursor-sdk-process-error-guard.js";
import { prepareCursorSessionForCompaction } from "./cursor-session-compaction-prep.js";

type CursorExtensionApi =
	& Pick<ExtensionAPI, "registerProvider" | "registerCommand" | "on">
	& Parameters<typeof registerCursorSessionScope>[0]
	& Parameters<typeof registerCursorSessionAgentLifecycle>[0]
	& Parameters<typeof registerCursorSessionAgentLineage>[0]
	& Parameters<typeof registerCursorSessionAgentResume>[0]
	& Parameters<typeof registerCursorRuntimeControls>[0]
	& Parameters<typeof registerCursorNativeToolDisplay>[0]
	& Parameters<typeof registerCursorQuestionTool>[0]
	& Parameters<typeof registerCursorSkillTool>[0]
	& Parameters<typeof registerCursorPiToolBridge>[0]
	& Parameters<typeof registerCursorFallbackIssueWarning>[0]
	& Parameters<typeof registerCursorAgentsContextDedup>[0]
	& Parameters<typeof registerCursorOverflowNormalization>[0]
	& Parameters<typeof registerCursorSdkSessionProcessErrorGuard>[0];

export default async function (pi: CursorExtensionApi) {
	// Session cwd must register before other session_start listeners that depend on it.
	registerCursorSessionScope(pi);
	const registerCursorProvider = registerCursorProviderBinding(pi);
	registerCursorSessionAgentLineage(pi);
	registerCursorSessionAgentLifecycle(pi);
	registerCursorSessionAgentResume(pi);
	pi.on("session_before_compact", async () => {
		await prepareCursorSessionForCompaction(getCursorSessionScopeSnapshot(pi).scopeKey);
	});
	registerCursorRuntimeControls(pi);
	registerCursorNativeToolDisplay(pi);
	registerCursorQuestionTool(pi);
	registerCursorSkillTool(pi);
	registerCursorPiToolBridge(pi);
	registerCursorAgentsContextDedup(pi);
	registerCursorOverflowNormalization(pi);
	let fallbackIssue: CursorModelFallbackIssue | undefined;
	const models = await discoverModels({
		onFallback: (issue) => {
			fallbackIssue = issue;
		},
	});

	if (fallbackIssue) {
		registerCursorFallbackIssueWarning(pi, fallbackIssue);
	}

	// Pi core has no logout/auth-change event, so a /logout (or key rotation)
	// leaves the models captured above stale for the rest of the process.
	// Re-resolve live auth on every session start and rebuild the provider when
	// it moved. Logout collapses to the same fallback catalog a fresh logged-out
	// boot would register, and the orphaned on-disk catalog is deleted.
	let lastKeyFingerprint = await resolveCursorKeyFingerprint();
	pi.on("session_start", async () => {
		const currentFingerprint = await resolveCursorKeyFingerprint();
		if (!hasCursorAuthChanged(lastKeyFingerprint, currentFingerprint)) return;
		lastKeyFingerprint = currentFingerprint;
		// Any move invalidates the previous catalog: logout orphans it and a
		// rotated key can never match it, so delete before rediscovering.
		clearModelListCache();
		let resyncFallbackIssue: CursorModelFallbackIssue | undefined;
		const resyncedModels = await discoverModels({
			onFallback: (issue) => {
				resyncFallbackIssue = issue;
			},
		});
		registerCursorProvider(resyncedModels);
		if (resyncFallbackIssue) {
			registerCursorFallbackIssueWarning(pi, resyncFallbackIssue);
		}
	});

	pi.registerCommand("cursor-refresh-models", {
		description: "Refresh the live Cursor model catalog without restarting pi",
		handler: async (_args, ctx) => {
			let refreshFallbackIssue: CursorModelFallbackIssue | undefined;
			const apiKey = resolveCursorApiKey(await ctx.modelRegistry.getApiKeyForProvider("cursor"))
				?? await resolveCursorRuntimeApiKey();
			// A refresh with no auth anywhere is the explicit post-logout state:
			// drop the orphaned catalog before falling back so it cannot linger.
			if (!apiKey) clearModelListCache();
			const refreshedModels = await discoverModels({
				apiKey,
				forceRefresh: true,
				onFallback: (issue) => {
					refreshFallbackIssue = issue;
				},
			});
			registerCursorProvider(refreshedModels);
			lastKeyFingerprint = await resolveCursorKeyFingerprint();
			if (!ctx.hasUI) return;
			if (refreshFallbackIssue) {
				ctx.ui.notify(`Cursor model catalog refresh did not use a live catalog: ${refreshFallbackIssue.message}`, "warning");
			} else {
				ctx.ui.notify(`Cursor model catalog refreshed with ${refreshedModels.length} model${refreshedModels.length === 1 ? "" : "s"}.`, "info");
			}
		},
	});

	registerCursorProvider(models);
	// Register last so session_shutdown cleanup remains protected until other Cursor handlers finish.
	registerCursorSdkSessionProcessErrorGuard(pi);
}
