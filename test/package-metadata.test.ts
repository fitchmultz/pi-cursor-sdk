import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as {
	dependencies: Record<string, string>;
	devDependencies: Record<string, string>;
	peerDependencies: Record<string, string>;
};

const PI_PACKAGES = [
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
] as const;

describe("package metadata cutover baselines", () => {
	it("pins Cursor SDK exactly and validates against pi 0.78.0", () => {
		expect(packageJson.dependencies["@cursor/sdk"]).toBe("1.0.16");
		for (const packageName of PI_PACKAGES) {
			expect(packageJson.devDependencies[packageName]).toBe("0.78.0");
		}
	});

	it("keeps @earendil-works peer dependency ranges minimum-only with no upper bound", () => {
		for (const packageName of PI_PACKAGES) {
			const range = packageJson.peerDependencies[packageName];
			expect(range).toBe(">=0.76.0");
			expect(range).toMatch(/^>=\d+\.\d+\.\d+$/);
			expect(range).not.toMatch(/[<|~^]/);
		}
	});
});
