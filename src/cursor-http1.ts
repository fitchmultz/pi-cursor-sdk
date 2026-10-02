import type { CursorSdkModule } from "./cursor-sdk-runtime.js";
import type { CursorResolvedSetting } from "./cursor-config.js";
import { asRecord } from "./cursor-record-utils.js";
import { getCursorSessionSettings } from "./cursor-session-settings.js";

export const CURSOR_HTTP1_ENTRY_TYPE = "cursor-http1-state";

export interface CursorHttp1EntryData {
	enabled: boolean;
}

type CursorHttp1Sdk = {
	Cursor: Pick<CursorSdkModule["Cursor"], "configure">;
};

let globalPreferenceAuthoritative = false;
let configuredCursor: CursorHttp1Sdk["Cursor"] | undefined;

export function isCursorHttp1EntryData(value: unknown): value is CursorHttp1EntryData {
	return typeof asRecord(value)?.enabled === "boolean";
}

export function getStoredCursorHttp1Enabled(scopeKey?: string): boolean | undefined {
	return getCursorSessionSettings(scopeKey).http1;
}

export function setStoredCursorHttp1Enabled(enabled: boolean | undefined, scopeKey?: string): void {
	getCursorSessionSettings(scopeKey).http1 = enabled;
}

export function getResolvedSessionCursorHttp1Enabled(scopeKey?: string): boolean | undefined {
	return globalPreferenceAuthoritative ? undefined : getStoredCursorHttp1Enabled(scopeKey);
}

export function setCursorHttp1GlobalPreferenceAuthoritative(authoritative: boolean): void {
	globalPreferenceAuthoritative = authoritative;
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
		setStoredCursorHttp1Enabled(undefined);
		globalPreferenceAuthoritative = false;
		configuredCursor = undefined;
	},
};
