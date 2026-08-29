import type { AgentModeOption } from "@cursor/sdk";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	buildCursorToolManifestText,
	CURSOR_TOOL_MANIFEST_ENV,
	resolveCursorToolManifestEnabled,
} from "./cursor-tool-manifest.js";
import { runCursorSessionAgentCleanupCommand } from "./cursor-session-agent-cleanup.js";
import {
	CURSOR_HTTP1_ENTRY_TYPE,
	getStoredCursorHttp1Enabled,
	isCursorHttp1EntryData,
	setCursorHttp1GlobalPreferenceAuthoritative,
	setStoredCursorHttp1Enabled,
	type CursorHttp1EntryData,
} from "./cursor-http1.js";
import {
	CURSOR_ATTRIBUTION_ENTRY_TYPE,
	getStoredCursorAttributionEnabled,
	isCursorAttributionEntryData,
	setCursorAttributionGlobalPreferenceAuthoritative,
	setStoredCursorAttributionEnabled,
	type CursorAttributionEntryData,
} from "./cursor-attribution.js";
import {
	buildCursorPiToolBridgeSnapshot,
	CURSOR_PI_TOOL_BRIDGE_ENV,
	resolveCursorPiToolBridgeEnabled,
} from "./cursor-pi-tool-bridge-snapshot.js";
import {
	CURSOR_SETTING_SOURCES_ENV,
	DEFAULT_CURSOR_SETTING_SOURCES,
	resolveCursorSettingSources,
} from "./cursor-setting-sources.js";
import { isCursorModel } from "./cursor-model.js";
import { registerCursorModelLifecycle } from "./cursor-model-lifecycle.js";
import { asRecord } from "./cursor-record-utils.js";
import { getCursorSessionScopeKey } from "./cursor-session-scope.js";
import { refreshSessionCursorAgentConfig } from "./cursor-session-agent.js";
import { getCursorModelMetadata } from "./model-discovery.js";
import {
	cursorFastDefaultsFromConfig,
	getCursorSdkUserConfigPath,
	loadCursorSdkUserConfig,
	mergeCursorSdkConfigForUpdate,
	resolveCursorFastDefault,
	updateCursorSdkConfig,
} from "./cursor-config.js";
import {
	consumeCursorLocalForceOverride,
	CURSOR_RUNTIME_ENTRY_TYPE,
	formatCursorStatus,
	getCursorCliConfig,
	getCursorSessionConfig,
	registerCursorCloudRuntimeControls,
	resetCursorRuntimeStateForTests,
	resolveCursorStatusRuntime,
	restoreCursorCliState,
	restoreSessionCursorRuntimeState,
	type CursorRuntimeStateExtensionApi,
} from "./cursor-runtime-state.js";

export {
	consumeCursorLocalForceOverride,
	getCursorCliConfig,
	getCursorSessionConfig,
} from "./cursor-runtime-state.js";

const FAST_ENTRY_TYPE = "cursor-fast-state";
const MODE_ENTRY_TYPE = "cursor-mode-state";

export type CursorAgentMode = AgentModeOption;

const DEFAULT_CURSOR_AGENT_MODE: AgentModeOption = "agent";

interface CursorFastEntryData {
	modelId?: string;
	baseModelId?: string;
	fast: boolean;
}

interface CursorModeEntryData {
	mode: AgentModeOption;
}

type CursorRuntimeControlsExtensionApi = Pick<
	ExtensionAPI,
	"appendEntry" | "getFlag" | "registerFlag" | "registerCommand" | "on" | "getActiveTools" | "getAllTools"
> & CursorRuntimeStateExtensionApi;

type CursorCliModeState =
	| { kind: "unset" }
	| { kind: "valid"; mode: AgentModeOption }
	| { kind: "invalid"; raw: string; message: string };

const sessionFastPreferences = new Map<string, boolean>();
const authoritativeGlobalFastPreferenceIds = new Set<string>();
let globalFastPreferences = new Map<string, boolean>();
let cliForceFast = false;
let cliForceNoFast = false;
let sessionCursorAgentMode: AgentModeOption | undefined;
let cliCursorModeState: CursorCliModeState = { kind: "unset" };
const invalidCursorModeNotifiedSessionScopeKeys = new Set<string>();

