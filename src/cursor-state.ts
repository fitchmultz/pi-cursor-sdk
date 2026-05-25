import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isCursorModel } from "./cursor-model.js";
import { getCursorModelMetadata } from "./model-discovery.js";

const FAST_ENTRY_TYPE = "cursor-fast-state";
const GLOBAL_CONFIG_FILE = "cursor-sdk.json";

interface CursorFastEntryData {
	baseModelId: string;
	fast: boolean;
}

interface CursorGlobalConfig {
	fastDefaults?: Record<string, boolean>;
}

type CursorFastControlsModel =
	| Pick<NonNullable<ExtensionContext["model"]>, "id" | "provider" | "api">
	| undefined;

type CursorFastControlsContext = {
	model: CursorFastControlsModel;
	ui: Pick<ExtensionContext["ui"], "notify" | "setStatus">;
	sessionManager: Pick<ExtensionContext["sessionManager"], "getBranch">;
};

interface CursorFastControlsExtensionApi extends Pick<ExtensionAPI, "appendEntry" | "getFlag" | "registerFlag"> {
	registerCommand(name: string, options: {
		description?: string;
		handler: (args: string, ctx: CursorFastControlsContext) => Promise<void> | void;
	}): void;
	on(event: "session_start", handler: (event: SessionStartEvent, ctx: CursorFastControlsContext) => Promise<void> | void): void;
	on(event: "model_select", handler: (event: { model: ExtensionContext["model"] }, ctx: CursorFastControlsContext) => Promise<void> | void): void;
	on(event: "turn_start", handler: (event: unknown, ctx: CursorFastControlsContext) => Promise<void> | void): void;
}

const sessionFastPreferences = new Map<string, boolean>();
let globalFastPreferences = new Map<string, boolean>();
let cliForceFast = false;
let cliForceNoFast = false;

function isCursorFastEntryData(value: unknown): value is CursorFastEntryData {
	if (!value || typeof value !== "object") return false;
	const data = value as Record<string, unknown>;
	return typeof data.baseModelId === "string" && typeof data.fast === "boolean";
}

function getConfigPath(): string {
	return join(getAgentDir(), GLOBAL_CONFIG_FILE);
}

function loadGlobalFastPreferences(): Map<string, boolean> {
	const path = getConfigPath();
	if (!existsSync(path)) return new Map();
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as CursorGlobalConfig;
		return new Map(
			Object.entries(parsed.fastDefaults ?? {}).filter(
				(entry): entry is [string, boolean] => typeof entry[1] === "boolean",
			),
		);
	} catch {
		return new Map();
	}
}

function saveGlobalFastPreferences(): void {
	const path = getConfigPath();
	mkdirSync(dirname(path), { recursive: true });
	const config: CursorGlobalConfig = {
		fastDefaults: Object.fromEntries([...globalFastPreferences.entries()].sort(([a], [b]) => a.localeCompare(b))),
	};
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function restoreSessionFastPreferences(ctx: { sessionManager: Pick<ExtensionContext["sessionManager"], "getBranch"> }): void {
	sessionFastPreferences.clear();
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== FAST_ENTRY_TYPE) continue;
		if (isCursorFastEntryData(entry.data)) {
			sessionFastPreferences.set(entry.data.baseModelId, entry.data.fast);
		}
	}
}

function getEffectiveFast(baseModelId: string, modelId: string): boolean | undefined {
	const metadata = getCursorModelMetadata(modelId);
	if (!metadata?.supportsFast) return undefined;
	if (cliForceNoFast) return false;
	if (cliForceFast) return true;
	return sessionFastPreferences.get(baseModelId) ?? globalFastPreferences.get(baseModelId) ?? metadata.defaultFast;
}

function updateCursorStatus(ctx: { model: CursorFastControlsModel; ui: Pick<ExtensionContext["ui"], "setStatus"> }, model = ctx.model): void {
	if (!model || !isCursorModel(model)) {
		ctx.ui.setStatus("cursor", undefined);
		return;
	}
	const metadata = getCursorModelMetadata(model.id);
	if (!metadata?.supportsFast) {
		ctx.ui.setStatus("cursor", undefined);
		return;
	}
	const fast = getEffectiveFast(metadata.baseModelId, model.id);
	ctx.ui.setStatus("cursor", fast === true ? "cursor fast" : undefined);
}

