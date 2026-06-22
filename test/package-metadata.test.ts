import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as {
	dependencies: Record<string, string>;
	devDependencies: Record<string, string>;
	peerDependencies: Record<string, string>;
	bundledDependencies?: string[];
	overrides?: Record<string, string>;
};
const packageLock = require("../package-lock.json") as {
	packages: Record<string, { version?: string }>;
};

const PI_PACKAGES = [
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
] as const;

function lockPackageVersion(packageName: string): string | undefined {
	return packageLock.packages[`node_modules/${packageName}`]?.version;
}

describe("package metadata cutover baselines", () => {
	it("pins Cursor SDK exactly", () => {
		expect(packageJson.dependencies["@cursor/sdk"]).toBe("1.0.19");
		expect(lockPackageVersion("@cursor/sdk")).toBe("1.0.19");
	});

	it("pins the Node ConnectRPC transport required by Cursor SDK's Node seam", () => {
		const sdkTransportDts = readFileSync(
			join(process.cwd(), "node_modules/@cursor/sdk/dist/esm/transport.d.ts"),
			"utf8",
		);

		expect(sdkTransportDts).toContain("Node");
		expect(sdkTransportDts).toContain("`@connectrpc/connect-node`");
		expect(packageJson.dependencies["@connectrpc/connect-node"]).toBe("1.7.0");
		expect(lockPackageVersion("@connectrpc/connect-node")).toBe("1.7.0");
	});

	it("keeps installed ConnectRPC transport siblings aligned", () => {
		expect(lockPackageVersion("@connectrpc/connect-node")).toBe("1.7.0");
		expect(lockPackageVersion("@connectrpc/connect-web")).toBe("1.7.0");
	});

	it("bundles the audited Node transport dependency tree for package consumers", () => {
		expect(packageJson.dependencies.undici).toBe("7.28.0");
		expect(lockPackageVersion("undici")).toBe("7.28.0");
		expect(packageJson.bundledDependencies).toEqual(
			expect.arrayContaining(["@cursor/sdk", "@connectrpc/connect-node", "undici"]),
		);
	});

	it("removes the obsolete sqlite override", () => {
		expect(packageJson.overrides?.sqlite3).toBeUndefined();
	});

	it("pins pi validation baselines", () => {
		for (const packageName of PI_PACKAGES) {
			expect(packageJson.devDependencies[packageName]).toBe("0.79.10");
			expect(lockPackageVersion(packageName)).toBe("0.79.10");
		}
	});

	it("keeps @earendil-works peer dependency ranges unpinned per pi package guidance", () => {
		for (const packageName of PI_PACKAGES) {
			expect(packageJson.peerDependencies[packageName]).toBe("*");
		}
	});
});