export function isCursorAgentMode(value: unknown): value is AgentModeOption {
	return value === "agent" || value === "plan";
}

export function parseCursorAgentMode(raw: unknown): AgentModeOption | undefined {
	if (typeof raw !== "string") return undefined;
	const mode = raw.trim();
	return isCursorAgentMode(mode) ? mode : undefined;
}

function isCursorFastEntryData(value: unknown): value is CursorFastEntryData {
	const record = asRecord(value);
	if (!record) return false;
	return (typeof record.modelId === "string" || typeof record.baseModelId === "string") && typeof record.fast === "boolean";
}

function getCursorFastEntryModelId(data: CursorFastEntryData): string {
	return data.modelId ?? data.baseModelId ?? "";
}

function isCursorModeEntryData(value: unknown): value is CursorModeEntryData {
	return isCursorAgentMode(asRecord(value)?.mode);
}

function getConfigPath(): string {
	return getCursorSdkUserConfigPath();
}

function loadGlobalFastPreferences(): Map<string, boolean> {
	return cursorFastDefaultsFromConfig(loadCursorSdkUserConfig());
}

function saveGlobalFastPreference(modelId: string, fast: boolean): void {
	updateCursorSdkConfig(
		getConfigPath(),
		(current) => {
			const fastDefaults = { ...asRecord(current.fastDefaults), [modelId]: fast };
			return {
				...current,
				fastDefaults: Object.fromEntries(
					Object.entries(fastDefaults).sort(([a], [b]) => a.localeCompare(b)),
				),
			};
		},
		{ newFileMode: 0o600 },
	);
}

function saveGlobalCursorHttp1Enabled(enabled: boolean): void {
	updateCursorSdkConfig(
		getConfigPath(),
		(current) => mergeCursorSdkConfigForUpdate(current, {
			local: { useHttp1ForAgent: enabled },
		}),
		{ newFileMode: 0o600 },
	);
}

function saveGlobalCursorAttributionEnabled(enabled: boolean): void {
	updateCursorSdkConfig(
		getConfigPath(),
		(current) => mergeCursorSdkConfigForUpdate(current, {
			local: { attributeCommitsToAgent: enabled },
		}),
		{ newFileMode: 0o600 },
	);
}

function restoreSessionFastPreferences(branch: readonly SessionEntry[]): void {
	sessionFastPreferences.clear();
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== FAST_ENTRY_TYPE) continue;
		if (isCursorFastEntryData(entry.data)) {
			const modelId = getCursorFastEntryModelId(entry.data);
			if (modelId) sessionFastPreferences.set(modelId, entry.data.fast);
		}
	}
}

function restoreSessionCursorMode(branch: readonly SessionEntry[]): void {
	sessionCursorAgentMode = undefined;
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== MODE_ENTRY_TYPE) continue;
		if (isCursorModeEntryData(entry.data)) {
			sessionCursorAgentMode = entry.data.mode;
		}
	}
}

function restoreSessionCursorPreferences(ctx: { sessionManager: Pick<ExtensionContext["sessionManager"], "getBranch"> }): void {
	const branch = ctx.sessionManager.getBranch();
	restoreSessionCursorRuntimeState(branch);
	restoreSessionFastPreferences(branch);
	restoreSessionCursorMode(branch);
	restoreSessionCursorHttp1(branch);
	restoreSessionCursorAttribution(branch);
}

function restoreSessionCursorAttribution(branch: readonly SessionEntry[]): void {
	setStoredCursorAttributionEnabled(undefined);
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== CURSOR_ATTRIBUTION_ENTRY_TYPE) continue;
		if (isCursorAttributionEntryData(entry.data)) {
			setStoredCursorAttributionEnabled(entry.data.enabled);
		}
	}
}

function restoreSessionCursorHttp1(branch: readonly SessionEntry[]): void {
	setStoredCursorHttp1Enabled(undefined);
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== CURSOR_HTTP1_ENTRY_TYPE) continue;
		if (isCursorHttp1EntryData(entry.data)) {
			setStoredCursorHttp1Enabled(entry.data.enabled);
		}
	}
}

