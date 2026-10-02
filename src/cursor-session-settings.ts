import type { AgentModeOption } from "@cursor/sdk";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CursorExplicitSdkConfig, CursorRuntime } from "./cursor-config.js";
import { cursorSessionScopeKeyForManager, getCursorSessionProjectTrusted } from "./cursor-session-scope.js";

export type CursorCliModeState =
	| { kind: "unset" }
	| { kind: "valid"; mode: AgentModeOption }
	| { kind: "invalid"; raw: string; message: string };

function createCliSettings() {
	return {
		forceFast: false, forceNoFast: false,
		mode: { kind: "unset" } as CursorCliModeState,
		config: {} as CursorExplicitSdkConfig,
		cloudEnvNames: undefined as string | undefined,
		localForceConsumed: false,
	};
}

function createSettings() {
	return {
		fast: new Map<string, boolean>(),
		mode: undefined as AgentModeOption | undefined,
		runtime: undefined as CursorRuntime | undefined,
		cloudAcknowledged: false,
		http1: undefined as boolean | undefined,
		projectTrusted: false,
		cli: createCliSettings(),
	};
}
const settings = new Map<string, ReturnType<typeof createSettings>>();
let cliOwners = new WeakMap<object, ReturnType<typeof createCliSettings>>();
let legacySettings = createSettings();

export function getCursorSessionSettings(scopeKey?: string) {
	if (scopeKey === undefined) return legacySettings;
	let value = settings.get(scopeKey);
	if (!value) {
		value = createSettings();
		settings.set(scopeKey, value);
	}
	return value;
}

export function cursorSettingsScopeForContext(ctx: Partial<Pick<ExtensionContext, "sessionManager">>): string | undefined {
	const manager = ctx.sessionManager;
	return manager ? cursorSessionScopeKeyForManager(manager) : undefined;
}

export function registerCursorSessionSettings(pi: Pick<ExtensionAPI, "on">): void {
	let scopeKey: string | undefined;
	let cli = createCliSettings();
	pi.on("session_start", (_event, ctx) => {
		if (scopeKey) settings.delete(scopeKey);
		scopeKey = cursorSessionScopeKeyForManager(ctx.sessionManager);
		legacySettings = getCursorSessionSettings(scopeKey);
		// Reload creates a new ExtensionAPI but retains the same public manager.
		// Keep the run's one-shot CLI consumption without retaining dead managers.
		cli = cliOwners.get(ctx.sessionManager) ?? cli;
		cliOwners.set(ctx.sessionManager, cli);
		legacySettings.cli = cli;
		legacySettings.projectTrusted = getCursorSessionProjectTrusted(pi);
	});
	pi.on("session_shutdown", () => { if (scopeKey) settings.delete(scopeKey); });
}

export function resetCursorSessionSettingsForTests(): void {
	settings.clear();
	cliOwners = new WeakMap();
	legacySettings = createSettings();
}
