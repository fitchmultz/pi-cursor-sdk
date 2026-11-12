import type { AgentModeOption } from "@cursor/sdk";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CursorExplicitSdkConfig, CursorRuntime } from "./cursor-config.js";
import { cursorRuntimeSessionScopeKeyForManager, getCursorSessionProjectTrusted } from "./cursor-session-scope.js";

export type CursorCliModeState =
	| { kind: "unset" }
	| { kind: "valid"; mode: AgentModeOption }
	| { kind: "invalid"; raw: string; message: string };

/** One-shot `--cursor-local-force` of a CLI owner; send initiation consumes it even if the send rejects. */
export type CursorCliLocalForce = "notRequested" | "armed" | "consumed";

/** `globalOnly`: the config write succeeded, then the session branch append failed. */
export type CursorPreferenceSaveOutcome =
	| { kind: "saved" }
	| { kind: "globalOnly"; error: unknown }
	| { kind: "failed"; error: unknown };

/** Writes the command's config preference, if any, before its session branch entry. */
export function saveCursorPreference(writes: { config?: () => void; branch: () => void }): CursorPreferenceSaveOutcome {
	if (writes.config) {
		try {
			writes.config();
		} catch (error) {
			return { kind: "failed", error };
		}
	}
	try {
		writes.branch();
	} catch (error) {
		return writes.config ? { kind: "globalOnly", error } : { kind: "failed", error };
	}
	return { kind: "saved" };
}

function createCliSettings() {
	return {
		forceFast: false, forceNoFast: false,
		mode: { kind: "unset" } as CursorCliModeState,
		invalidModeNoticeScopes: new Set<string>(),
		config: {} as CursorExplicitSdkConfig,
		cloudEnvNames: undefined as string | undefined,
		localForce: "notRequested" as CursorCliLocalForce,
	};
}

function createSettings() {
	return {
		fast: new Map<string, boolean>(),
		// A globalOnly save keeps the user default above this branch's value until a later saved outcome
		// or session start (fresh settings). Tree navigation keeps it; sibling sessions never see it.
		fastGlobalOnly: new Set<string>(),
		mode: undefined as AgentModeOption | undefined,
		runtime: undefined as CursorRuntime | undefined,
		cloudAcknowledged: false,
		http1: undefined as boolean | undefined,
		http1GlobalOnly: false,
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
	return manager ? cursorRuntimeSessionScopeKeyForManager(manager) : undefined;
}

export function registerCursorSessionSettings(pi: Pick<ExtensionAPI, "on">): void {
	let scopeKey: string | undefined;
	let cli = createCliSettings();
	pi.on("session_start", (_event, ctx) => {
		if (scopeKey) settings.delete(scopeKey);
		scopeKey = cursorRuntimeSessionScopeKeyForManager(ctx.sessionManager);
		legacySettings = getCursorSessionSettings(scopeKey);
		// Reload creates a new ExtensionAPI but retains the same public manager and, through Pi's native
		// ESM import, this module. Keep the run's one-shot CLI consumption without retaining dead managers.
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
