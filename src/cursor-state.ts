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
import {
	getCursorSessionScopeKey,
	resolveCursorSessionScopeFromContext,
} from "./cursor-session-scope.js";
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
const sessionFastPreferencesByScopeKey = new Map<string, Map<string, boolean>>();
const authoritativeGlobalFastPreferenceIdsByScopeKey = new Map<string, Set<string>>();
const sessionCursorAgentModesByScopeKey = new Map<string, AgentModeOption>();
interface CursorSessionCliState {
	forceFast: boolean;
	forceNoFast: boolean;
	mode: CursorCliModeState;
}

const defaultCliState: CursorSessionCliState = {
	forceFast: false,
	forceNoFast: false,
	mode: { kind: "unset" },
};
const cliStatesByScopeKey = new Map<string, CursorSessionCliState>();
let globalFastPreferences = new Map<string, boolean>();
const invalidCursorModeNotifiedSessionScopeKeys = new Set<string>();

function getCursorSessionCliState(scopeKey: string = getCursorSessionScopeKey()): CursorSessionCliState {
	return cliStatesByScopeKey.get(scopeKey) ?? defaultCliState;
}

function getSessionFastPreferences(scopeKey: string = getCursorSessionScopeKey()): Map<string, boolean> {
	return sessionFastPreferencesByScopeKey.get(scopeKey) ?? sessionFastPreferences;
}

function getAuthoritativeGlobalFastPreferenceIds(scopeKey: string = getCursorSessionScopeKey()): Set<string> {
	let ids = authoritativeGlobalFastPreferenceIdsByScopeKey.get(scopeKey);
	if (!ids) {
		ids = new Set();
		authoritativeGlobalFastPreferenceIdsByScopeKey.set(scopeKey, ids);
	}
	return ids;
}

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

function restoreSessionFastPreferences(branch: readonly SessionEntry[], scopeKey: string): void {
	const preferences = new Map<string, boolean>();
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== FAST_ENTRY_TYPE) continue;
		if (isCursorFastEntryData(entry.data)) {
			const modelId = getCursorFastEntryModelId(entry.data);
			if (modelId) preferences.set(modelId, entry.data.fast);
		}
	}
	sessionFastPreferencesByScopeKey.set(scopeKey, preferences);
}

function restoreSessionCursorMode(branch: readonly SessionEntry[], scopeKey: string): void {
	sessionCursorAgentModesByScopeKey.delete(scopeKey);
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== MODE_ENTRY_TYPE) continue;
		if (isCursorModeEntryData(entry.data)) {
			sessionCursorAgentModesByScopeKey.set(scopeKey, entry.data.mode);
		}
	}
}

function restoreSessionCursorPreferences(
	ctx: Pick<ExtensionContext, "sessionManager">,
): void {
	const scopeKey = resolveCursorSessionScopeFromContext(ctx).scopeKey;
	const branch = ctx.sessionManager.getBranch();
	restoreSessionCursorRuntimeState(branch, scopeKey);
	restoreSessionFastPreferences(branch, scopeKey);
	restoreSessionCursorMode(branch, scopeKey);
	restoreSessionCursorHttp1(branch, scopeKey);
}

