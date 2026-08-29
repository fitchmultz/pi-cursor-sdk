import { asRecord } from "./cursor-record-utils.js";

export const CURSOR_ATTRIBUTION_ENTRY_TYPE = "cursor-attribution-state";

export interface CursorAttributionEntryData {
	enabled: boolean;
}

let sessionCursorAttributionEnabled: boolean | undefined;
let globalPreferenceAuthoritative = false;

export function isCursorAttributionEntryData(value: unknown): value is CursorAttributionEntryData {
	return typeof asRecord(value)?.enabled === "boolean";
}

export function getStoredCursorAttributionEnabled(): boolean | undefined {
	return sessionCursorAttributionEnabled;
}

export function setStoredCursorAttributionEnabled(enabled: boolean | undefined): void {
	sessionCursorAttributionEnabled = enabled;
}

export function getResolvedSessionCursorAttributionEnabled(): boolean | undefined {
	return globalPreferenceAuthoritative ? undefined : sessionCursorAttributionEnabled;
}

export function setCursorAttributionGlobalPreferenceAuthoritative(authoritative: boolean): void {
	globalPreferenceAuthoritative = authoritative;
}

export const __testUtils = {
	reset(): void {
		sessionCursorAttributionEnabled = undefined;
		globalPreferenceAuthoritative = false;
	},
};