function getFastPreferenceModelId(metadata: NonNullable<ReturnType<typeof getCursorModelMetadata>>): string {
	return metadata.selectionModelId || metadata.baseModelId;
}

function getVirtualFastBaseModelId(modelId: string): string {
	return modelId.replace(/:(?:fast|slow)$/, "");
}

function getMapFastPreference(
	map: Map<string, boolean>,
	metadata: NonNullable<ReturnType<typeof getCursorModelMetadata>>,
): boolean | undefined {
	const preferenceModelId = getFastPreferenceModelId(metadata);
	return map.get(preferenceModelId) ?? (preferenceModelId !== metadata.baseModelId ? map.get(metadata.baseModelId) : undefined);
}

function getEffectiveFast(modelId: string): boolean | undefined {
	const metadata = getCursorModelMetadata(modelId);
	if (!metadata?.supportsFast) return undefined;
	return resolveCursorFastDefault({
		cliForceNoFast,
		cliForceFast,
		aliasOverride: metadata.fastOverride,
		sessionValue: authoritativeGlobalFastPreferenceIds.has(getFastPreferenceModelId(metadata))
			? undefined
			: getMapFastPreference(sessionFastPreferences, metadata),
		userValue: getMapFastPreference(globalFastPreferences, metadata),
		modelDefault: metadata.defaultFast,
	}).value;
}

function formatInvalidCursorMode(raw: string): string {
	return `Invalid --cursor-mode "${raw}". Use "agent" or "plan".`;
}

export type CursorAgentModeResolution =
	| { kind: "valid"; mode: AgentModeOption }
	| { kind: "invalid"; raw: string; message: string };

export function getStoredCursorAgentMode(): AgentModeOption {
	return sessionCursorAgentMode ?? DEFAULT_CURSOR_AGENT_MODE;
}

export function resolveCursorAgentMode(): CursorAgentModeResolution {
	switch (cliCursorModeState.kind) {
		case "valid":
			return { kind: "valid", mode: cliCursorModeState.mode };
		case "invalid":
			return { kind: "invalid", raw: cliCursorModeState.raw, message: cliCursorModeState.message };
		case "unset":
			return { kind: "valid", mode: getStoredCursorAgentMode() };
	}
}

export function getCursorProviderAgentModeOrThrow(): AgentModeOption {
	const resolution = resolveCursorAgentMode();
	if (resolution.kind === "invalid") throw new Error(resolution.message);
	return resolution.mode;
}

type CursorStatusContext = Pick<ExtensionContext, "cwd"> & Partial<Pick<ExtensionContext, "isProjectTrusted">>;

function updateCursorStatus(ctx: CursorStatusContext & Pick<ExtensionContext, "model" | "ui">, model = ctx.model): void {
	if (!model || !isCursorModel(model)) {
		ctx.ui.setStatus("cursor", undefined);
		return;
	}
	const metadata = getCursorModelMetadata(model.id);
	const resolution = resolveCursorStatusRuntime(ctx);
	const modeResolution = resolveCursorAgentMode();
	const mode = modeResolution.kind === "invalid" ? "invalid" : modeResolution.mode;
	if (resolution.kind === "invalid") {
		ctx.ui.setStatus("cursor", formatCursorStatus("invalid", undefined, mode));
		return;
	}
	const runtime = resolution.runtime.value;
	const fast = runtime === "cloud" ? undefined : metadata?.supportsFast ? getEffectiveFast(model.id) : undefined;
	ctx.ui.setStatus(
		"cursor",
		formatCursorStatus(runtime, fast, mode, resolution.useHttp1ForAgent.value, resolution.attributeCommitsToAgent.value),
	);
}

