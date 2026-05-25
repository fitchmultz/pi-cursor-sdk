import { describe, expect, it } from "vitest";
import {
	CURSOR_SETTING_SOURCES_ENV,
	cursorSettingSourcesLoadProjectAgentsRules,
	cursorSettingSourcesLoadUserAgentsRules,
	getEffectiveCursorSettingSources,
	resolveCursorSettingSources,
} from "../src/cursor-setting-sources.js";

describe("resolveCursorSettingSources", () => {
	it("defaults to all when unset", () => {
		expect(resolveCursorSettingSources(undefined)).toEqual(["all"]);
		expect(resolveCursorSettingSources("")).toEqual(["all"]);
	});

	it("maps disable aliases to undefined", () => {
		for (const raw of ["none", "0", "false", "off", "omit", "disabled"]) {
			expect(resolveCursorSettingSources(raw)).toBeUndefined();
		}
	});

	it("maps enable aliases to all", () => {
		for (const raw of ["all", "1", "true", "on"]) {
			expect(resolveCursorSettingSources(raw)).toEqual(["all"]);
		}
	});

	it("parses comma-separated lists", () => {
		expect(resolveCursorSettingSources("project,user")).toEqual(["project", "user"]);
	});
});

describe("cursorSettingSourcesLoadAgentsRules", () => {
	it("loads user rules only when user or all is enabled", () => {
		expect(cursorSettingSourcesLoadUserAgentsRules(["all"])).toBe(true);
		expect(cursorSettingSourcesLoadUserAgentsRules(["user"])).toBe(true);
		expect(cursorSettingSourcesLoadUserAgentsRules(["project"])).toBe(false);
		expect(cursorSettingSourcesLoadUserAgentsRules(undefined)).toBe(false);
	});

	it("loads project rules only when project or all is enabled", () => {
		expect(cursorSettingSourcesLoadProjectAgentsRules(["all"])).toBe(true);
		expect(cursorSettingSourcesLoadProjectAgentsRules(["project"])).toBe(true);
		expect(cursorSettingSourcesLoadProjectAgentsRules(["user"])).toBe(false);
		expect(cursorSettingSourcesLoadProjectAgentsRules(["plugins"])).toBe(false);
	});
});

describe("getEffectiveCursorSettingSources", () => {
	it("exports the provider env var name", () => {
		expect(CURSOR_SETTING_SOURCES_ENV).toBe("PI_CURSOR_SETTING_SOURCES");
	});

	it("reads from process env by default", () => {
		const previous = process.env[CURSOR_SETTING_SOURCES_ENV];
		try {
			process.env[CURSOR_SETTING_SOURCES_ENV] = "plugins";
			expect(getEffectiveCursorSettingSources()).toEqual(["plugins"]);
		} finally {
			if (previous === undefined) delete process.env[CURSOR_SETTING_SOURCES_ENV];
			else process.env[CURSOR_SETTING_SOURCES_ENV] = previous;
		}
	});
});
