#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Cursor } from "@cursor/sdk";
import { defaultApiKeyFromEnv, parseArgv } from "./lib/cursor-cli-args.mjs";
import { scrubSensitiveText } from "../shared/cursor-sensitive-text.mjs";
import { createScriptFail } from "./lib/cursor-script-fail.mjs";
import { normalizeCursorContextWindowEntries } from "../shared/cursor-model-selection-identities.mjs";

const FALLBACK_MODELS_PATH = "src/cursor-fallback-models.generated.ts";
const CONTEXT_WINDOWS_PATH = "src/bundled-context-windows.ts";
const DEFAULT_CONTEXT_WINDOW = 200000;

function printHelp() {
	console.log(`Refresh reviewable Cursor model fallback snapshots.

Usage:
  npm run check:cursor-snapshots
  npm run refresh:cursor-snapshots -- --write [options]
  node scripts/refresh-cursor-model-snapshots.mjs [options]

Options:
  --check                       Fetch the live catalog and byte-compare
                                ${FALLBACK_MODELS_PATH} without writing.
  --write                       Write ${FALLBACK_MODELS_PATH}. Also write
                                ${CONTEXT_WINDOWS_PATH} when --context-windows is supplied.
                                Without --write, print a summary only.
  --api-key <key>               Cursor API key. Prefer CURSOR_API_KEY to avoid shell history.
  --context-windows <file>      Optional JSON file with {"contextWindows": {"model": 123}}
                                or a plain {"model": 123} map, usually copied from
                                ~/.pi/agent/cursor-sdk-context-windows.json after live runs.
  --fallback-context-window <n> Context window to use for newly seen models that lack
                                a catalog context parameter and no checkpoint override.
                                Default: ${DEFAULT_CONTEXT_WINDOW}.
  -h, --help                    Show this help.

Exit codes:
  0 success
  1 invalid arguments, missing auth, or Cursor SDK failure

Notes:
  - This script prints model IDs/counts only; it never prints API keys.
  - Cursor.models.list() is the source of truth for fallback catalog metadata.
  - Checkpoint-derived context windows are optional input because collecting them
    requires successful local SDK runs; this script does not start agents.
  - Context-window keys are recorded model IDs. Refresh normalization drops IDs
    absent from the current catalog. Redundant :fast/:slow aliases that send the
    default parameters collapse to one key.`);
}

const fail = createScriptFail("refresh-cursor-snapshots");

function parseRefreshArgs(argv) {
	if (argv.includes("-h") || argv.includes("--help")) {
		printHelp();
		process.exit(0);
	}
	const check = argv.includes("--check");
	const write = argv.includes("--write");
	if (check && write) fail("--check and --write cannot be used together");
	const filteredArgv = argv.filter((arg) => arg !== "--check" && arg !== "--write");
	const args = parseArgv(filteredArgv, {
		defaults: {
			check,
			write,
			apiKey: defaultApiKeyFromEnv(),
			contextWindowsPath: undefined,
			fallbackContextWindow: DEFAULT_CONTEXT_WINDOW,
		},
		flags: {
			apiKey: { names: ["--api-key"], assign: (value) => value.trim() },
			contextWindowsPath: { names: ["--context-windows"] },
			fallbackContextWindow: {
				names: ["--fallback-context-window"],
				assign: (value) => parsePositiveInteger(value, "--fallback-context-window"),
			},
		},
		fail,
	});
	if (!args.apiKey) fail("missing Cursor API key; set CURSOR_API_KEY or pass --api-key");
	return args;
}

function parsePositiveInteger(value, label) {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) fail(`${label} must be a positive integer`);
	return parsed;
}

function sanitizeModelItem(item) {
	return stripUndefined({
		id: item.id,
		displayName: item.displayName,
		description: item.description,
		aliases: Array.isArray(item.aliases) ? [...item.aliases] : undefined,
		parameters: Array.isArray(item.parameters)
			? item.parameters.map((parameter) =>
					stripUndefined({
						id: parameter.id,
						displayName: parameter.displayName,
						values: Array.isArray(parameter.values)
							? parameter.values.map((value) => stripUndefined({ value: value.value, displayName: value.displayName }))
							: [],
					}),
				)
			: undefined,
		variants: Array.isArray(item.variants)
			? item.variants.map((variant) =>
					stripUndefined({
						params: Array.isArray(variant.params) ? variant.params.map((param) => ({ id: param.id, value: param.value })) : [],
						displayName: variant.displayName,
						description: variant.description,
						isDefault: variant.isDefault,
					}),
				)
			: undefined,
	});
}

function stripUndefined(value) {
	return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function stableStringify(value) {
	return JSON.stringify(value, null, "\t").replace(/"([^"\\]+)":/g, "$1:");
}

function formatFallbackModels(models, sdkVersion) {
	return `import type { ModelListItem } from "@cursor/sdk";\n\n// Generated with @cursor/sdk@${sdkVersion} from ${models.length} Cursor models.\n// Refresh with: npm run refresh:cursor-snapshots -- --write\n// Do not add secrets; this file stores public model metadata only.\nexport const FALLBACK_MODEL_ITEMS = ${stableStringify(models)} satisfies ModelListItem[];\n`;
}