function getCurrentCursorMetadata(ctx: Pick<ExtensionContext, "model">) {
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

function persistFastPreference(
	pi: Pick<ExtensionAPI, "appendEntry">,
	modelId: string,
	fast: boolean,
): unknown | undefined {
	const previousSession = sessionFastPreferences.get(modelId);
	const previousGlobal = globalFastPreferences.get(modelId);
	sessionFastPreferences.set(modelId, fast);
	globalFastPreferences.set(modelId, fast);
	try {
		saveGlobalFastPreference(modelId, fast);
	} catch (error) {
		restoreMapValue(sessionFastPreferences, modelId, previousSession);
		restoreMapValue(globalFastPreferences, modelId, previousGlobal);
		throw error;
	}
	try {
		pi.appendEntry<CursorFastEntryData>(FAST_ENTRY_TYPE, { modelId, fast });
		authoritativeGlobalFastPreferenceIds.delete(modelId);
		return undefined;
	} catch (error) {
		authoritativeGlobalFastPreferenceIds.add(modelId);
		return error;
	}
}

function persistCursorModePreference(pi: Pick<ExtensionAPI, "appendEntry">, mode: AgentModeOption): void {
	const previousMode = sessionCursorAgentMode;
	sessionCursorAgentMode = mode;
	try {
		pi.appendEntry<CursorModeEntryData>(MODE_ENTRY_TYPE, { mode });
	} catch (error) {
		sessionCursorAgentMode = previousMode;
		throw error;
	}
}

function persistCursorHttp1Preference(
	pi: Pick<ExtensionAPI, "appendEntry">,
	enabled: boolean,
): unknown | undefined {
	const previousSession = getStoredCursorHttp1Enabled();
	setStoredCursorHttp1Enabled(enabled);
	try {
		saveGlobalCursorHttp1Enabled(enabled);
	} catch (error) {
		setStoredCursorHttp1Enabled(previousSession);
		throw error;
	}
	try {
		pi.appendEntry<CursorHttp1EntryData>(CURSOR_HTTP1_ENTRY_TYPE, { enabled });
		setCursorHttp1GlobalPreferenceAuthoritative(false);
		return undefined;
	} catch (error) {
		setCursorHttp1GlobalPreferenceAuthoritative(true);
		return error;
	}
}

function persistCursorAttributionPreference(
	pi: Pick<ExtensionAPI, "appendEntry">,
	enabled: boolean,
): unknown | undefined {
	const previousSession = getStoredCursorAttributionEnabled();
	setStoredCursorAttributionEnabled(enabled);
	try {
		saveGlobalCursorAttributionEnabled(enabled);
	} catch (error) {
		setStoredCursorAttributionEnabled(previousSession);
		throw error;
	}
	try {
		pi.appendEntry<CursorAttributionEntryData>(CURSOR_ATTRIBUTION_ENTRY_TYPE, { enabled });
		setCursorAttributionGlobalPreferenceAuthoritative(false);
		return undefined;
	} catch (error) {
		setCursorAttributionGlobalPreferenceAuthoritative(true);
		return error;
	}
}

function restoreCliCursorMode(raw: boolean | string | undefined): void {
	cliCursorModeState = { kind: "unset" };
	if (raw === undefined || raw === "" || raw === false) return;
	const parsed = parseCursorAgentMode(raw);
	if (parsed) {
		cliCursorModeState = { kind: "valid", mode: parsed };
		return;
	}
	const rawText = String(raw);
	const message = formatInvalidCursorMode(rawText);
	cliCursorModeState = { kind: "invalid", raw: rawText, message };
}

function notifyInvalidCursorModeIfCursorActive(ctx: Pick<ExtensionContext, "hasUI" | "mode" | "ui">): void {
	const modeResolution = resolveCursorAgentMode();
	if (modeResolution.kind !== "invalid" || !ctx.hasUI || ctx.mode !== "tui") return;
	const scopeKey = getCursorSessionScopeKey();
	if (invalidCursorModeNotifiedSessionScopeKeys.has(scopeKey)) return;
	invalidCursorModeNotifiedSessionScopeKeys.add(scopeKey);
	ctx.ui.notify(modeResolution.message, "error");
}

function formatEffectiveCursorSettingSourcesLabel(raw: string | undefined = process.env[CURSOR_SETTING_SOURCES_ENV]): string {
	const effective = resolveCursorSettingSources(raw);
	const effectiveLabel = effective === undefined ? "none" : effective.join(",");
	const rawLabel = raw?.trim() ? raw.trim() : `(unset → ${DEFAULT_CURSOR_SETTING_SOURCES.join(",")})`;
	return `${rawLabel} (effective: ${effectiveLabel})`;
}

export function formatCursorToolsDebugReport(
	pi: Pick<ExtensionAPI, "getActiveTools" | "getAllTools">,
	env: Record<string, string | undefined> = process.env,
): string {
	const bridgeEnabled = resolveCursorPiToolBridgeEnabled(env);
	const manifestEnabled = resolveCursorToolManifestEnabled(env);
	const lines = [
		"Cursor tool surfaces (current session):",
		`${CURSOR_PI_TOOL_BRIDGE_ENV}: ${bridgeEnabled ? "enabled" : "disabled"}`,
		`${CURSOR_TOOL_MANIFEST_ENV}: ${manifestEnabled ? "enabled" : "disabled"}`,
		`${CURSOR_SETTING_SOURCES_ENV}: ${formatEffectiveCursorSettingSourcesLabel(env[CURSOR_SETTING_SOURCES_ENV])}`,
	];

	let bridgeSnapshot;
	if (bridgeEnabled) {
		try {
			bridgeSnapshot = buildCursorPiToolBridgeSnapshot(pi);
		} catch {
			lines.push("Pi bridge snapshot: unavailable (extension tool APIs required).");
		}
	}

	lines.push(buildCursorToolManifestText({ bridgeSnapshot, piBridgeEnabled: bridgeEnabled }));
	return lines.join("\n");
}

function emitCursorToolsDebugReport(
	pi: Pick<ExtensionAPI, "getActiveTools" | "getAllTools">,
	ctx: Pick<ExtensionContext, "hasUI" | "ui">,
): void {
	const report = formatCursorToolsDebugReport(pi);
	if (ctx.hasUI) {
		ctx.ui.notify(report, "info");
		return;
	}
	console.log(report);
}

export function getEffectiveFastForModelId(modelId: string): boolean | undefined {
	return getEffectiveFast(modelId);
}

export function registerCursorRuntimeControls(pi: CursorRuntimeControlsExtensionApi): void {
	registerCursorCloudRuntimeControls(pi, { refreshStatus: updateCursorStatus });

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

	pi.registerFlag("cursor-mode", {
		description: "Set Cursor SDK conversation mode for this run: agent or plan",
		type: "string",
		default: "",
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
			if (metadata.fastOverride !== undefined) {
				const state = metadata.fastOverride ? "enabled" : "disabled";
				ctx.ui.notify(
					`Cursor fast is fixed ${state} by selected model ${metadata.piModelId}; choose ${getVirtualFastBaseModelId(metadata.piModelId)} to use /cursor-fast preferences`,
					"info",
				);
				return;
			}

			const preferenceModelId = getFastPreferenceModelId(metadata);
			const current = getEffectiveFast(metadata.piModelId) ?? false;
			const next = !current;
			let appendError: unknown;
			try {
				appendError = persistFastPreference(pi, preferenceModelId, next);
			} catch (error) {
				updateCursorStatus(ctx);
				ctx.ui.notify(`Failed to save Cursor fast preference: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
			updateCursorStatus(ctx);
			if (appendError !== undefined) {
				ctx.ui.notify(
					`Cursor fast ${next ? "enabled" : "disabled"} was saved globally, but persisting the session entry failed: ${appendError instanceof Error ? appendError.message : String(appendError)}`,
					"error",
				);
				return;
			}
			ctx.ui.notify(`Cursor fast ${next ? "enabled" : "disabled"}`, "info");
		},
	});

	pi.registerCommand("cursor-tools", {
		description: "Show live Cursor tool surfaces for this session (maintainer debug)",
		handler: async (_args, ctx) => {
			emitCursorToolsDebugReport(pi, ctx);
		},
	});

	pi.registerCommand("cursor-http", {
		description: "Toggle Cursor SDK HTTP/1.1/SSE transport compatibility mode",
		handler: async (args, ctx) => {
			const usage = "Usage: /cursor-http [on|off|toggle]";
			const normalized = args.trim().toLowerCase();
			const resolution = resolveCursorStatusRuntime(ctx);
			if (resolution.kind === "invalid") {
				ctx.ui.notify(resolution.message, "error");
				return;
			}
			const setting = resolution.useHttp1ForAgent;
			if (!normalized) {
				ctx.ui.notify(
					`Cursor HTTP/1.1/SSE transport is ${setting.value ? "enabled" : "disabled"} (source: ${setting.source}). ${usage}`,
					"info",
				);
				return;
			}
			const next = normalized === "on"
				? true
				: normalized === "off"
					? false
					: normalized === "toggle"
						? !setting.value
						: undefined;
			if (next === undefined) {
				ctx.ui.notify(
					`Invalid Cursor HTTP transport mode "${args.trim()}". ${usage}`,
					"error",
				);
				return;
			}
			let appendError: unknown;
			try {
				appendError = persistCursorHttp1Preference(pi, next);
			} catch (error) {
				updateCursorStatus(ctx);
				ctx.ui.notify(
					`Failed to save Cursor HTTP/1.1 preference: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				return;
			}
			updateCursorStatus(ctx);
			if (appendError !== undefined) {
				ctx.ui.notify(
					`Cursor HTTP/1.1 preference was saved globally, but persisting the session entry failed: ${appendError instanceof Error ? appendError.message : String(appendError)}`,
					"error",
				);
				return;
			}
			ctx.ui.notify(
				`Cursor HTTP/1.1/SSE transport ${next ? "enabled" : "disabled"}`,
				"info",
			);
		},
	});

	pi.registerCommand("cursor-attribution", {
		description: "Toggle Cursor commit/PR attribution (Co-authored-by: Cursor trailers)",
		handler: async (args, ctx) => {
			const usage = "Usage: /cursor-attribution [on|off|toggle]";
			const normalized = args.trim().toLowerCase();
			const resolution = resolveCursorStatusRuntime(ctx);
			if (resolution.kind === "invalid") {
				ctx.ui.notify(resolution.message, "error");
				return;
			}
			const setting = resolution.attributeCommitsToAgent;
			if (!normalized) {
				ctx.ui.notify(
					`Cursor attribution is ${setting.value ? "enabled" : "disabled"} (source: ${setting.source}). ${usage}`,
					"info",
				);
				return;
			}
			const next = normalized === "on"
				? true
				: normalized === "off"
					? false
					: normalized === "toggle"
						? !setting.value
						: undefined;
			if (next === undefined) {
				ctx.ui.notify(`Invalid Cursor attribution mode "${args.trim()}". ${usage}`, "error");
				return;
			}
			let appendError: unknown;
			try {
				appendError = persistCursorAttributionPreference(pi, next);
			} catch (error) {
				updateCursorStatus(ctx);
				ctx.ui.notify(
					`Failed to save Cursor attribution preference: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				return;
			}
			updateCursorStatus(ctx);
			if (appendError !== undefined) {
				ctx.ui.notify(
					`Cursor attribution preference was saved globally, but persisting the session entry failed: ${appendError instanceof Error ? appendError.message : String(appendError)}`,
					"error",
				);
				return;
			}
			ctx.ui.notify(
				next
					? "Cursor attribution enabled; Cursor may add Co-authored-by trailers again."
					: "Cursor attribution disabled; Cursor is instructed not to add Co-authored-by trailers.",
				"info",
			);
		},
	});

	pi.registerCommand("cursor-local-resume-cleanup", {
		description: "Dry-run or delete recorded superseded local Cursor SDK agents",
		handler: async (args, ctx) => {
			await runCursorSessionAgentCleanupCommand(pi, args, ctx);
		},
	});

	pi.registerCommand("cursor-refresh-config", {
		description: "Refresh filesystem Cursor config in the current pooled SDK agent",
		handler: async (_args, ctx) => {
			if (!isCursorModel(ctx.model)) {
				ctx.ui.notify("Cursor config refresh is available only for Cursor models.", "info");
				return;
			}
			try {
				const result = await refreshSessionCursorAgentConfig();
				const messages: Record<typeof result, string> = {
					reloaded: "Cursor SDK agent config refreshed.",
					"no-agent": "No Cursor SDK agent exists yet; config will load on the next Cursor run.",
					busy: "Cursor SDK agent is still finalizing a run; retry /cursor-refresh-config after it finishes.",
					unsupported: "Current Cursor SDK agent does not support config reload.",
				};
				ctx.ui.notify(messages[result], result === "reloaded" ? "info" : "warning");
			} catch (error) {
				ctx.ui.notify(`Failed to refresh Cursor config: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.registerCommand("cursor-mode", {
		description: "Set Cursor SDK conversation mode: agent or plan",
		handler: async (args, ctx) => {
			const usage = "Usage: /cursor-mode agent|plan";
			const mode = parseCursorAgentMode(args);
			if (!args.trim()) {
				const modeResolution = resolveCursorAgentMode();
				if (modeResolution.kind === "invalid") {
					ctx.ui.notify(`${modeResolution.message} ${usage}`, "error");
				} else {
					ctx.ui.notify(`Cursor mode is ${modeResolution.mode}. ${usage}`, "info");
				}
				return;
			}
			if (!mode) {
				ctx.ui.notify(`Invalid Cursor mode "${args.trim()}". ${usage}`, "error");
				return;
			}
			if (cliCursorModeState.kind === "valid") {
				ctx.ui.notify(`Cursor mode is forced to ${cliCursorModeState.mode} by --cursor-mode`, "info");
				return;
			}
			const clearedInvalidCliMode = cliCursorModeState.kind === "invalid";
			try {
				persistCursorModePreference(pi, mode);
				if (clearedInvalidCliMode) cliCursorModeState = { kind: "unset" };
			} catch (error) {
				updateCursorStatus(ctx);
				ctx.ui.notify(`Failed to save Cursor mode preference: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
			updateCursorStatus(ctx);
			ctx.ui.notify(
				clearedInvalidCliMode
					? `Cursor mode set to ${mode}; cleared invalid --cursor-mode override`
					: `Cursor mode set to ${mode}`,
				"info",
			);
		},
	});

	pi.on("session_tree", (_event, ctx) => {
		restoreSessionCursorPreferences(ctx);
		updateCursorStatus(ctx);
	});

	registerCursorModelLifecycle(pi, {
		sessionStart: (_event, ctx) => {
			authoritativeGlobalFastPreferenceIds.clear();
			setCursorHttp1GlobalPreferenceAuthoritative(false);
			setCursorAttributionGlobalPreferenceAuthoritative(false);
			globalFastPreferences = loadGlobalFastPreferences();
			cliForceFast = pi.getFlag("cursor-fast") === true;
			cliForceNoFast = pi.getFlag("cursor-no-fast") === true;
			restoreCursorCliState(pi);
			restoreSessionCursorPreferences(ctx);
			restoreCliCursorMode(pi.getFlag("cursor-mode"));
		},
		sync: (ctx) => {
			if (isCursorModel(ctx.model)) notifyInvalidCursorModeIfCursorActive(ctx);
			updateCursorStatus(ctx);
		},
	});
}

function resetCursorModeStateForTests(): void {
	sessionCursorAgentMode = undefined;
	setCursorHttp1GlobalPreferenceAuthoritative(false);
	setStoredCursorHttp1Enabled(undefined);
	setCursorAttributionGlobalPreferenceAuthoritative(false);
	setStoredCursorAttributionEnabled(undefined);
	cliCursorModeState = { kind: "unset" };
	resetCursorRuntimeStateForTests();
	invalidCursorModeNotifiedSessionScopeKeys.clear();
	authoritativeGlobalFastPreferenceIds.clear();
}

export const __testUtils = {
	FAST_ENTRY_TYPE,
	MODE_ENTRY_TYPE,
	CURSOR_HTTP1_ENTRY_TYPE,
	CURSOR_ATTRIBUTION_ENTRY_TYPE,
	RUNTIME_ENTRY_TYPE: CURSOR_RUNTIME_ENTRY_TYPE,
	DEFAULT_CURSOR_AGENT_MODE,
	getConfigPath,
	loadGlobalFastPreferences,
	sessionFastPreferences,
	getSessionCursorAgentMode: () => sessionCursorAgentMode,
	getCliCursorAgentMode: () => (cliCursorModeState.kind === "valid" ? cliCursorModeState.mode : undefined),
	getCliCursorModeState: () => cliCursorModeState,
	resetCursorModeStateForTests,
};
