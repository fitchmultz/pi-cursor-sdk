import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import { describe, expect, it } from "vitest";
import { FALLBACK_MODEL_ITEMS } from "../src/cursor-fallback-models.generated.js";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as {
	version: string;
	dependencies: Record<string, string>;
	devDependencies: Record<string, string>;
	peerDependencies: Record<string, string>;
	bundledDependencies?: string[];
	overrides?: Record<string, string>;
};
const packageLock = require("../package-lock.json") as {
	version: string;
	packages: Record<string, { version?: string; resolved?: string; dependencies?: Record<string, string>; bundleDependencies?: boolean | string[] }>;
};

const PI_PACKAGES = [
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
] as const;

const BUNDLED_MCP_HONO_CLOSURE = [
	"@hono/node-server",
	"@modelcontextprotocol/hono",
	"@modelcontextprotocol/server",
	"hono",
] as const;

function lockPackageVersion(packageName: string): string | undefined {
	return packageLock.packages[`node_modules/${packageName}`]?.version;
}

function isPathWithin(root: string, target: string): boolean {
	const pathFromRoot = relative(root, target);
	return pathFromRoot === "" || (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot));
}

function packageIdentitiesFromTarListing(listing: string): Set<string> {
	const identities = new Set<string>();
	for (const line of listing.split(/\r?\n/)) {
		const match = line.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\/package\.json$/);
		if (match?.[1]) identities.add(match[1]);
	}
	return identities;
}

function npmPack(args: string[], cwd: string): string {
	const npmCli = process.env.npm_execpath;
	return npmCli
		? execFileSync(process.execPath, [npmCli, ...args], {
				cwd,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			})
		: execFileSync("npm", args, {
				cwd,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				shell: process.platform === "win32",
			});
}