function restoreSessionCursorHttp1(branch: readonly SessionEntry[], scopeKey: string): void {
	setStoredCursorHttp1Enabled(undefined, scopeKey);
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== CURSOR_HTTP1_ENTRY_TYPE) continue;
		if (isCursorHttp1EntryData(entry.data)) {
			setStoredCursorHttp1Enabled(entry.data.enabled, scopeKey);
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

function getEffectiveFast(modelId: string, scopeKey: string = getCursorSessionScopeKey()): boolean | undefined {
	const metadata = getCursorModelMetadata(modelId);
	if (!metadata?.supportsFast) return undefined;
	const cliState = getCursorSessionCliState(scopeKey);
	return resolveCursorFastDefault({
		cliForceNoFast: cliState.forceNoFast,
		cliForceFast: cliState.forceFast,
		aliasOverride: metadata.fastOverride,
		sessionValue: getAuthoritativeGlobalFastPreferenceIds(scopeKey).has(getFastPreferenceModelId(metadata))
			? undefined
			: getMapFastPreference(getSessionFastPreferences(scopeKey), metadata),
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

export function getStoredCursorAgentMode(scopeKey: string = getCursorSessionScopeKey()): AgentModeOption {
	return sessionCursorAgentModesByScopeKey.get(scopeKey) ?? DEFAULT_CURSOR_AGENT_MODE;
}

export function resolveCursorAgentMode(scopeKey: string = getCursorSessionScopeKey()): CursorAgentModeResolution {
	const cliMode = getCursorSessionCliState(scopeKey).mode;
	switch (cliMode.kind) {
		case "valid":
			return { kind: "valid", mode: cliMode.mode };
		case "invalid":
			return { kind: "invalid", raw: cliMode.raw, message: cliMode.message };
		case "unset":
			return { kind: "valid", mode: getStoredCursorAgentMode(scopeKey) };
	}
}

export function getCursorProviderAgentModeOrThrow(scopeKey?: string): AgentModeOption {
	const resolution = resolveCursorAgentMode(scopeKey);
	if (resolution.kind === "invalid") throw new Error(resolution.message);
	return resolution.mode;
}

type CursorStatusContext = Pick<ExtensionContext, "cwd" | "sessionManager"> & Partial<Pick<ExtensionContext, "isProjectTrusted">>;

function updateCursorStatus(ctx: CursorStatusContext & Pick<ExtensionContext, "model" | "ui">, model = ctx.model): void {
	if (!model || !isCursorModel(model)) {
		ctx.ui.setStatus("cursor", undefined);
		return;
	}
	const metadata = getCursorModelMetadata(model.id);
	const scopeKey = resolveCursorSessionScopeFromContext(ctx).scopeKey;
	const resolution = resolveCursorStatusRuntime(ctx);
	const modeResolution = resolveCursorAgentMode(scopeKey);
	const mode = modeResolution.kind === "invalid" ? "invalid" : modeResolution.mode;
	if (resolution.kind === "invalid") {
		ctx.ui.setStatus("cursor", formatCursorStatus("invalid", undefined, mode));
		return;
	}
	const runtime = resolution.runtime.value;
	const fast = runtime === "cloud" ? undefined : metadata?.supportsFast ? getEffectiveFast(model.id, scopeKey) : undefined;
	ctx.ui.setStatus(
		"cursor",
		formatCursorStatus(runtime, fast, mode, resolution.useHttp1ForAgent.value),
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
	scopeKey: string,
): unknown | undefined {
	const sessionPreferences = getSessionFastPreferences(scopeKey);
	const authoritativeIds = getAuthoritativeGlobalFastPreferenceIds(scopeKey);
	const previousSession = sessionPreferences.get(modelId);
	const previousGlobal = globalFastPreferences.get(modelId);
	sessionPreferences.set(modelId, fast);
	globalFastPreferences.set(modelId, fast);
	try {
		saveGlobalFastPreference(modelId, fast);
	} catch (error) {
		restoreMapValue(sessionPreferences, modelId, previousSession);
		restoreMapValue(globalFastPreferences, modelId, previousGlobal);
		throw error;
	}
	try {
		pi.appendEntry<CursorFastEntryData>(FAST_ENTRY_TYPE, { modelId, fast });
		authoritativeIds.delete(modelId);
		return undefined;
	} catch (error) {
		authoritativeIds.add(modelId);
		return error;
	}
}

function persistCursorModePreference(
	pi: Pick<ExtensionAPI, "appendEntry">,
	mode: AgentModeOption,
	scopeKey: string,
): void {
	const previousMode = sessionCursorAgentModesByScopeKey.get(scopeKey);
	sessionCursorAgentModesByScopeKey.set(scopeKey, mode);
	try {
		pi.appendEntry<CursorModeEntryData>(MODE_ENTRY_TYPE, { mode });
	} catch (error) {
		if (previousMode) sessionCursorAgentModesByScopeKey.set(scopeKey, previousMode);
		else sessionCursorAgentModesByScopeKey.delete(scopeKey);
		throw error;
	}
}

function persistCursorHttp1Preference(
	pi: Pick<ExtensionAPI, "appendEntry">,
	enabled: boolean,
	scopeKey: string,
): unknown | undefined {
	const previousSession = getStoredCursorHttp1Enabled(scopeKey);
	setStoredCursorHttp1Enabled(enabled, scopeKey);
	try {
		saveGlobalCursorHttp1Enabled(enabled);
	} catch (error) {
		setStoredCursorHttp1Enabled(previousSession, scopeKey);
		throw error;
	}
	try {
		pi.appendEntry<CursorHttp1EntryData>(CURSOR_HTTP1_ENTRY_TYPE, { enabled });
		setCursorHttp1GlobalPreferenceAuthoritative(false, scopeKey);
		return undefined;
	} catch (error) {
		setCursorHttp1GlobalPreferenceAuthoritative(true, scopeKey);
		return error;
	}
}

function restoreCliCursorMode(
	raw: boolean | string | undefined,
	scopeKey: string,
): void {
	const state = getCursorSessionCliState(scopeKey);
	state.mode = { kind: "unset" };
	if (raw === undefined || raw === "" || raw === false) return;
	const parsed = parseCursorAgentMode(raw);
	if (parsed) {
		state.mode = { kind: "valid", mode: parsed };
		return;
	}
	const rawText = String(raw);
	const message = formatInvalidCursorMode(rawText);
	state.mode = { kind: "invalid", raw: rawText, message };
}

function notifyInvalidCursorModeIfCursorActive(
	ctx: Pick<ExtensionContext, "hasUI" | "mode" | "sessionManager" | "ui">,
): void {
	const scopeKey = resolveCursorSessionScopeFromContext(ctx).scopeKey;
	const modeResolution = resolveCursorAgentMode(scopeKey);
	if (modeResolution.kind !== "invalid" || !ctx.hasUI || ctx.mode !== "tui") return;
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

export function getEffectiveFastForModelId(modelId: string, scopeKey?: string): boolean | undefined {
	return getEffectiveFast(modelId, scopeKey);
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
			const scopeKey = resolveCursorSessionScopeFromContext(ctx).scopeKey;
			const cliState = getCursorSessionCliState(scopeKey);
			const metadata = getCurrentCursorMetadata(ctx);
			if (!metadata?.supportsFast || !ctx.model) {
				const modelName = ctx.model?.id ?? "current model";
				ctx.ui.notify(`Fast mode not supported by ${modelName}`, "info");
				return;
			}
			if (cliState.forceNoFast) {
				ctx.ui.notify("Cursor fast is forced off by --cursor-no-fast", "info");
				return;
			}
			if (cliState.forceFast) {
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
			const current = getEffectiveFast(metadata.piModelId, scopeKey) ?? false;
			const next = !current;
			let appendError: unknown;
			try {
				appendError = persistFastPreference(pi, preferenceModelId, next, scopeKey);
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
				appendError = persistCursorHttp1Preference(
					pi,
					next,
					resolveCursorSessionScopeFromContext(ctx).scopeKey,
				);
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
				const result = await refreshSessionCursorAgentConfig(
					resolveCursorSessionScopeFromContext(ctx).scopeKey,
				);
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
			const scopeKey = resolveCursorSessionScopeFromContext(ctx).scopeKey;
			if (!args.trim()) {
				const modeResolution = resolveCursorAgentMode(scopeKey);
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
			const cliState = getCursorSessionCliState(scopeKey);
			if (cliState.mode.kind === "valid") {
				ctx.ui.notify(`Cursor mode is forced to ${cliState.mode.mode} by --cursor-mode`, "info");
				return;
			}
			const clearedInvalidCliMode = cliState.mode.kind === "invalid";
			try {
				persistCursorModePreference(pi, mode, scopeKey);
				if (clearedInvalidCliMode) cliState.mode = { kind: "unset" };
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
			const scopeKey = resolveCursorSessionScopeFromContext(ctx).scopeKey;
			const cliState: CursorSessionCliState = {
				forceFast: pi.getFlag("cursor-fast") === true,
				forceNoFast: pi.getFlag("cursor-no-fast") === true,
				mode: { kind: "unset" },
			};
			cliStatesByScopeKey.set(scopeKey, cliState);
			getAuthoritativeGlobalFastPreferenceIds(scopeKey).clear();
			setCursorHttp1GlobalPreferenceAuthoritative(false, scopeKey);
			globalFastPreferences = loadGlobalFastPreferences();
			restoreCursorCliState(pi, scopeKey);
			restoreSessionCursorPreferences(ctx);
			restoreCliCursorMode(pi.getFlag("cursor-mode"), scopeKey);
		},
		sync: (ctx) => {
			if (isCursorModel(ctx.model)) notifyInvalidCursorModeIfCursorActive(ctx);
			updateCursorStatus(ctx);
		},
	});
}

export function releaseCursorSessionState(scopeKey: string): void {
	sessionFastPreferencesByScopeKey.delete(scopeKey);
	authoritativeGlobalFastPreferenceIdsByScopeKey.delete(scopeKey);
	sessionCursorAgentModesByScopeKey.delete(scopeKey);
	invalidCursorModeNotifiedSessionScopeKeys.delete(scopeKey);
	cliStatesByScopeKey.delete(scopeKey);
}

function resetCursorModeStateForTests(): void {
	sessionFastPreferences.clear();
	sessionFastPreferencesByScopeKey.clear();
	sessionCursorAgentModesByScopeKey.clear();
	setCursorHttp1GlobalPreferenceAuthoritative(false);
	setStoredCursorHttp1Enabled(undefined);
	defaultCliState.forceFast = false;
	defaultCliState.forceNoFast = false;
	defaultCliState.mode = { kind: "unset" };
	cliStatesByScopeKey.clear();
	resetCursorRuntimeStateForTests();
	invalidCursorModeNotifiedSessionScopeKeys.clear();
	authoritativeGlobalFastPreferenceIdsByScopeKey.clear();
}

export const __testUtils = {
	FAST_ENTRY_TYPE,
	MODE_ENTRY_TYPE,
	CURSOR_HTTP1_ENTRY_TYPE,
	RUNTIME_ENTRY_TYPE: CURSOR_RUNTIME_ENTRY_TYPE,
	DEFAULT_CURSOR_AGENT_MODE,
	getConfigPath,
	loadGlobalFastPreferences,
	sessionFastPreferences,
	getSessionCursorAgentMode: () => sessionCursorAgentModesByScopeKey.get(getCursorSessionScopeKey()),
	getCliCursorAgentMode: () => {
		const mode = getCursorSessionCliState().mode;
		return mode.kind === "valid" ? mode.mode : undefined;
	},
	getCliCursorModeState: () => getCursorSessionCliState().mode,
	resetCursorModeStateForTests,
};