function getCurrentCursorMetadata(ctx: { model: CursorFastControlsModel }) {
	const model = ctx.model;
	if (!model || !isCursorModel(model)) return undefined;
	return getCursorModelMetadata(model.id);
}

function restoreMapValue(map: Map<string, boolean>, key: string, previous: boolean | undefined): void {
	if (previous === undefined) {
		map.delete(key);
	} else {
		map.set(key, previous);
	}
}

function persistFastPreference(pi: Pick<ExtensionAPI, "appendEntry">, baseModelId: string, fast: boolean): void {
	const previousSession = sessionFastPreferences.get(baseModelId);
	const previousGlobal = globalFastPreferences.get(baseModelId);
	let savedGlobal = false;
	sessionFastPreferences.set(baseModelId, fast);
	globalFastPreferences.set(baseModelId, fast);
	try {
		saveGlobalFastPreferences();
		savedGlobal = true;
		pi.appendEntry<CursorFastEntryData>(FAST_ENTRY_TYPE, { baseModelId, fast });
	} catch (error) {
		restoreMapValue(sessionFastPreferences, baseModelId, previousSession);
		restoreMapValue(globalFastPreferences, baseModelId, previousGlobal);
		if (savedGlobal) {
			try {
				saveGlobalFastPreferences();
			} catch {
				// Preserve the original append failure reported to the user.
			}
		}
		throw error;
	}
}

export function getEffectiveFastForModelId(modelId: string): boolean | undefined {
	const metadata = getCursorModelMetadata(modelId);
	if (!metadata) return undefined;
	return getEffectiveFast(metadata.baseModelId, modelId);
}

export function registerCursorFastControls(pi: CursorFastControlsExtensionApi): void {
	pi.registerFlag("cursor-fast", {
		description: "Force Cursor fast mode for this run when the selected Cursor model supports it",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("cursor-no-fast", {
		description: "Force Cursor fast mode off for this run when the selected Cursor model supports it",
		type: "boolean",
		default: false,
	});

	pi.registerCommand("cursor-fast", {
		description: "Toggle Cursor fast mode for the selected Cursor model",
		handler: async (_args, ctx) => {
			const metadata = getCurrentCursorMetadata(ctx);
			if (!metadata?.supportsFast || !ctx.model) {
				const modelName = ctx.model?.id ?? "current model";
				ctx.ui.notify(`Fast mode not supported by ${modelName}`, "info");
				return;
			}
			if (cliForceNoFast) {
				ctx.ui.notify("Cursor fast is forced off by --cursor-no-fast", "info");
				return;
			}
			if (cliForceFast) {
				ctx.ui.notify("Cursor fast is forced by --cursor-fast", "info");
				return;
			}

			const current = getEffectiveFast(metadata.baseModelId, metadata.piModelId) ?? false;
			const next = !current;
			try {
				persistFastPreference(pi, metadata.baseModelId, next);
			} catch (error) {
				updateCursorStatus(ctx);
				ctx.ui.notify(`Failed to save Cursor fast preference: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
			updateCursorStatus(ctx);
			ctx.ui.notify(`Cursor fast ${next ? "enabled" : "disabled"}`, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		globalFastPreferences = loadGlobalFastPreferences();
		cliForceFast = pi.getFlag("cursor-fast") === true;
		cliForceNoFast = pi.getFlag("cursor-no-fast") === true;
		restoreSessionFastPreferences(ctx);
		updateCursorStatus(ctx);
	});

	pi.on("model_select", async (event, ctx) => {
		updateCursorStatus(ctx, event.model);
	});

	pi.on("turn_start", async (_event, ctx) => {
		updateCursorStatus(ctx);
	});
}

export const __testUtils = {
	FAST_ENTRY_TYPE,
	getConfigPath,
	loadGlobalFastPreferences,
	sessionFastPreferences,
};
