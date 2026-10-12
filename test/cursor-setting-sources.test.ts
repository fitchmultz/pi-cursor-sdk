import { describe, expect, it } from "vitest";
import {
	cursorSettingSourcesIncludes,
	getEffectiveCursorSettingSources,
	resolveCursorSettingSources,
} from "../src/cursor-setting-sources.js";

describe("resolveCursorSettingSources", () => {
	it("defaults to all Cursor setting sources when unset", () => {
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

	it("treats comma-only and blank-list input as disabled", () => {
		for (const raw of [",", ",,", "  ,  ,  "]) {
			expect(resolveCursorSettingSources(raw)).toBeUndefined();
		}
	});
});

describe("cursorSettingSourcesIncludes", () => {
	it("loads user rules only when user or all is enabled", () => {
		expect(cursorSettingSourcesIncludes(["all"], "user")).toBe(true);
		expect(cursorSettingSourcesIncludes(["user"], "user")).toBe(true);
		expect(cursorSettingSourcesIncludes(["project"], "user")).toBe(false);
		expect(cursorSettingSourcesIncludes(undefined, "user")).toBe(false);
	});

	it("loads project rules only when project or all is enabled", () => {
		expect(cursorSettingSourcesIncludes(["all"], "project")).toBe(true);
		expect(cursorSettingSourcesIncludes(["project"], "project")).toBe(true);
		expect(cursorSettingSourcesIncludes(["user"], "project")).toBe(false);
		expect(cursorSettingSourcesIncludes(["plugins"], "project")).toBe(false);
	});
});

describe("getEffectiveCursorSettingSources", () => {
	it("reads from process env by default", () => {
		const previous = process.env.PI_CURSOR_SETTING_SOURCES;
		try {
			process.env.PI_CURSOR_SETTING_SOURCES = "plugins";
			expect(getEffectiveCursorSettingSources()).toEqual(["plugins"]);
		} finally {
			if (previous === undefined) delete process.env.PI_CURSOR_SETTING_SOURCES;
			else process.env.PI_CURSOR_SETTING_SOURCES = previous;
		}
	});
});
