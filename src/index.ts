import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverModels, replaceCursorModelMetadata, type CursorModelMetadata } from "./model-discovery.js";
import { registerCursorRuntimeControls } from "./cursor-state.js";
import { registerCursorNativeToolDisplay } from "./cursor-native-tool-display-registration.js";
import { registerCursorPiToolBridge } from "./cursor-pi-tool-bridge.js";
import { registerCursorQuestionTool } from "./cursor-question-tool.js";
import { registerCursorSkillTool } from "./cursor-skill-tool.js";
import { registerCursorProviderBinding, type CursorServedCatalogProvenance } from "./cursor-provider-binding.js";
import { getCursorSessionScopeSnapshot, registerCursorSessionScope } from "./cursor-session-scope.js";
import { registerCursorSessionAgentLifecycle } from "./cursor-session-agent-lifecycle.js";
import { registerCursorSessionAgentLineage } from "./cursor-session-agent-lineage.js";
import { registerCursorSessionAgentResume } from "./cursor-session-agent-resume.js";
import { normalizeCursorApiKey } from "./cursor-api-key.js";
import { registerCursorFallbackIssueWarning } from "./cursor-fallback-warning.js";
import { registerCursorAgentsContextDedup } from "./cursor-agents-context-registration.js";
import { registerCursorOverflowNormalization } from "./cursor-provider-overflow.js";
import { registerCursorSdkSessionProcessErrorGuard } from "./cursor-sdk-process-error-guard.js";
import { installCursorSdkProcessOutputFilter } from "./cursor-sdk-output-filter.js";
import { registerCursorShellEnv } from "./cursor-shell-env-registration.js";
import { cursorLiveRuns } from "./cursor-provider-live-run-drain.js";
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
	installCursorSdkProcessOutputFilter();
	registerCursorShellEnv(pi);
	// Session cwd must register before other session_start listeners that depend on it.
	registerCursorSessionScope(pi);
	registerCursorUsageLedger(pi);
	registerCursorUsageCommand(pi);
	pi.registerCommand("cursor-abort", {
		description: "Abort this session's pending local Cursor run without undoing completed work",
		handler: async (_args, ctx) => {
			const run = cursorLiveRuns.getActiveForScope(getCursorSessionScopeSnapshot(pi).scopeKey);
			if (run) {
				if (!ctx.isIdle() && ctx.model?.provider === "cursor") ctx.abort();
				await cursorLiveRuns.release(run);
			}
			const message = run
				? "Pending local Cursor run released. Retry under the current policy; already-executed work was not undone."
				: "No pending local Cursor run in this session.";
			if (ctx.hasUI) ctx.ui.notify(message, "info");
			else process.stderr.write(`${message}\n`);
		},
	});
	let catalog: CursorServedCatalogProvenance | undefined;
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
	let initialMetadata: readonly CursorModelMetadata[] | undefined;
	const models = await discoverModels({
		apiKey: normalizeCursorApiKey(process.env.CURSOR_API_KEY),
		allowNetwork: false,
		onCatalog: (provenance, metadata) => {
			catalog = provenance;
			initialMetadata = metadata;
		},
	});

	setFallbackWarning(catalog?.issue);

	pi.registerCommand("cursor-refresh-models", {
		description: "Refresh the live Cursor model catalog without restarting pi",
		handler: async (_args, ctx) => {
			const result = await ctx.modelRegistry.refresh({ providers: ["cursor"], allowNetwork: true, force: true, signal: ctx.signal });
			if (!ctx.hasUI) return;
			if (result.aborted) {
				ctx.ui.notify("Cursor model catalog refresh was cancelled.", "warning");
			} else if (result.errors.has("cursor")) {
				ctx.ui.notify("Cursor model catalog refresh failed; the previous catalog was retained.", "warning");
			} else if (catalog?.issue) {
				ctx.ui.notify(`Cursor model catalog refresh did not use a live catalog: ${catalog.issue.message}`, "warning");
			} else if (catalog?.source === "unknown") {
				// Retrying cannot help: the serving provider's extension copy predates catalog provenance.
				ctx.ui.notify("Cursor model catalog freshness is unknown because the host's Cursor extension does not report it. Update and reload pi-cursor-sdk in the host, then reload this session.", "warning");
			} else if (catalog?.source !== "live") {
				// Another refresh can supersede this one and leave the matching cache published.
				ctx.ui.notify("Cursor model catalog refresh did not confirm a live catalog. Run /cursor-refresh-models to retry.", "warning");
			} else {
				const count = ctx.modelRegistry.getAll().filter((model) => model.provider === "cursor").length;
				ctx.ui.notify(`Cursor model catalog refreshed with ${count} model${count === 1 ? "" : "s"}.`, "info");
			}
		},
	});

	registerCursorProvider(models, (provenance, metadata) => {
		catalog = provenance;
		setFallbackWarning(provenance.issue);
		if (metadata) replaceCursorModelMetadata(metadata);
	}, initialMetadata);
	// Register last so session_shutdown cleanup remains protected until other Cursor handlers finish.
	registerCursorSdkSessionProcessErrorGuard(pi);
}
