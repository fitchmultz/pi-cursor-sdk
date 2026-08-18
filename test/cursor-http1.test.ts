import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CursorConfigureOptions } from "@cursor/sdk";
import type { CursorResolvedSetting } from "../src/cursor-config.js";
import {
	__testUtils,
	configureCursorSdkHttp1,
} from "../src/cursor-http1.js";

function setting(
	value: boolean,
	source: "environment" | "user" | "session" | "builtin",
): CursorResolvedSetting<boolean> {
	return {
		value,
		source,
		trustLevel: source === "environment" ? "environment" : source,
	};
}

function sdkWithConfigure(configure: (options: CursorConfigureOptions) => void) {
	return { Cursor: { configure } };
}

describe("Cursor SDK HTTP/1.1 configuration", () => {
	beforeEach(() => {
		__testUtils.reset();
	});

	it("matches the installed Cursor SDK configure and null-clear contract", () => {
		const sdkConfigTypes = readFileSync(
			join(process.cwd(), "node_modules/@cursor/sdk/dist/esm/sdk-config.d.ts"),
			"utf8",
		);
		expect(sdkConfigTypes).toContain("useHttp1ForAgent?: boolean | null");
		expect(sdkConfigTypes).toContain("Pass `null` to clear a previous default.");
		const sdkImplementation = readFileSync(
			join(process.cwd(), "node_modules/@cursor/sdk/dist/esm/index.js"),
			"utf8",
		);
		expect(sdkImplementation).toMatch(
			/void 0!==([A-Za-z_$][\w$]*)\.local&&"useHttp1ForAgent"in \1\.local/,
		);
		expect(sdkImplementation).toContain("T=yield this.getExecutor()");
		const httpVersionSelection = sdkImplementation.indexOf(
			'httpVersion:(n=Oh,Hh(n)||(null!==(r=(0,bh.it)())&&void 0!==r?r:Yh())?"1.1":"2")',
		);
		expect(httpVersionSelection).toBeGreaterThan(-1);
		const cacheKeyStart = sdkImplementation.indexOf("workingDirectory:e.workingDirectory,dirs:e.dirs");
		const cacheKeyEnd = sdkImplementation.indexOf("JSON.stringify(ut(t))", cacheKeyStart);
		expect(cacheKeyStart).toBeGreaterThan(-1);
		expect(cacheKeyEnd).toBeGreaterThan(cacheKeyStart);
		expect(sdkImplementation.slice(cacheKeyStart, cacheKeyEnd)).not.toContain("useHttp1ForAgent");
		expect(sdkImplementation).toContain(
			"t.refs-=1,!(t.refs>0||at.get(e)!==t)){at.delete(e)",
		);
	});

	it.each([
		[true, "environment"],
		[false, "user"],
	] as const)("configures an explicit %s value from %s", (value, source) => {
		const configure = vi.fn<(options: CursorConfigureOptions) => void>();

		expect(configureCursorSdkHttp1(sdkWithConfigure(configure), setting(value, source))).toBe(value);
		expect(configure).toHaveBeenCalledWith({
			local: { useHttp1ForAgent: value },
		});
	});

	it("does not configure the SDK when the setting is unset", () => {
		const configure = vi.fn<(options: CursorConfigureOptions) => void>();

		expect(configureCursorSdkHttp1(sdkWithConfigure(configure), setting(false, "builtin"))).toBeUndefined();
		expect(configure).not.toHaveBeenCalled();
	});

	it("uses the documented null clear after an extension-owned explicit value", () => {
		const configure = vi.fn<(options: CursorConfigureOptions) => void>();
		const sdk = sdkWithConfigure(configure);

		configureCursorSdkHttp1(sdk, setting(true, "session"));
		expect(configureCursorSdkHttp1(sdk, setting(false, "builtin"))).toBeUndefined();
		expect(configure).toHaveBeenLastCalledWith({
			local: { useHttp1ForAgent: null },
		});
	});
});
