import type { AgentModeOption } from "@cursor/sdk";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	buildCursorToolManifestText,
	CURSOR_TOOL_MANIFEST_ENV,
	resolveCursorToolManifestEnabled,
} from "./cursor-tool-manifest.js";
import {
	registerCursorCloudLifecycleLedger,
	runCursorCloudLifecycleCommand,
} from "./cursor-cloud-lifecycle.js";
import { runCursorSessionAgentCleanupCommand } from "./cursor-session-agent-cleanup.js";
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
	CURSOR_AUTO_REVIEW_ENV,
	CURSOR_LOCAL_FORCE_ENV,
	CURSOR_LOCAL_RESUME_ENV,
	CURSOR_CLOUD_ALLOW_LOCAL_STATE_ENV,
	CURSOR_CLOUD_BRANCH_ENV,
	CURSOR_CLOUD_CONTEXT_ENV,
	CURSOR_CLOUD_DIRECT_PUSH_ENV,
	CURSOR_CLOUD_ENV_ENV,
	CURSOR_CLOUD_ENV_FROM_FILES_ENV,
	CURSOR_CLOUD_ENV_NAME_ENV,
	CURSOR_CLOUD_ENV_TYPE_ENV,
	CURSOR_CLOUD_ACK_ENV,
	CURSOR_CLOUD_REPO_ENV,
	CURSOR_RUNTIME_ENV,
	CURSOR_SANDBOX_ENV,
	CURSOR_TOOL_TRANSPORT_ENV,
	parseCursorSdkConfig,
	loadCursorSdkConfig,
	loadCursorSdkProjectConfig,
	loadCursorSdkUserConfig,
	resolveCursorSdkConfig,
	mergeCursorSdkConfig,
	resolveCursorFastDefault,
	saveCursorSdkProjectConfig,
	saveCursorSdkUserConfig,
	withCursorFastDefaults,
	type CursorSdkConfig,
} from "./cursor-config.js";

const FAST_ENTRY_TYPE = "cursor-fast-state";
const MODE_ENTRY_TYPE = "cursor-mode-state";
const RUNTIME_ENTRY_TYPE = "cursor-runtime-state";

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

interface CursorRuntimeEntryData {
	runtime: "local" | "cloud";
	cloudAcknowledged?: boolean;
}

type CursorRuntimeControlsExtensionApi = Pick<
	ExtensionAPI,
	"appendEntry" | "getFlag" | "registerFlag" | "registerCommand" | "on" | "getActiveTools" | "getAllTools"
>;

type CursorCliModeState =
	| { kind: "unset" }
	| { kind: "valid"; mode: AgentModeOption }
	| { kind: "invalid"; raw: string; message: string };

const sessionFastPreferences = new Map<string, boolean>();
let globalFastPreferences = new Map<string, boolean>();
let cliForceFast = false;
let cliForceNoFast = false;
let cliAutoReview = false;
let cliSandbox = false;
let cliLocalForce = false;
let cliLocalResume = false;
let cliNoLocalResume = false;
let envLocalForceConsumed = false;
let cliCursorRuntime: string | undefined;
let cliCursorToolTransport: string | undefined;
let cliCursorCloudRepo: string | undefined;
let cliCursorCloudBranch: string | undefined;
let cliCursorCloudContext: string | undefined;
let cliCursorCloudDirectPush = false;
let cliCursorCloudAllowLocalState = false;
let cliCursorCloudEnv: string | undefined;
let cliCursorCloudEnvFromFiles = false;
let cliCursorCloudEnvType: string | undefined;
let cliCursorCloudEnvName: string | undefined;
let cliCursorCloudAck = false;
let sessionCursorAgentMode: AgentModeOption | undefined;
let sessionCursorRuntime: "local" | "cloud" | undefined;
let sessionCursorCloudAcknowledged = false;
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

function isCursorRuntimeEntryData(value: unknown): value is CursorRuntimeEntryData {
	const record = asRecord(value);
	if (!record) return false;
	const runtime = record.runtime;
	return (runtime === "local" || runtime === "cloud") && (record.cloudAcknowledged === undefined || typeof record.cloudAcknowledged === "boolean");
}

function getConfigPath(): string {
	return getCursorSdkUserConfigPath();
}

function loadGlobalFastPreferences(): Map<string, boolean> {
	return cursorFastDefaultsFromConfig(loadCursorSdkUserConfig());
}

