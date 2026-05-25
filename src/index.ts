import type { ExtensionAPI, ExtensionContext, ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { discoverModels, type CursorModelFallbackIssue } from "./model-discovery.js";
import { registerCursorFastControls } from "./cursor-state.js";
import { registerCursorNativeToolDisplay } from "./cursor-native-tool-display.js";
import { registerCursorPiToolBridge } from "./cursor-pi-tool-bridge.js";
import { registerCursorQuestionTool } from "./cursor-question-tool.js";
import { registerCursorSessionCwd } from "./cursor-session-cwd.js";
import { registerCursorAgentsContextDedup } from "./cursor-agents-context.js";
import { registerCursorSessionAgent } from "./cursor-session-agent.js";
import { streamCursor } from "./cursor-provider.js";

type CursorExtensionApi =
	& Pick<ExtensionAPI, "registerProvider">
	& {
		registerCommand(name: string, options: {
			description?: string;
			handler: (args: string, ctx: Pick<ExtensionContext, "hasUI"> & { ui: Pick<ExtensionContext["ui"], "notify"> }) => Promise<void> | void;
		}): void;
	}
	& Parameters<typeof registerCursorSessionCwd>[0]
	& Parameters<typeof registerCursorSessionAgent>[0]
	& Parameters<typeof registerCursorFastControls>[0]
	& Parameters<typeof registerCursorNativeToolDisplay>[0]
	& Parameters<typeof registerCursorQuestionTool>[0]
	& Parameters<typeof registerCursorPiToolBridge>[0]
	& Parameters<typeof registerCursorAgentsContextDedup>[0];

function createCursorProviderConfig(models: ProviderModelConfig[]): ProviderConfig {
	return {
		name: "Cursor",
		baseUrl: "https://cursor.com",
		apiKey: "CURSOR_API_KEY",
		api: "cursor-sdk",
		models,
		streamSimple: streamCursor,
	};
}

function registerCursorProvider(pi: Pick<ExtensionAPI, "registerProvider">, models: ProviderModelConfig[]): void {
	pi.registerProvider("cursor", createCursorProviderConfig(models));
}

export default async function (pi: CursorExtensionApi) {
	// Session cwd must register before other session_start listeners that depend on it.
	registerCursorSessionCwd(pi);
	registerCursorSessionAgent(pi);
	registerCursorFastControls(pi);
	registerCursorNativeToolDisplay(pi);
	registerCursorQuestionTool(pi);
	registerCursorPiToolBridge(pi);
	registerCursorAgentsContextDedup(pi);
	let fallbackIssue: CursorModelFallbackIssue | undefined;
	const models = await discoverModels({
		onFallback: (issue) => {
			fallbackIssue = issue;
		},
	});

	if (fallbackIssue) {
		const issue = fallbackIssue;
		pi.on("session_start", async (_event, ctx) => {
			if (ctx.hasUI) ctx.ui.notify(issue.message, "warning");
		});
	}

	pi.registerCommand("cursor-refresh-models", {
		description: "Refresh the live Cursor model catalog without restarting pi",
		handler: async (_args, ctx) => {
			let refreshFallbackIssue: CursorModelFallbackIssue | undefined;
			const refreshedModels = await discoverModels({
				onFallback: (issue) => {
					refreshFallbackIssue = issue;
				},
			});
			registerCursorProvider(pi, refreshedModels);
			if (!ctx.hasUI) return;
			if (refreshFallbackIssue) {
				ctx.ui.notify(`Cursor model catalog refresh still using fallback models: ${refreshFallbackIssue.message}`, "warning");
			} else {
				ctx.ui.notify(`Cursor model catalog refreshed with ${refreshedModels.length} model${refreshedModels.length === 1 ? "" : "s"}.`, "info");
			}
		},
	});

	registerCursorProvider(pi, models);
}
