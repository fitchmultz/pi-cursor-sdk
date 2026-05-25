import type { SettingSource } from "@cursor/sdk";

export const CURSOR_SETTING_SOURCES_ENV = "PI_CURSOR_SETTING_SOURCES";

export function resolveCursorSettingSources(raw?: string): SettingSource[] | undefined {
	const trimmed = raw?.trim();
	if (!trimmed) return ["all"];
	const normalized = trimmed.toLowerCase();
	if (["0", "false", "off", "none", "omit", "disabled"].includes(normalized)) return undefined;
	if (["1", "true", "on", "all"].includes(normalized)) return ["all"];
	return trimmed
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry): entry is SettingSource => Boolean(entry));
}

export function getEffectiveCursorSettingSources(raw: string | undefined = process.env[CURSOR_SETTING_SOURCES_ENV]): SettingSource[] | undefined {
	return resolveCursorSettingSources(raw);
}

export function cursorSettingSourcesLoadUserAgentsRules(settingSources: SettingSource[] | undefined): boolean {
	if (!settingSources?.length) return false;
	return settingSources.includes("all") || settingSources.includes("user");
}

export function cursorSettingSourcesLoadProjectAgentsRules(settingSources: SettingSource[] | undefined): boolean {
	if (!settingSources?.length) return false;
	return settingSources.includes("all") || settingSources.includes("project");
}