function saveGlobalFastPreferences(): void {
	const currentConfig: CursorSdkConfig = loadCursorSdkUserConfig();
	saveCursorSdkUserConfig(withCursorFastDefaults(currentConfig, globalFastPreferences));
}

function restoreSessionFastPreferences(ctx: { sessionManager: Pick<ExtensionContext["sessionManager"], "getBranch"> }): void {
	sessionFastPreferences.clear();
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== FAST_ENTRY_TYPE) continue;
		if (isCursorFastEntryData(entry.data)) {
			const modelId = getCursorFastEntryModelId(entry.data);
			if (modelId) sessionFastPreferences.set(modelId, entry.data.fast);
		}
	}
}

function restoreSessionCursorMode(ctx: { sessionManager: Pick<ExtensionContext["sessionManager"], "getBranch"> }): void {
	sessionCursorAgentMode = undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== MODE_ENTRY_TYPE) continue;
		if (isCursorModeEntryData(entry.data)) {
			sessionCursorAgentMode = entry.data.mode;
		}
	}
}

function restoreSessionCursorRuntime(ctx: { sessionManager: Pick<ExtensionContext["sessionManager"], "getBranch"> }): void {
	sessionCursorRuntime = undefined;
	sessionCursorCloudAcknowledged = false;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== RUNTIME_ENTRY_TYPE) continue;
		if (isCursorRuntimeEntryData(entry.data)) {
			sessionCursorRuntime = entry.data.runtime;
			sessionCursorCloudAcknowledged = entry.data.cloudAcknowledged === true;
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
		sessionValue: getMapFastPreference(sessionFastPreferences, metadata),
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

function stringFlagValue(value: boolean | string | undefined): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function splitCliEnvNames(value: string | undefined): string[] | undefined {
	return value ? value.split(",").map((name) => name.trim()).filter(Boolean) : undefined;
}

export function getCursorCliConfig(): CursorSdkConfig {
	return parseCursorSdkConfig({
		runtime: cliCursorRuntime,
		toolTransport: cliCursorToolTransport,
		cloud: {
			repo: cliCursorCloudRepo,
			branch: cliCursorCloudBranch,
			contextHandoff: cliCursorCloudContext,
			...(cliCursorCloudDirectPush ? { directPush: true } : {}),
			...(cliCursorCloudAllowLocalState ? { allowLocalState: true } : {}),
			envNames: splitCliEnvNames(cliCursorCloudEnv),
			...(cliCursorCloudEnvFromFiles ? { envFromFiles: true } : {}),
			environment: {
				type: cliCursorCloudEnvType,
				name: cliCursorCloudEnvName,
			},
			...(cliCursorCloudAck ? { acknowledged: true } : {}),
		},
		local: {
			...(cliAutoReview ? { autoReview: true } : {}),
			...(cliSandbox ? { sandboxOptions: { enabled: true } } : {}),
			...(cliLocalForce ? { force: true } : {}),
			...(cliNoLocalResume ? { resume: false } : cliLocalResume ? { resume: true } : {}),
		},
	}) ?? {};
}

export function getCursorSessionConfig(): CursorSdkConfig {
	return sessionCursorRuntime
		? {
				runtime: sessionCursorRuntime,
				...(sessionCursorCloudAcknowledged ? { cloud: { acknowledged: true } } : {}),
			}
		: {};
}

export function consumeCursorLocalForceOverride(resolved: { value: boolean; source: string }): boolean {
	if (!resolved.value) return false;
	if (resolved.source === "cli") {
		cliLocalForce = false;
		return true;
	}
	if (resolved.source === "environment" && !envLocalForceConsumed) {
		envLocalForceConsumed = true;
		return true;
	}
	return false;
}

export function getCursorCliLocalSafetyConfig(): CursorSdkConfig {
	return getCursorCliConfig();
}

type CursorStatusContext = Pick<ExtensionContext, "cwd"> & Partial<Pick<ExtensionContext, "isProjectTrusted">>;

function getCursorStatusRuntime(ctx: CursorStatusContext): "local" | "cloud" {
	const loadedConfig = loadCursorSdkConfig({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted?.() === true });
	return resolveCursorSdkConfig({
		cli: getCursorCliConfig(),
		session: getCursorSessionConfig(),
		user: loadedConfig.user,
		project: loadedConfig.project,
	}).runtime.value;
}

function formatCursorStatus(runtime: "local" | "cloud", fast: boolean | undefined): string {
	const parts = [`cursor:${runtime}`, fast === true ? "fast:on" : fast === false ? "fast:off" : "fast:n/a"];
	const modeResolution = resolveCursorAgentMode();
	if (modeResolution.kind === "invalid") {
		parts.push("mode invalid");
	} else if (modeResolution.mode === "plan") {
		parts.push("plan");
	}
	return parts.join(" · ");
}

function updateCursorStatus(ctx: CursorStatusContext & Pick<ExtensionContext, "model" | "ui">, model = ctx.model): void {
	if (!model || !isCursorModel(model)) {
		ctx.ui.setStatus("cursor", undefined);
		return;
	}
	const metadata = getCursorModelMetadata(model.id);
	const runtime = getCursorStatusRuntime(ctx);
	const fast = runtime === "cloud" ? undefined : metadata?.supportsFast ? getEffectiveFast(model.id) : undefined;
	ctx.ui.setStatus("cursor", formatCursorStatus(runtime, fast));
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

function persistFastPreference(pi: Pick<ExtensionAPI, "appendEntry">, modelId: string, fast: boolean): void {
	const previousSession = sessionFastPreferences.get(modelId);
	const previousGlobal = globalFastPreferences.get(modelId);
	let savedGlobal = false;
	sessionFastPreferences.set(modelId, fast);
	globalFastPreferences.set(modelId, fast);
	try {
		saveGlobalFastPreferences();
		savedGlobal = true;
		pi.appendEntry<CursorFastEntryData>(FAST_ENTRY_TYPE, { modelId, fast });
	} catch (error) {
		restoreMapValue(sessionFastPreferences, modelId, previousSession);
		restoreMapValue(globalFastPreferences, modelId, previousGlobal);
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

function persistCursorRuntimePreference(pi: Pick<ExtensionAPI, "appendEntry">, runtime: "local" | "cloud", cloudAcknowledged = false): void {
	const previousRuntime = sessionCursorRuntime;
	const previousCloudAcknowledged = sessionCursorCloudAcknowledged;
	sessionCursorRuntime = runtime;
	sessionCursorCloudAcknowledged = cloudAcknowledged;
	try {
		pi.appendEntry<CursorRuntimeEntryData>(RUNTIME_ENTRY_TYPE, { runtime, ...(cloudAcknowledged ? { cloudAcknowledged } : {}) });
	} catch (error) {
		sessionCursorRuntime = previousRuntime;
		sessionCursorCloudAcknowledged = previousCloudAcknowledged;
		throw error;
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
	registerCursorCloudLifecycleLedger(pi);

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

	pi.registerFlag("cursor-runtime", {
		description: `Select Cursor runtime for this run: local or cloud (or set ${CURSOR_RUNTIME_ENV})`,
		type: "string",
		default: "",
	});

	pi.registerFlag("cursor-tool-transport", {
		description: `Select Cursor local pi-tool transport scaffold: mcp or customTools (or set ${CURSOR_TOOL_TRANSPORT_ENV})`,
		type: "string",
		default: "",
	});

	pi.registerFlag("cursor-cloud-repo", {
		description: `Set Cursor cloud repository URL for this run (or set ${CURSOR_CLOUD_REPO_ENV})`,
		type: "string",
		default: "",
	});

	pi.registerFlag("cursor-cloud-branch", {
		description: `Set Cursor cloud branch/ref for this run (or set ${CURSOR_CLOUD_BRANCH_ENV})`,
		type: "string",
		default: "",
	});

	pi.registerFlag("cursor-cloud-context", {
		description: `Set Cursor cloud context handoff: never, fresh, or bootstrap (or set ${CURSOR_CLOUD_CONTEXT_ENV})`,
		type: "string",
		default: "",
	});

	pi.registerFlag("cursor-cloud-direct-push", {
		description: `Allow Cursor cloud direct push for this run (or set ${CURSOR_CLOUD_DIRECT_PUSH_ENV}=1)`,
		type: "boolean",
		default: false,
	});

	pi.registerFlag("cursor-cloud-allow-local-state", {
		description: `Allow Cursor cloud to proceed with local-only state for this run (or set ${CURSOR_CLOUD_ALLOW_LOCAL_STATE_ENV}=1)`,
		type: "boolean",
		default: false,
	});

	pi.registerFlag("cursor-cloud-env", {
		description: `Reserved Cursor cloud env var names; env forwarding is not implemented yet (or set ${CURSOR_CLOUD_ENV_ENV})`,
		type: "string",
		default: "",
	});

	pi.registerFlag("cursor-cloud-env-from-files", {
		description: `Reserved Cursor cloud env-file forwarding flag; not implemented yet (or set ${CURSOR_CLOUD_ENV_FROM_FILES_ENV}=1)`,
		type: "boolean",
		default: false,
	});

	pi.registerFlag("cursor-cloud-env-type", {
		description: `Select Cursor-managed cloud environment type: cloud, pool, or machine (or set ${CURSOR_CLOUD_ENV_TYPE_ENV})`,
		type: "string",
		default: "",
	});

	pi.registerFlag("cursor-cloud-env-name", {
		description: `Select Cursor-managed cloud environment name (or set ${CURSOR_CLOUD_ENV_NAME_ENV})`,
		type: "string",
		default: "",
	});

	pi.registerFlag("cursor-cloud-ack", {
		description: `Acknowledge first-use Cursor cloud runtime risks for this run (or set ${CURSOR_CLOUD_ACK_ENV}=1)`,
		type: "boolean",
		default: false,
	});

	pi.registerFlag("cursor-auto-review", {
		description: `Enable Cursor SDK local Auto-review for this run (or set ${CURSOR_AUTO_REVIEW_ENV}=1)`,
		type: "boolean",
		default: false,
	});

	pi.registerFlag("cursor-sandbox", {
		description: `Enable Cursor SDK local sandboxing for this run (or set ${CURSOR_SANDBOX_ENV}=1)`,
		type: "boolean",
		default: false,
	});

	pi.registerFlag("cursor-local-force", {
		description: `Force-expire a stuck local Cursor SDK run before sending this run (or set ${CURSOR_LOCAL_FORCE_ENV}=1)`,
		type: "boolean",
		default: false,
	});

	pi.registerFlag("cursor-local-resume", {
		description: `Resume recorded local Cursor SDK agents for matching pi session branches (default; or set ${CURSOR_LOCAL_RESUME_ENV}=1)`,
		type: "boolean",
		default: false,
	});

	pi.registerFlag("cursor-no-local-resume", {
		description: `Disable local Cursor SDK agent resume for this run (or set ${CURSOR_LOCAL_RESUME_ENV}=0)`,
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
			try {
				persistFastPreference(pi, preferenceModelId, next);
			} catch (error) {
				updateCursorStatus(ctx);
				ctx.ui.notify(`Failed to save Cursor fast preference: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
			updateCursorStatus(ctx);
			ctx.ui.notify(`Cursor fast ${next ? "enabled" : "disabled"}`, "info");
		},
	});

	pi.registerCommand("cursor-runtime", {
		description: "Set Cursor runtime for this session: local or cloud",
		handler: async (args, ctx) => {
			const usage = "Usage: /cursor-runtime local|cloud [--save-user|--save-project]";
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const raw = tokens[0];
			const saveUser = tokens.includes("--save-user");
			const saveProject = tokens.includes("--save-project");
			const extra = tokens.slice(1).filter((token) => token !== "--save-user" && token !== "--save-project");
			if (!raw) {
				ctx.ui.notify(`Cursor runtime is ${sessionCursorRuntime ?? "local"}. ${usage}`, "info");
				return;
			}
			if ((raw !== "local" && raw !== "cloud") || extra.length > 0 || (saveUser && saveProject)) {
				ctx.ui.notify(`Invalid Cursor runtime arguments. ${usage}`, "error");
				return;
			}
			try {
				persistCursorRuntimePreference(pi, raw, raw === "cloud");
				if (saveUser) {
					const current = loadCursorSdkUserConfig();
					saveCursorSdkUserConfig(mergeCursorSdkConfig(current, { runtime: raw, ...(raw === "cloud" ? { cloud: { acknowledged: true } } : {}) }));
				}
				if (saveProject) {
					const current = loadCursorSdkProjectConfig(ctx.cwd, true) ?? {};
					saveCursorSdkProjectConfig(ctx.cwd, mergeCursorSdkConfig(current, { runtime: raw }));
				}
			} catch (error) {
				ctx.ui.notify(`Failed to save Cursor runtime preference: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
			updateCursorStatus(ctx);
			const saved = saveUser ? " Saved to user config." : saveProject ? " Saved to project config; cloud acknowledgement remains session/user-scoped." : "";
			ctx.ui.notify(
				raw === "cloud"
					? `Cursor runtime set to cloud for this session and first-use cloud risk acknowledged. Cloud runs use fresh context by default, no pi bridge, and no pi env forwarding.${saved}`
					: `Cursor runtime set to local for this session.${saved}`,
				"info",
			);
		},
	});

	pi.registerCommand("cursor-tools", {
		description: "Show live Cursor tool surfaces for this session (maintainer debug)",
		handler: async (_args, ctx) => {
			emitCursorToolsDebugReport(pi, ctx);
		},
	});

	pi.registerCommand("cursor-cloud", {
		description: "List, archive, or delete recorded Cursor cloud agents for this session branch",
		handler: async (args, ctx) => {
			await runCursorCloudLifecycleCommand(pi, args, ctx);
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

	registerCursorModelLifecycle(pi, {
		sessionStart: (_event, ctx) => {
			globalFastPreferences = loadGlobalFastPreferences();
			cliForceFast = pi.getFlag("cursor-fast") === true;
			cliForceNoFast = pi.getFlag("cursor-no-fast") === true;
			cliAutoReview = pi.getFlag("cursor-auto-review") === true;
			cliSandbox = pi.getFlag("cursor-sandbox") === true;
			cliLocalForce = pi.getFlag("cursor-local-force") === true;
			cliLocalResume = pi.getFlag("cursor-local-resume") === true;
			cliNoLocalResume = pi.getFlag("cursor-no-local-resume") === true;
			cliCursorRuntime = stringFlagValue(pi.getFlag("cursor-runtime"));
			cliCursorToolTransport = stringFlagValue(pi.getFlag("cursor-tool-transport"));
			cliCursorCloudRepo = stringFlagValue(pi.getFlag("cursor-cloud-repo"));
			cliCursorCloudBranch = stringFlagValue(pi.getFlag("cursor-cloud-branch"));
			cliCursorCloudContext = stringFlagValue(pi.getFlag("cursor-cloud-context"));
			cliCursorCloudDirectPush = pi.getFlag("cursor-cloud-direct-push") === true;
			cliCursorCloudAllowLocalState = pi.getFlag("cursor-cloud-allow-local-state") === true;
			cliCursorCloudEnv = stringFlagValue(pi.getFlag("cursor-cloud-env"));
			cliCursorCloudEnvFromFiles = pi.getFlag("cursor-cloud-env-from-files") === true;
			cliCursorCloudEnvType = stringFlagValue(pi.getFlag("cursor-cloud-env-type"));
			cliCursorCloudEnvName = stringFlagValue(pi.getFlag("cursor-cloud-env-name"));
			cliCursorCloudAck = pi.getFlag("cursor-cloud-ack") === true;
			restoreSessionFastPreferences(ctx);
			restoreSessionCursorMode(ctx);
			restoreSessionCursorRuntime(ctx);
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
	sessionCursorRuntime = undefined;
	sessionCursorCloudAcknowledged = false;
	cliCursorModeState = { kind: "unset" };
	cliAutoReview = false;
	cliSandbox = false;
	cliLocalForce = false;
	cliLocalResume = false;
	cliNoLocalResume = false;
	envLocalForceConsumed = false;
	cliCursorRuntime = undefined;
	cliCursorToolTransport = undefined;
	cliCursorCloudRepo = undefined;
	cliCursorCloudBranch = undefined;
	cliCursorCloudContext = undefined;
	cliCursorCloudDirectPush = false;
	cliCursorCloudAllowLocalState = false;
	cliCursorCloudEnv = undefined;
	cliCursorCloudEnvFromFiles = false;
	cliCursorCloudEnvType = undefined;
	cliCursorCloudEnvName = undefined;
	cliCursorCloudAck = false;
	invalidCursorModeNotifiedSessionScopeKeys.clear();
}

export const __testUtils = {
	FAST_ENTRY_TYPE,
	MODE_ENTRY_TYPE,
	RUNTIME_ENTRY_TYPE,
	DEFAULT_CURSOR_AGENT_MODE,
	getConfigPath,
	loadGlobalFastPreferences,
	sessionFastPreferences,
	getSessionCursorAgentMode: () => sessionCursorAgentMode,
	getCliCursorAgentMode: () => (cliCursorModeState.kind === "valid" ? cliCursorModeState.mode : undefined),
	getCliCursorModeState: () => cliCursorModeState,
	resetCursorModeStateForTests,
};
