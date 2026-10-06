import type { AgentOptions } from "@cursor/sdk";
import type { CursorCustomSubagentsConfig } from "./cursor-config.js";
import { buildCursorModelSelection, getCursorModelMetadata } from "./model-discovery.js";

export function buildCursorCustomSubagentDefinitions(config: CursorCustomSubagentsConfig | undefined): AgentOptions["agents"] {
	if (!config || !Object.keys(config).length) return undefined;
	return Object.fromEntries(Object.entries(config).map(([name, entry]) => [name, {
		description: entry.description,
		prompt: entry.prompt,
		...(entry.model === undefined ? {} : {
			model: entry.model === "inherit" ? "inherit" : buildCursorModelSelection(
				entry.model,
				entry.thinking ?? "off",
				getCursorModelMetadata(entry.model)?.fastOverride ?? entry.fast,
			),
		}),
	}]));
}

// ponytail: SDK 1.0.36 LOCAL conversion keeps only model ID/inherit; it drops params.
// Upgrade this claim only after the installed public converter preserves them.