function parseExistingContextWindows() {
	if (!existsSync(CONTEXT_WINDOWS_PATH)) return new Map();
	const source = readFileSync(CONTEXT_WINDOWS_PATH, "utf8");
	const entries = new Map();
	const entryPattern = /(?:"([^"]+)"|([A-Za-z_$][\w$]*)):\s*(\d+)/g;
	for (const match of source.matchAll(entryPattern)) {
		entries.set(match[1] ?? match[2], Number(match[3]));
	}
	return entries;
}

function parseContextWindowsFile(path) {
	if (!path) return new Map();
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		fail(`could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	const source = parsed.contextWindows && typeof parsed.contextWindows === "object" ? parsed.contextWindows : parsed;
	const windows = new Map();
	for (const [modelId, contextWindow] of Object.entries(source)) {
		if (Number.isInteger(contextWindow) && contextWindow > 0) windows.set(modelId, contextWindow);
	}
	return windows;
}

function hasContextParameter(model) {
	return (model.parameters ?? []).some((parameter) => parameter.id === "context");
}

function formatContextWindows(models, checkpointWindows, fallbackContextWindow) {
	const merged = normalizeCursorContextWindowEntries(models, parseExistingContextWindows(), "existing bundled context windows");
	for (const [modelId, contextWindow] of normalizeCursorContextWindowEntries(models, checkpointWindows, "checkpoint context windows")) {
		merged.set(modelId, contextWindow);
	}
	for (const model of models) {
		if (!hasContextParameter(model) && !merged.has(model.id)) merged.set(model.id, fallbackContextWindow);
	}
	if (!merged.has("default")) merged.set("default", fallbackContextWindow);

	const date = new Date().toISOString().slice(0, 10);
	const sorted = [...merged.entries()].sort(([a], [b]) => (a === "default" ? -1 : b === "default" ? 1 : a.localeCompare(b)));
	const lines = sorted.map(([modelId, contextWindow]) => `\t${JSON.stringify(modelId)}: ${contextWindow},`);
	return `// Generated from Cursor SDK checkpoint tokenDetails.maxTokens on ${date}.\n// Refresh with: npm run refresh:cursor-snapshots -- --write --context-windows ~/.pi/agent/cursor-sdk-context-windows.json\n// Keys are recorded model IDs. Current-catalog normalization drops IDs absent\n// from that catalog. Equivalent default :fast/:slow selections collapse to one\n// key; stale and ambiguous aliases are omitted. Values are observed or\n// conservative default/non-Max-mode limits and may override a catalog context\n// label when the completed SDK checkpoint reports a different effective limit.\nexport const BUNDLED_CONTEXT_WINDOWS = {\n${lines.join("\n")}\n} as const satisfies Record<string, number>;\n`;
}

const args = parseRefreshArgs(process.argv.slice(2));
const sdkVersion = JSON.parse(readFileSync(new URL("../node_modules/@cursor/sdk/package.json", import.meta.url), "utf8")).version;
let rawModels;
try {
	rawModels = await Cursor.models.list({ apiKey: args.apiKey });
} catch (error) {
	const rawMessage = error instanceof Error ? error.message : String(error);
	fail(`Cursor.models.list() failed: ${scrubSensitiveText(rawMessage, args.apiKey)}`);
}
if (!Array.isArray(rawModels) || rawModels.length === 0) fail("Cursor.models.list() returned no models");

const models = rawModels.map(sanitizeModelItem).sort((a, b) => a.id.localeCompare(b.id));
const checkpointWindows = parseContextWindowsFile(args.contextWindowsPath);
const fallbackSource = formatFallbackModels(models, sdkVersion);
let contextWindowSource;
try {
	contextWindowSource = args.contextWindowsPath ? formatContextWindows(models, checkpointWindows, args.fallbackContextWindow) : undefined;
} catch (error) {
	fail(error instanceof Error ? error.message : String(error));
}
const existingContextWindowCount = parseExistingContextWindows().size;

console.log(`Fetched ${models.length} Cursor models with @cursor/sdk@${sdkVersion}.`);
console.log(`Context windows: ${checkpointWindows.size} checkpoint input(s), ${existingContextWindowCount} existing bundled entr${existingContextWindowCount === 1 ? "y" : "ies"}.`);
console.log(`First models: ${models.slice(0, 8).map((model) => model.id).join(", ")}${models.length > 8 ? ", ..." : ""}`);

if (args.check) {
	if (!existsSync(FALLBACK_MODELS_PATH) || !readFileSync(FALLBACK_MODELS_PATH).equals(Buffer.from(fallbackSource))) {
		fail(`${FALLBACK_MODELS_PATH} is stale; refresh it with: npm run refresh:cursor-snapshots -- --write`);
	}
	console.log(`${FALLBACK_MODELS_PATH} is current (${models.length} models, @cursor/sdk@${sdkVersion}).`);
} else if (args.write) {
	writeFileSync(FALLBACK_MODELS_PATH, fallbackSource);
	console.log(`Wrote ${FALLBACK_MODELS_PATH}`);
	if (contextWindowSource) {
		writeFileSync(CONTEXT_WINDOWS_PATH, contextWindowSource);
		console.log(`Wrote ${CONTEXT_WINDOWS_PATH}`);
	} else {
		console.log(`Skipped ${CONTEXT_WINDOWS_PATH}; pass --context-windows to refresh checkpoint-derived context windows.`);
	}
} else {
	console.log("Dry run only. Re-run with --write to update snapshots.");
}
