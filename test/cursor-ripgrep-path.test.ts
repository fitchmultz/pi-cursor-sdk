import {
	accessSync,
	chmodSync,
	constants,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	ensureCursorRipgrepPath,
	resolveBundledCursorRipgrepPath,
} from "../src/cursor-ripgrep-path.js";
import { readInstalledPackageDistText } from "./helpers/installed-package.js";

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
			writeFileSync(join(sdkDir, "package.json"), JSON.stringify({ name: "@cursor/sdk", version: "1.0.32", main: "index.js" }));
			writeFileSync(join(sdkDir, "index.js"), "module.exports = {};\n");
			writeFileSync(
				join(nestedPlatformDir, "package.json"),
				JSON.stringify({ name: platformPackage, version: "1.0.32", bin: { rg: `bin/${rgBinaryName}` } }),
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

	it("locks installed @cursor/sdk 1.0.32 Agent.create ripgrep contract", () => {
		const bundle = readInstalledPackageDistText("@cursor/sdk");

		// Absolute CURSOR_RIPGREP_PATH wins; otherwise platform-package lookup, then PATH, then configure.
		expect(bundle).toContain("CURSOR_RIPGREP_PATH");
		expect(bundle).toContain("resolveRipgrepFromPath");
		expect(bundle).toContain("excludedWorkspaceDir");
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