describe("package metadata cutover baselines", () => {
	it("keeps package, lockfile, and changelog release versions aligned", () => {
		const changelogVersion = readFileSync(join(process.cwd(), "CHANGELOG.md"), "utf8").match(/^## (\S+) /m)?.[1];

		expect(packageLock.version).toBe(packageJson.version);
		expect(packageLock.packages[""]?.version).toBe(packageJson.version);
		expect(changelogVersion).toBe(packageJson.version);
	});

	it("pins Cursor SDK exactly", () => {
		const version = packageJson.dependencies["@cursor/sdk"];
		expect(version).toMatch(/^\d+\.\d+\.\d+$/);
		expect(lockPackageVersion("@cursor/sdk")).toBe(version);
	});

	it("keeps registry dependencies public", () => {
		for (const entry of Object.values(packageLock.packages)) {
			if (!entry.resolved) continue;
			const url = new URL(entry.resolved);
			expect(url.protocol).toBe("https:");
			expect(url.host).toBe("registry.npmjs.org");
		}
	});

	it("ships an exact MCP/Hono bundledDependencies closure for published installs", () => {
		for (const packageName of BUNDLED_MCP_HONO_CLOSURE) {
			expect(packageJson.dependencies[packageName]).toMatch(/^\d+\.\d+\.\d+$/);
			expect(lockPackageVersion(packageName)).toBe(packageJson.dependencies[packageName]);
		}
		expect(packageJson.dependencies["@modelcontextprotocol/sdk"]).toBeUndefined();
		expect(packageJson.bundledDependencies).toEqual([...BUNDLED_MCP_HONO_CLOSURE]);
	});

	it("keeps local agent ID policy aligned with the installed public string contract", () => {
		const sdkOptions = readFileSync(join(process.cwd(), "node_modules/@cursor/sdk/dist/esm/options.d.ts"), "utf8");

		expect(sdkOptions).toMatch(/export interface AgentOptions[\s\S]*?\bagentId\?: string;/);
	});

	it("pins the Node ConnectRPC transport required by Cursor SDK's Node seam", () => {
		const sdkTransportDts = readFileSync(
			join(process.cwd(), "node_modules/@cursor/sdk/dist/esm/transport.d.ts"),
			"utf8",
		);

		expect(sdkTransportDts).toContain("Node");
		expect(sdkTransportDts).toContain("`@connectrpc/connect-node`");
		expect(packageLock.packages["node_modules/@cursor/sdk"]?.dependencies?.["@connectrpc/connect-node"]).toBe("^1.6.1");
		expect(packageJson.dependencies["@connectrpc/connect-node"]).toBeUndefined();
		expect(lockPackageVersion("@connectrpc/connect-node")).toBeDefined();
	});

	it("keeps installed ConnectRPC transport siblings aligned", () => {
		expect(lockPackageVersion("@connectrpc/connect-node")).toBe(lockPackageVersion("@connectrpc/connect-web"));
	});

	it("leaves the Cursor SDK transport dependency tree to npm resolution", () => {
		expect(packageJson.dependencies.undici).toBeUndefined();
		expect(packageJson.bundledDependencies).toEqual([...BUNDLED_MCP_HONO_CLOSURE]);
		expect(packageJson.bundledDependencies).not.toContain("undici");
		expect(packageJson.bundledDependencies).not.toContain("@cursor/sdk");
		expect(packageJson.overrides).toBeUndefined();
	});

	it("removes the obsolete sqlite override", () => {
		expect(packageJson.overrides?.sqlite3).toBeUndefined();
		expect(packageJson.overrides?.["better-sqlite3"]).toBeUndefined();
	});

	it("packs an isolated MCP/Hono closure that beats a hostile host @hono/node-server", () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "pi-cursor-sdk-hono-bundle-"));
		try {
			const packOutput = npmPack(["pack", "--ignore-scripts", "--pack-destination", tempRoot], process.cwd());
			const tarballName = packOutput.trim().split(/\r?\n/).at(-1)?.trim();
			expect(tarballName).toMatch(/^pi-cursor-sdk-.*\.tgz$/);

			const listing = execFileSync("tar", ["-tzf", tarballName!], { cwd: tempRoot, encoding: "utf8" });
			expect(listing).toContain("package/package.json");
			const packedIdentities = packageIdentitiesFromTarListing(listing);
			for (const packageName of BUNDLED_MCP_HONO_CLOSURE) {
				expect(packedIdentities.has(packageName)).toBe(true);
			}
			expect(packedIdentities.has("@modelcontextprotocol/sdk")).toBe(false);
			expect(packedIdentities.has("@modelcontextprotocol/client")).toBe(false);
			expect(packedIdentities.has("@cursor/sdk")).toBe(false);
			expect(packedIdentities.has("undici")).toBe(false);

			const extractDirName = "extract";
			const extractDir = join(tempRoot, extractDirName);
			mkdirSync(extractDir);
			execFileSync("tar", ["-xzf", tarballName!, "-C", extractDirName], { cwd: tempRoot });

			const packedPackageJson = JSON.parse(readFileSync(join(extractDir, "package", "package.json"), "utf8")) as {
				bundledDependencies?: string[];
				dependencies?: Record<string, string>;
			};
			expect(packedPackageJson.bundledDependencies).toEqual([...BUNDLED_MCP_HONO_CLOSURE]);
			for (const packageName of BUNDLED_MCP_HONO_CLOSURE) {
				expect(packedPackageJson.dependencies?.[packageName]).toBe(packageJson.dependencies[packageName]);
			}

			const hostRoot = join(tempRoot, "host");
			const hostNodeModules = join(hostRoot, "node_modules");
			const packageDir = join(hostNodeModules, "pi-cursor-sdk");
			mkdirSync(packageDir, { recursive: true });
			cpSync(join(extractDir, "package"), packageDir, { recursive: true });

			const hostileDir = join(hostNodeModules, "@hono", "node-server");
			mkdirSync(hostileDir, { recursive: true });
			writeFileSync(
				join(hostileDir, "package.json"),
				`${JSON.stringify({ name: "@hono/node-server", version: "1.19.14", main: "index.js" }, null, 2)}\n`,
			);
			writeFileSync(join(hostileDir, "index.js"), "module.exports = { hostile: true };\n");

			const packageRequire = createRequire(join(packageDir, "package.json"));
			const resolvedHonoEntry = realpathSync(packageRequire.resolve("@hono/node-server"));
			const bundledHonoRoot = realpathSync(join(packageDir, "node_modules", "@hono", "node-server"));
			const hostileHonoRoot = realpathSync(join(hostNodeModules, "@hono", "node-server"));
			expect(isPathWithin(bundledHonoRoot, resolvedHonoEntry)).toBe(true);
			expect(isPathWithin(hostileHonoRoot, resolvedHonoEntry)).toBe(false);
			const resolvedVersion = (
				JSON.parse(readFileSync(join(bundledHonoRoot, "package.json"), "utf8")) as { version: string }
			).version;
			expect(resolvedVersion).toBe(packageJson.dependencies["@hono/node-server"]);
		} finally {
			rmSync(tempRoot, { recursive: true, force: true });
		}
	}, 60_000);

	it("pins one coherent stable Pi validation baseline", () => {
		const baseline = packageJson.devDependencies["@earendil-works/pi-coding-agent"];
		expect(baseline).toMatch(/^\d+\.\d+\.\d+$/);
		for (const packageName of PI_PACKAGES) {
			expect(packageJson.devDependencies[packageName]).toBe(baseline);
			expect(lockPackageVersion(packageName)).toBe(baseline);
		}
	});

	it("retains the package's TypeBox validation baseline", () => {
		expect(packageJson.devDependencies.typebox).toMatch(/^\d+\.\d+\.\d+$/);
		expect(lockPackageVersion("typebox")).toBe(packageJson.devDependencies.typebox);
	});

	it("tracks installed Pi GPT-5.6 Codex metadata", () => {
		for (const modelId of ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"] as const) {
			expect(OPENAI_CODEX_MODELS[modelId]).toMatchObject({
				contextWindow: 272000,
				maxTokens: 128000,
				thinkingLevelMap: { xhigh: "xhigh", max: "max", minimal: "low" },
			});
		}
	});

	it("keeps Grok UX examples aligned with the generated Cursor catalog", () => {
		const spec = readFileSync(join(process.cwd(), "docs/cursor-model-ux-spec.md"), "utf8");
		const grok45 = FALLBACK_MODEL_ITEMS.find((item) => item.id === "grok-4.5");
		const grok46 = FALLBACK_MODEL_ITEMS.find((item) => item.id === "grok-4.6");

		expect(grok45?.parameters?.map((parameter) => parameter.id)).toEqual(["effort", "fast"]);
		expect(grok46?.parameters?.map((parameter) => parameter.id)).toEqual(["effort", "fast"]);
		expect(grok46?.parameters?.find((parameter) => parameter.id === "effort")?.values?.map((value) => value.value)).toEqual([
			"low",
			"medium",
			"high",
			"xhigh",
		]);
		expect(FALLBACK_MODEL_ITEMS.some((item) => item.id === "grok-4.3")).toBe(false);
		expect(spec).toContain("### `grok-4.5`");
		expect(spec).toContain("### `grok-4.6`");
		expect(spec).not.toContain("grok-4.3");
	});

	it("keeps @earendil-works peer dependency ranges unpinned per pi package guidance", () => {
		for (const packageName of PI_PACKAGES) {
			expect(packageJson.peerDependencies[packageName]).toBe("*");
		}
	});
});
