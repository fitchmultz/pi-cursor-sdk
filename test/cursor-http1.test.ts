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
