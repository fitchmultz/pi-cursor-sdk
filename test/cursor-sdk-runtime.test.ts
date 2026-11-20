import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { loadInstalledCursorParsers } from "./helpers/cursor-native-parser.js";

const require = createRequire(import.meta.url);
const sdkEntry = join(dirname(require.resolve("@cursor/sdk")), "..", "esm", "index.js");
const argv = [...process.argv];
afterEach(() => {
	vi.unstubAllEnvs();
	vi.resetModules();
	process.argv = [...argv];
});

it("initializes real native Bash parsing before SDK import when Pi lives outside the extension tree", async () => {
	vi.stubEnv("CURSOR_TREE_SITTER_VENDOR_DIR", undefined);
	// Neither the launcher nor the Node executable can reach this extension's node_modules.
	process.argv[1] = join(dirname(process.execPath), "pi-sibling", "cli.js");
	// Installed SDK 1.4.2 also searches from its own module directory, so the real entry finds the parsers unaided.
	expect(loadInstalledCursorParsers(sdkEntry).map((parser) => parser.available)).toEqual([true, true]);
	// An SDK module path that cannot reach node_modules either, as in the SDK's Bun entry below,
	// leaves only the extension's vendor env.
	const unreachableSdkModule = join(dirname(process.execPath), "sdk-sibling", "index.js");
	expect(loadInstalledCursorParsers(sdkEntry, unreachableSdkModule)[0].available).toBe(false);
	// Re-import so vendor-env side effects run before the static @cursor/sdk import (#228).
	vi.resetModules();
	const { loadCursorSdk } = await import("../src/cursor-sdk-runtime.js");
	await loadCursorSdk();
	const [parserModule, bashModule] = loadInstalledCursorParsers(sdkEntry, unreachableSdkModule);
	expect(parserModule.available).toBe(true);
	expect(bashModule.available).toBe(true);
	const parser = new parserModule.module();
	parser.setLanguage(bashModule.module);
	const tree = parser.parse("printf '%s\\n' hello | cat > output.txt");
	expect(tree.rootNode.type).toBe("program");
	expect(tree.rootNode.hasError).toBe(false);
	expect(tree.rootNode.toString()).toContain("pipeline");
});

it("still needs the vendor env under Bun, whose SDK entry searches from a build-time module path", () => {
	const sdkRoot = join(dirname(sdkEntry), "..", "..");
	const sdkPackage = JSON.parse(readFileSync(join(sdkRoot, "package.json"), "utf8")) as { exports: { ".": { bun: string } } };
	const bunEntry = readFileSync(join(sdkRoot, sdkPackage.exports["."].bun), "utf8");
	// The Node entries read their own location at run time; the Bun entry carries the path it was built at.
	const builtAt = /var __filename="([^"]+platform-package-locator\.ts)"/.exec(bunEntry)?.[1];
	expect(builtAt).toBeDefined();
	expect(isAbsolute(builtAt!)).toBe(true);
	expect(relative(sdkRoot, builtAt!).startsWith("..")).toBe(true);
});

it.each(["/explicit/vendor", "relative/vendor", ""])("preserves the explicit vendor override %j", async (override) => {
	vi.stubEnv("CURSOR_TREE_SITTER_VENDOR_DIR", override);
	vi.resetModules();
	const { loadCursorSdk } = await import("../src/cursor-sdk-runtime.js");
	await loadCursorSdk();
	expect(process.env.CURSOR_TREE_SITTER_VENDOR_DIR).toBe(override);
});
