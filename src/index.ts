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
import { normalizeCursorApiKey } from "./cursor-api-key.js";
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
	let fallbackIssue: CursorModelFallbackIssue | undefined;
	const registerCursorProvider = registerCursorProviderBinding(pi);
	const setFallbackWarning = registerCursorFallbackIssueWarning(pi);
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
	const models = await discoverModels({
		apiKey: normalizeCursorApiKey(process.env.CURSOR_API_KEY),
		allowNetwork: false,
		onFallback: (issue) => {
			fallbackIssue = issue;
		},
	});

	setFallbackWarning(fallbackIssue);

	pi.registerCommand("cursor-refresh-models", {
		description: "Refresh the live Cursor model catalog without restarting pi",
		handler: async (_args, ctx) => {
			const result = await ctx.modelRegistry.refresh({ providers: ["cursor"], allowNetwork: true, force: true, signal: ctx.signal });
			if (!ctx.hasUI) return;
			if (result.aborted) {
				ctx.ui.notify("Cursor model catalog refresh was cancelled.", "warning");
			} else if (result.errors.has("cursor")) {
				ctx.ui.notify("Cursor model catalog refresh failed; the previous catalog was retained.", "warning");
			} else if (fallbackIssue) {
				ctx.ui.notify(`Cursor model catalog refresh did not use a live catalog: ${fallbackIssue.message}`, "warning");
			} else {
				const count = ctx.modelRegistry.getAll().filter((model) => model.provider === "cursor").length;
				ctx.ui.notify(`Cursor model catalog refreshed with ${count} model${count === 1 ? "" : "s"}.`, "info");
			}
		},
	});

	registerCursorProvider(models, (issue) => {
		fallbackIssue = issue;
		setFallbackWarning(issue);
	});
	// Register last so session_shutdown cleanup remains protected until other Cursor handlers finish.
	registerCursorSdkSessionProcessErrorGuard(pi);
}
