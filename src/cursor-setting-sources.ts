import { isCursorLeanEnabled } from "./cursor-lean.js";
import type { SettingSource } from "@cursor/sdk";
/** Provider-facing wrapper; canonical parsing lives in shared/cursor-setting-sources.mjs. */
import {
	CURSOR_SETTING_SOURCES_ENV as CURSOR_SETTING_SOURCES_ENV_JS,
	DEFAULT_CURSOR_SETTING_SOURCES as DEFAULT_CURSOR_SETTING_SOURCES_JS,
	resolveCursorSettingSources as resolveCursorSettingSourcesJs,
} from "../shared/cursor-setting-sources.mjs";

export const CURSOR_SETTING_SOURCES_ENV = CURSOR_SETTING_SOURCES_ENV_JS;
export const DEFAULT_CURSOR_SETTING_SOURCES = DEFAULT_CURSOR_SETTING_SOURCES_JS as readonly SettingSource[];

export function resolveCursorSettingSources(raw?: string): SettingSource[] | undefined {
	return resolveCursorSettingSourcesJs(raw) as SettingSource[] | undefined;
}

export function getEffectiveCursorSettingSources(
	raw: string | undefined = process.env[CURSOR_SETTING_SOURCES_ENV],
): SettingSource[] | undefined {
	return isCursorLeanEnabled() ? [] : resolveCursorSettingSources(raw);
}

export function cursorSettingSourcesIncludes(
	settingSources: SettingSource[] | undefined,
	source: Extract<SettingSource, "user" | "project">,
): boolean {
	if (!settingSources?.length) return false;
	return settingSources.includes("all") || settingSources.includes(source);
}
