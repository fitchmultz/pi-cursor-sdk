import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CursorModelFallbackIssue } from "./model-discovery.js";
import { createCursorModelAuthResync } from "./cursor-model-auth-resync.js";
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
import { resolveCursorApiKey } from "./cursor-api-key.js";
import { registerCursorFallbackIssueWarning } from "./cursor-fallback-warning.js";
import { registerCursorAgentsContextDedup } from "./cursor-agents-context-registration.js";
import { registerCursorOverflowNormalization } from "./cursor-provider-overflow.js";
import { registerCursorSdkSessionProcessErrorGuard } from "./cursor-sdk-process-error-guard.js";
import { prepareCursorSessionForCompaction } from "./cursor-session-compaction-prep.js";
import { registerCursorUsageLedger } from "./cursor-usage-ledger.js";
import { registerCursorUsageCommand } from "./cursor-usage-command.js";

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
	& Parameters<typeof registerCursorSdkSessionProcessErrorGuard>[0]
	& Parameters<typeof registerCursorUsageLedger>[0];

export default async function (pi: CursorExtensionApi) {
	// Session cwd must register before other session_start listeners that depend on it.
	registerCursorSessionScope(pi);
	registerCursorUsageLedger(pi);
	registerCursorUsageCommand(pi);
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
	let setFallbackIssue: (issue: CursorModelFallbackIssue | undefined) => void = () => {};
	const catalog = createCursorModelAuthResync((result) => {
		registerCursorProvider(result.models);
		fallbackIssue = result.issue;
		setFallbackIssue(result.issue);
	});
	// Resync precedes warning dispatch so login cannot emit a stale missing-key warning.
	pi.on("session_start", async () => {
		await catalog.refresh();
	});
	pi.on("session_shutdown", () => {
		catalog.close();
	});
	await catalog.refresh();
	setFallbackIssue = registerCursorFallbackIssueWarning(pi, fallbackIssue);

	pi.registerCommand("cursor-refresh-models", {
		description: "Refresh the live Cursor model catalog without restarting pi",
		handler: async (_args, ctx) => {
			const result = await catalog.refresh({
				force: true,
				resolveCommandKey: async () => resolveCursorApiKey(await ctx.modelRegistry.getApiKeyForProvider("cursor")),
			});
			if (!result || !ctx.hasUI) return;
			if (result.issue) {
				ctx.ui.notify(`Cursor model catalog refresh did not use a live catalog: ${result.issue.message}`, "warning");
			} else {
				ctx.ui.notify(`Cursor model catalog refreshed with ${result.models.length} model${result.models.length === 1 ? "" : "s"}.`, "info");
			}
		},
	});

	// Register last so session_shutdown cleanup remains protected until other Cursor handlers finish.
	registerCursorSdkSessionProcessErrorGuard(pi);
}
