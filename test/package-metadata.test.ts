import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
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
		const changelogVersion = readFileSync(join(process.cwd(), "CHANGELOG.md"), "utf8").match(/^## (\d+\.\d+\.\d+)(?:\s|$)/m)?.[1];

		expect(packageLock.version).toBe(packageJson.version);
		expect(packageLock.packages[""]?.version).toBe(packageJson.version);
		expect(changelogVersion).toBe(packageJson.version);
	});

	it("pairs all shared CI/release workflows and automation checkouts at one immutable revision", () => {
		type Invocation = { uses?: string; with?: Record<string, string> };
		const workflowDir = join(process.cwd(), ".github", "workflows");
		const refs: Array<string | undefined> = [];
		for (const file of readdirSync(workflowDir).filter((file) => /\.ya?ml$/.test(file))) {
			const workflow = parse(readFileSync(join(workflowDir, file), "utf8")) as {
				jobs: Record<string, Invocation & { steps?: Invocation[] }>;
			};
			for (const job of Object.values(workflow.jobs)) {
				for (const invocation of [job, ...(job.steps ?? [])]) {
					if (invocation.uses?.startsWith("fitchmultz/.github/")) {
						refs.push(invocation.uses.split("@")[1]);
						expect(invocation.with?.["automation-ref"], `${file}: shared workflow needs automation-ref`).toBeDefined();
					}
					if (invocation.with?.["automation-ref"] !== undefined) refs.push(invocation.with["automation-ref"]);
					if (invocation.with?.repository === "fitchmultz/.github") refs.push(invocation.with.ref);
				}
			}
		}
		expect(refs.length).toBeGreaterThan(0);
		for (const ref of refs) expect(ref).toMatch(/^[a-f0-9]{40}$/);
		expect(new Set(refs).size, `Mixed shared automation revisions: ${[...new Set(refs)].join(", ")}`).toBe(1);
	});

	it("pins SDK, MCP/Hono, Pi, and TypeBox validation dependencies", () => {
		const version = packageJson.dependencies["@cursor/sdk"];
		expect(version).toMatch(/^\d+\.\d+\.\d+$/);
		expect(lockPackageVersion("@cursor/sdk")).toBe(version);
		for (const packageName of BUNDLED_MCP_HONO_CLOSURE) {
			expect(packageJson.dependencies[packageName]).toMatch(/^\d+\.\d+\.\d+$/);
			expect(lockPackageVersion(packageName)).toBe(packageJson.dependencies[packageName]);
		}
		expect(packageJson.dependencies["@modelcontextprotocol/sdk"]).toBeUndefined();
		expect(packageJson.bundledDependencies).toEqual([...BUNDLED_MCP_HONO_CLOSURE]);
		const baseline = packageJson.devDependencies["@earendil-works/pi-coding-agent"];
		expect(baseline).toMatch(/^\d+\.\d+\.\d+$/);
		for (const packageName of PI_PACKAGES) {
			expect(packageJson.devDependencies[packageName]).toBe(baseline);
			expect(lockPackageVersion(packageName)).toBe(baseline);
		}
		expect(packageJson.devDependencies.typebox).toMatch(/^\d+\.\d+\.\d+$/);
		expect(lockPackageVersion("typebox")).toBe(packageJson.devDependencies.typebox);
	});

	it("keeps registry dependencies public", () => {
		for (const entry of Object.values(packageLock.packages)) {
			if (!entry.resolved) continue;
			const url = new URL(entry.resolved);
			expect(url.protocol).toBe("https:");
			expect(url.host).toBe("registry.npmjs.org");
		}
	});

	it("keeps local agent ID policy aligned with the installed public string contract", () => {
		const sdkOptions = readFileSync(join(process.cwd(), "node_modules/@cursor/sdk/dist/esm/options.d.ts"), "utf8");

		expect(sdkOptions).toMatch(/export interface AgentOptions[\s\S]*?\bagentId\?: string;/);
	});

	it("keeps the SDK-vendored Node transport out of the external dependency tree", () => {
		expect(packageLock.packages["node_modules/@cursor/sdk"]?.dependencies?.["@connectrpc/connect-node"]).toBeUndefined();
		expect(packageJson.dependencies["@connectrpc/connect-node"]).toBeUndefined();
		expect(lockPackageVersion("@connectrpc/connect-node")).toBeUndefined();
	});

	it("leaves the Cursor SDK transport dependency tree to npm resolution", () => {
		expect(packageJson.dependencies.undici).toBeUndefined();
		expect(packageJson.overrides).toBeUndefined();
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

			const hostRoot = join(tempRoot, "host");
			const hostNodeModules = join(hostRoot, "node_modules");
			const packageDir = join(hostNodeModules, "pi-cursor-sdk");
			mkdirSync(hostNodeModules, { recursive: true });
			execFileSync("tar", ["-xzf", tarballName!, "-C", "host/node_modules"], { cwd: tempRoot });
			renameSync(join(hostNodeModules, "package"), packageDir);
			const paths = new Set(listing.trim().split(/\r?\n/).map((path) => path.replace(/^package\//, "")));
			expect(paths.has("scripts/tmux-live-smoke.sh")).toBe(true);
			expect(paths.has("scripts/isolated-cursor-smoke.sh")).toBe(true);
			expect(paths.has("scripts/fixtures/plan-strip-shim/index.ts")).toBe(true);
			expect(paths.has("scripts/steering-rpc-smoke.mjs")).toBe(true);
			expect(paths.has("scripts/visual-tui-smoke.mjs")).toBe(true);
			expect(paths.has("scripts/validate-smoke-jsonl.mjs")).toBe(true);
			expect(paths.has("scripts/debug-sdk-events.mjs")).toBe(true);
			expect(paths.has("scripts/debug-provider-events.mjs")).toBe(true);
			expect(paths.has("platform-smoke.config.mjs")).toBe(true);
			expect(paths.has("scripts/platform-smoke/artifact-bundle-chunk.mjs")).toBe(true);
			expect(paths.has("scripts/platform-smoke/live-suite-runner.mjs")).toBe(true);
			expect(paths.has("scripts/platform-smoke/local-resume-runner.mjs")).toBe(true);
			expect(paths.has("scripts/platform-smoke/target-runtime.mjs")).toBe(true);
			expect(paths.has("scripts/platform-smoke/visual-evidence.mjs")).toBe(true);
			for (const path of paths) {
				if (!path.endsWith(".mjs")) continue;
				const declarationPath = path.replace(/\.mjs$/, ".d.mts");
				if (existsSync(declarationPath)) expect(paths.has(declarationPath)).toBe(true);
			}
			expect(paths.has("shared/cursor-setting-sources.mjs")).toBe(true);
			expect(paths.has("shared/cursor-setting-sources.d.mts")).toBe(true);
			expect(paths.has("shared/cursor-sensitive-text.mjs")).toBe(true);
			expect(paths.has("shared/cursor-sensitive-text.d.mts")).toBe(true);
			expect(paths.has("scripts/lib/local-resume-smoke-harness.mjs")).toBe(true);
			expect(paths.has("scripts/lib/cloud-smoke-cleanup-evidence.mjs")).toBe(true);
			expect(paths.has("scripts/lib/cloud-smoke-cleanup-evidence.d.mts")).toBe(true);
			expect(paths.has("scripts/lib/cloud-smoke-github.mjs")).toBe(true);
			expect(paths.has("scripts/lib/cloud-smoke-github.d.mts")).toBe(true);
			expect(paths.has("scripts/lib/cursor-smoke-env.mjs")).toBe(true);
			expect(paths.has("scripts/lib/cursor-smoke-env.d.mts")).toBe(true);
			expect(paths.has("scripts/lib/cursor-smoke-shell.sh")).toBe(true);
			expect(paths.has("scripts/lib/cursor-visual-render.mjs")).toBe(true);
			expect(paths.has("scripts/lib/cursor-visual-render.d.mts")).toBe(true);
			expect(paths.has("shared/cursor-sdk-event-debug-env.mjs")).toBe(true);
			expect(paths.has("shared/cursor-sdk-event-debug-env.d.mts")).toBe(true);
			expect(paths.has("scripts/lib/cursor-setting-sources.mjs")).toBe(false);
			expect(paths.has("scripts/lib/cursor-sensitive-text.mjs")).toBe(false);
			expect(paths.has("scripts/lib/cursor-cli-args.mjs")).toBe(true);
			expect(paths.has("CHANGELOG.md")).toBe(true);
			expect(paths.has("README.md")).toBe(true);
			expect(paths.has("docs/platform-smoke.md")).toBe(true);
			expect(paths.has("dist/index.js")).toBe(true);
			// pi silently drops manifest entries whose file is missing; assert the
			// manifest target exists inside the actual published tarball.
			const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as { pi?: { extensions?: string[] } };
			for (const entry of manifest.pi?.extensions ?? []) {
				expect(paths.has(entry.replace(/^\.\//, "")), `pi.extensions entry missing from package: ${entry}`).toBe(true);
			}
			expect(paths.has("tsconfig.build.json")).toBe(true);
			expect(paths.has("scripts/build.mjs")).toBe(true);
			expect(paths.has("scripts/prepare.mjs")).toBe(true);
			// Launchers import this helper; packed installs break without it.
			expect(paths.has("scripts/lib/ensure-built.mjs")).toBe(true);
			expect([...paths].some((path) => path.startsWith("coverage/") || path.startsWith(".pi/") || path.includes("smoke-dir"))).toBe(false);

			const packedPackageJson = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
				name: string;
				bundledDependencies?: string[];
				dependencies?: Record<string, string>;
			};
			expect(packedPackageJson.name).toBe("pi-cursor-sdk");
			expect(packedPackageJson.bundledDependencies).toEqual([...BUNDLED_MCP_HONO_CLOSURE]);
			for (const packageName of BUNDLED_MCP_HONO_CLOSURE) {
				expect(packedPackageJson.dependencies?.[packageName]).toBe(packageJson.dependencies[packageName]);
			}

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
