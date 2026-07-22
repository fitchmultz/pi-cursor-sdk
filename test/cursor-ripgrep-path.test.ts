import {
	accessSync,
	chmodSync,
	constants,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	ensureCursorRipgrepPath,
	resolveBundledCursorRipgrepPath,
} from "../src/cursor-ripgrep-path.js";

const originalRipgrepPath = process.env.CURSOR_RIPGREP_PATH;
const platformPackage = `@cursor/sdk-${process.platform}-${process.arch}`;
const rgBinaryName = process.platform === "win32" ? "rg.exe" : "rg";

afterEach(() => {
	if (originalRipgrepPath === undefined) delete process.env.CURSOR_RIPGREP_PATH;
	else process.env.CURSOR_RIPGREP_PATH = originalRipgrepPath;
});

describe("Cursor ripgrep path", () => {
	it("resolves the executable from the installed Cursor SDK platform package", () => {
		const ripgrepPath = resolveBundledCursorRipgrepPath();

		if (!ripgrepPath) throw new Error("Expected the installed Cursor SDK platform package to include ripgrep");
		expect(ripgrepPath.replaceAll("\\", "/")).toContain(platformPackage);
		expect(() => accessSync(ripgrepPath, constants.X_OK)).not.toThrow();
	});

	it("resolves a platform package nested under @cursor/sdk/node_modules", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-cursor-ripgrep-nested-"));
		try {
			const consumerDir = join(root, "consumer");
			const consumerModule = join(consumerDir, "index.js");
			const sdkDir = join(consumerDir, "node_modules", "@cursor", "sdk");
			const nestedPlatformDir = join(sdkDir, "node_modules", "@cursor", `sdk-${process.platform}-${process.arch}`);
			const nestedBinDir = join(nestedPlatformDir, "bin");
			const nestedRg = join(nestedBinDir, rgBinaryName);

			mkdirSync(nestedBinDir, { recursive: true });
			writeFileSync(join(sdkDir, "package.json"), JSON.stringify({ name: "@cursor/sdk", version: "1.0.23", main: "index.js" }));
			writeFileSync(join(sdkDir, "index.js"), "module.exports = {};\n");
			writeFileSync(
				join(nestedPlatformDir, "package.json"),
				JSON.stringify({ name: platformPackage, version: "1.0.23", bin: { rg: `bin/${rgBinaryName}` } }),
			);
			writeFileSync(nestedRg, "#!/bin/sh\nexit 0\n");
			chmodSync(nestedRg, 0o755);
			writeFileSync(consumerModule, "export {};\n");

			// Nested only — no hoisted platform package beside @cursor/sdk.
			const consumerRequire = createRequire(consumerModule);
			expect(() => consumerRequire.resolve(`${platformPackage}/package.json`)).toThrow();
			expect(consumerRequire.resolve("@cursor/sdk")).toBe(realpathSync(join(sdkDir, "index.js")));

			const resolved = resolveBundledCursorRipgrepPath(pathToFileURL(consumerModule));
			expect(resolved).toBe(realpathSync(nestedRg));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("locks installed @cursor/sdk 1.0.23 Agent.create ripgrep contract", () => {
		const require = createRequire(import.meta.url);
		const sdkEntry = require.resolve("@cursor/sdk");
		const sdkRoot = join(dirname(sdkEntry), "..", "..");
		const sdkPackage = JSON.parse(readFileSync(join(sdkRoot, "package.json"), "utf8")) as { version: string };
		expect(sdkPackage.version).toBe("1.0.23");

		// Agent.create lives in the local-runtime chunk (esm/357.js beside cjs entry's sibling esm).
		const bundle = readFileSync(join(sdkRoot, "dist", "esm", "357.js"), "utf8");

		// Absolute CURSOR_RIPGREP_PATH wins; otherwise search from process.argv[1]; then configure.
		expect(bundle).toMatch(
			/process\.env\.CURSOR_RIPGREP_PATH;w=\w+&&\(0,\w+\.isAbsolute\)\(\w+\)\?\w+:W\(\w+\),\w+\|\|\(\w+=\(0,\w+\.Qd\)\(\)\),\w+&&\(0,\w+\.J\)\(\w+\)/,
		);
		expect(bundle).toContain("if(!process.argv[1])return;");
		expect(bundle).toContain("node_modules");
		expect(bundle).toContain("`@cursor/sdk-${t}`");
		expect(bundle).toContain('throw new Error("configureRipgrepPath: path must not be empty")');
		expect(bundle).toContain("Ripgrep path not configured. Call configureRipgrepPath() at startup.");
	});

	it("configures an empty path without overriding an existing absolute value", () => {
		process.env.CURSOR_RIPGREP_PATH = "";
		const bundledPath = ensureCursorRipgrepPath();
		expect(process.env.CURSOR_RIPGREP_PATH).toBe(bundledPath);

		process.env.CURSOR_RIPGREP_PATH = "/custom/rg";
		expect(ensureCursorRipgrepPath()).toBe("/custom/rg");
		expect(process.env.CURSOR_RIPGREP_PATH).toBe("/custom/rg");
	});
});
