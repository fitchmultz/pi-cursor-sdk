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
const CONFIGURED_CURSOR_KEY = Symbol.for("pi-cursor-sdk.http1-configuration.v1");
type Http1Configuration = { cursor?: CursorHttp1Sdk["Cursor"] };
// Keep the configured SDK handle available to the last session's shutdown, even in another module copy.
const processState = globalThis as typeof globalThis & { [CONFIGURED_CURSOR_KEY]?: Http1Configuration };
const configuration = processState[CONFIGURED_CURSOR_KEY] ??= {};

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
	if (configuration.cursor === undefined) return;
	configuration.cursor.configure({ local: { useHttp1ForAgent: null } });
	configuration.cursor = undefined;
}

export function configureCursorSdkHttp1(
	sdk: CursorHttp1Sdk,
	setting: CursorResolvedSetting<boolean>,
): boolean | undefined {
	if (setting.source !== "builtin") {
		sdk.Cursor.configure({ local: { useHttp1ForAgent: setting.value } });
		configuration.cursor = sdk.Cursor;
		return setting.value;
	}
	if (configuration.cursor === sdk.Cursor) clearCursorSdkHttp1();
	return undefined;
}

export const __testUtils = {
	reset(): void {
		setStoredCursorHttp1Enabled(undefined);
		globalPreferenceAuthoritative = false;
		configuration.cursor = undefined;
	},
};
