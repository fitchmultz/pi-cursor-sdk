import type { CursorSdkModule } from "./cursor-sdk-runtime.js";
import type { CursorResolvedSetting } from "./cursor-config.js";
import { asRecord } from "./cursor-record-utils.js";
import { getCursorSessionScopeKey } from "./cursor-session-scope.js";

export const CURSOR_HTTP1_ENTRY_TYPE = "cursor-http1-state";

export interface CursorHttp1EntryData {
	enabled: boolean;
}

type CursorHttp1Sdk = {
	Cursor: Pick<CursorSdkModule["Cursor"], "configure">;
};

interface CursorHttp1SessionState {
	enabled?: boolean;
	globalPreferenceAuthoritative: boolean;
}

const sessionStatesByScopeKey = new Map<string, CursorHttp1SessionState>();
let configuredCursor: CursorHttp1Sdk["Cursor"] | undefined;

function getSessionState(scopeKey: string = getCursorSessionScopeKey()): CursorHttp1SessionState {
	let state = sessionStatesByScopeKey.get(scopeKey);
	if (!state) {
		state = { globalPreferenceAuthoritative: false };
		sessionStatesByScopeKey.set(scopeKey, state);
	}
	return state;
}

export function isCursorHttp1EntryData(value: unknown): value is CursorHttp1EntryData {
	return typeof asRecord(value)?.enabled === "boolean";
}

export function getStoredCursorHttp1Enabled(scopeKey?: string): boolean | undefined {
	return getSessionState(scopeKey).enabled;
}

export function setStoredCursorHttp1Enabled(enabled: boolean | undefined, scopeKey?: string): void {
	getSessionState(scopeKey).enabled = enabled;
}

export function getResolvedSessionCursorHttp1Enabled(scopeKey?: string): boolean | undefined {
	const state = getSessionState(scopeKey);
	return state.globalPreferenceAuthoritative ? undefined : state.enabled;
}

export function setCursorHttp1GlobalPreferenceAuthoritative(authoritative: boolean, scopeKey?: string): void {
	getSessionState(scopeKey).globalPreferenceAuthoritative = authoritative;
}

export function releaseCursorHttp1SessionState(scopeKey: string): void {
	sessionStatesByScopeKey.delete(scopeKey);
}

export function clearCursorSdkHttp1(): void {
	if (configuredCursor === undefined) return;
	configuredCursor.configure({ local: { useHttp1ForAgent: null } });
	configuredCursor = undefined;
}

export function configureCursorSdkHttp1(
	sdk: CursorHttp1Sdk,
	setting: CursorResolvedSetting<boolean>,
): boolean | undefined {
	if (setting.source !== "builtin") {
		sdk.Cursor.configure({ local: { useHttp1ForAgent: setting.value } });
		configuredCursor = sdk.Cursor;
		return setting.value;
	}
	if (configuredCursor === sdk.Cursor) clearCursorSdkHttp1();
	else configuredCursor = undefined;
	return undefined;
}

export const __testUtils = {
	reset(): void {
		sessionStatesByScopeKey.clear();
		configuredCursor = undefined;
	},
};
