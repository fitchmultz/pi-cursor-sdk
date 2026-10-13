import { describe, expect, it } from "vitest";
import {
	getEffectiveCursorSettingSources,
	resolveCursorSettingSources,
} from "../src/cursor-setting-sources.js";

describe("resolveCursorSettingSources", () => {
	it("resolves defaults, enable/disable aliases, and source lists", () => {
		const cases = [
			[[undefined, "", "all", "1", "true", "on"], ["all"]],
			[["none", "0", "false", "off", "omit", "disabled", ",", ",,", "  ,  ,  "], undefined],
			[["project,user"], ["project", "user"]],
		] as const;
		for (const [inputs, expected] of cases) {
			for (const raw of inputs) {
				expect(resolveCursorSettingSources(raw), String(raw)).toEqual(expected);
			}
		}
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
