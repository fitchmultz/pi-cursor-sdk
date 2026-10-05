import { createRequire } from "node:module";
import { dirname, join } from "node:path";
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
	expect(loadInstalledCursorParsers(sdkEntry)[0].available).toBe(false);
	// Re-import so vendor-env side effects run before the static @cursor/sdk import (#228).
	vi.resetModules();
	const { loadCursorSdk } = await import("../src/cursor-sdk-runtime.js");
	await loadCursorSdk();
	const [parserModule, bashModule] = loadInstalledCursorParsers(sdkEntry);
	expect(parserModule.available).toBe(true);
	expect(bashModule.available).toBe(true);
	const parser = new parserModule.module();
	parser.setLanguage(bashModule.module);
	const tree = parser.parse("printf '%s\\n' hello | cat > output.txt");
	expect(tree.rootNode.type).toBe("program");
	expect(tree.rootNode.hasError).toBe(false);
	expect(tree.rootNode.toString()).toContain("pipeline");
});

it.each(["/explicit/vendor", "relative/vendor", ""])("preserves the explicit vendor override %j", async (override) => {
	vi.stubEnv("CURSOR_TREE_SITTER_VENDOR_DIR", override);
	vi.resetModules();
	const { loadCursorSdk } = await import("../src/cursor-sdk-runtime.js");
	await loadCursorSdk();
	expect(process.env.CURSOR_TREE_SITTER_VENDOR_DIR).toBe(override);
});
