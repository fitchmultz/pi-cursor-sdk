import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { afterAll, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const buildScript = fileURLToPath(new URL("../scripts/build.mjs", import.meta.url));

const tscStub = fileURLToPath(new URL("./fixtures/build-tsc-stub.cjs", import.meta.url));
const faultPreload = fileURLToPath(new URL("./fixtures/build-fs-fault-preload.mjs", import.meta.url));

function makeFixture(): string {
	const dir = mkdtempSync(join(tmpdir(), "build-swap-"));
	mkdirSync(join(dir, "node_modules", "typescript", "bin"), { recursive: true });
	copyFileSync(tscStub, join(dir, "node_modules", "typescript", "bin", "tsc"));
	return dir;
}

function faultArgs(): string[] {
	return ["--import", pathToFileURL(faultPreload).href];
}

// Returns stderr alongside the exit code so a storm failure in CI reports the
// build's own diagnostic instead of a bare "expected 1 to be 0".
async function runBuild(cwd: string, env: Record<string, string> = {}, nodeArgs: string[] = []) {
	try {
		const { stderr } = await execFile(process.execPath, [...nodeArgs, buildScript], {
			cwd,
			env: { ...process.env, ...env },
		});
		return { code: 0, stderr: stripTerminalSequences(stderr) };
	} catch (error) {
		const failure = error as { code?: number; stderr?: string };
		return { code: failure.code ?? 1, stderr: stripTerminalSequences(failure.stderr ?? "") };
	}
}

function stagingDirs(cwd: string): string[] {
	return readdirSync(cwd).filter((name) => name.startsWith("dist.staging."));
}

const fixtures: string[] = [];
afterAll(() => {
	for (const dir of fixtures) rmSync(dir, { force: true, recursive: true });
});

describe("build.mjs staging swap", () => {
	it("bundles local modules into the manifest entry without changing their exports", async () => {
		const dir = makeFixture();
		fixtures.push(dir);

		expect((await runBuild(dir, { TSC_STUB_MODULE_GRAPH: "1" })).code).toBe(0);

		const entry = join(dir, "dist", "index.js");
		expect(readFileSync(entry, "utf8")).not.toContain("from './helper.js'");
		const { stdout } = await execFile(process.execPath, [
			"--input-type=module", "-e", `console.log((await import(${JSON.stringify(pathToFileURL(entry).href)})).built)`,
		]);
		expect(stripTerminalSequences(stdout).trim()).toBe("true");
	});

	it("keeps Pi host peers and the asset-bearing Cursor SDK external", async () => {
		const dir = makeFixture();
		fixtures.push(dir);

		expect((await runBuild(dir, { TSC_STUB_EXTERNALS: "1" })).code).toBe(0);
		const entry = readFileSync(join(dir, "dist", "index.js"), "utf8");
		expect(entry).toContain("@cursor/sdk");
		expect(entry).toContain("@earendil-works/pi-ai");
	});

	it("preserves the emitted module URL used to locate Cursor's native assets", async () => {
		const dir = makeFixture();
		fixtures.push(dir);
		expect((await runBuild(dir, { TSC_STUB_MODULE_URL: "1" })).code).toBe(0);

		const entry = pathToFileURL(realpathSync(join(dir, "dist", "index.js"))).href;
		const { stdout } = await execFile(process.execPath, [
			"--input-type=module", "-e", `console.log((await import(${JSON.stringify(entry)})).moduleUrl)`,
		]);
		expect(stripTerminalSequences(stdout).trim()).toBe(entry);
	});

	it.each([
		{ name: "resolves bundled host imports to Pi's own module instance", split: false },
		{ name: "rejects missing factory proof even when Pi --help exits 0 after a host identity split", split: true },
	])("$name", async ({ split }) => {
		const dir = makeFixture();
		fixtures.push(dir);
		const build = await runBuild(dir, { TSC_STUB_HOST_IDENTITY: "1" });
		expect(build.code, build.stderr).toBe(0);
		if (split) {
			// A distinct export forces the real factory guard below to throw.
			writeFileSync(join(dir, "dist", "index.js"), "export function getAgentDir() { return process.env.PI_CODING_AGENT_DIR; }\n");
		}
		const extension = join(dir, "identity.ts");
		const marker = join(dir, "identity-factory.json");
		const agentDir = join(dir, "agent");
		writeFileSync(extension, [
			'import { writeFileSync } from "node:fs";',
			'import { getAgentDir } from "@earendil-works/pi-coding-agent";',
			'import { getAgentDir as bundled } from "./dist/index.js";',
			'export default function () {',
			'  if (getAgentDir !== bundled) throw new Error("host module identity split");',
			`  writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ agentDir: getAgentDir() }));`,
			'}',
		].join("\n"));
		// Windows npm launchers are shell shims, not JavaScript. Run the real
		// installed entrypoint through Node on every platform.
		const hostRoot = fileURLToPath(new URL("../", import.meta.resolve("@earendil-works/pi-coding-agent")));
		const hostManifest = JSON.parse(readFileSync(join(hostRoot, "package.json"), "utf8")) as { bin: { pi: string } };
		const cli = join(hostRoot, hostManifest.bin.pi);
		// Pi catches extension errors and --help still exits 0 (execFile resolves).
		// Only the marker proves the factory ran past the identity guard.
		const { stderr } = await execFile(process.execPath, [cli, "--no-extensions", "--no-skills", "--offline", "-e", extension, "--help"], {
			cwd: dir,
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
			timeout: 30_000,
		});
		const diagnostics = stripTerminalSequences(stderr);
		const proof = existsSync(marker) ? readFileSync(marker, "utf8") : undefined;
		if (split) {
			expect(diagnostics).toContain("Failed to load extension");
			expect(diagnostics).toContain("host module identity split");
			expect(proof, "a factory that failed its identity guard must not write proof").toBeUndefined();
		} else {
			expect(proof, `Pi --help exited 0, but the identity factory proof was missing or invalid. stderr:\n${diagnostics || "(empty)"}`)
				.toBe(JSON.stringify({ agentDir }));
		}
	}, 35_000);

	it("preserves the previous dist and cleans staging when the compile fails", async () => {
		const dir = makeFixture();
		fixtures.push(dir);
		mkdirSync(join(dir, "dist"));
		writeFileSync(join(dir, "dist", "sentinel.txt"), "previous build");

		const { code: exitCode } = await runBuild(dir, { TSC_STUB_FAIL: "1" });

		expect(exitCode).not.toBe(0);
		expect(existsSync(join(dir, "dist", "sentinel.txt"))).toBe(true);
		expect(stagingDirs(dir)).toEqual([]);
	});

	it("replaces dist atomically, purging stale files", async () => {
		const dir = makeFixture();
		fixtures.push(dir);
		mkdirSync(join(dir, "dist"));
		writeFileSync(join(dir, "dist", "stale.txt"), "old output");

		expect((await runBuild(dir)).code).toBe(0);

		expect(existsSync(join(dir, "dist", "index.js"))).toBe(true);
		expect(existsSync(join(dir, "dist", "stale.txt"))).toBe(false);
		expect(stagingDirs(dir)).toEqual([]);
	});

	it("reaps staging dirs owned by dead pids and keeps live ones", async () => {
		const dir = makeFixture();
		fixtures.push(dir);
		const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
		expect(typeof deadPid).toBe("number");
		mkdirSync(join(dir, `dist.staging.${deadPid}`, "partial"), { recursive: true });
		const livePid = process.pid;
		mkdirSync(join(dir, `dist.staging.${livePid}`, "inflight"), { recursive: true });

		expect((await runBuild(dir)).code).toBe(0);

		expect(existsSync(join(dir, `dist.staging.${deadPid}`))).toBe(false);
		expect(existsSync(join(dir, `dist.staging.${livePid}`))).toBe(true);
	});

	it("warns and continues when stranded staging cannot be removed", async () => {
		const dir = makeFixture();
		fixtures.push(dir);
		const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
		expect(typeof deadPid).toBe("number");
		const lockedName = `dist.staging.${deadPid}`;
		mkdirSync(join(dir, lockedName, "partial"), { recursive: true });

		const result = await runBuild(
			dir,
			{ BUILD_SWAP_FAULT: "stale-rm", LOCKED_STAGING_NAME: lockedName },
			faultArgs(),
		);

		expect(result.code).toBe(0);
		expect(result.stderr).toContain("could not remove staging");
		expect(existsSync(join(dir, lockedName))).toBe(true);
		expect(existsSync(join(dir, "dist", "index.js"))).toBe(true);
	});

	it("fails loudly when the previous dist cannot be removed", async () => {
		const dir = makeFixture();
		fixtures.push(dir);
		mkdirSync(join(dir, "dist"));
		writeFileSync(join(dir, "dist", "sentinel.txt"), "previous build");

		const result = await runBuild(dir, { BUILD_SWAP_FAULT: "stale-rm", LOCKED_STAGING_NAME: "dist" }, faultArgs());

		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("synthetic stale-staging lock");
		expect(existsSync(join(dir, "dist", "sentinel.txt"))).toBe(true);
		expect(stagingDirs(dir)).toEqual([]);
	});

	it("concurrent build storms all succeed and leave a valid dist", async () => {
		const dir = makeFixture();
		fixtures.push(dir);
		const results = await Promise.all(Array.from({ length: 4 }, () => runBuild(dir)));
		expect(results.flatMap((result) => (result.code === 0 ? [] : [result.stderr]))).toEqual([]);
		expect(existsSync(join(dir, "dist", "index.js"))).toBe(true);
		expect(stagingDirs(dir)).toEqual([]);
	}, 30_000);

	it("publishes its retained staging tree after a rename is unavailable beyond two seconds", async () => {
		const dir = makeFixture();
		fixtures.push(dir);

		const result = await runBuild(dir, { BUILD_SWAP_FAULT: "late-winner" }, faultArgs());

		expect(result).toEqual({ code: 0, stderr: "" });
		expect(existsSync(join(dir, "dist", "index.js"))).toBe(true);
		expect(readFileSync(join(dir, "dist", "late-winner.txt"), "utf8")).toBe("2200");
		expect(stagingDirs(dir)).toEqual([]);
	}, 10_000);

	it("deterministically discards staging after a concurrent winner publishes", async () => {
		const dir = makeFixture();
		fixtures.push(dir);

		const result = await runBuild(dir, { BUILD_SWAP_FAULT: "race-loss" }, faultArgs());

		expect(result.code).toBe(0);
		expect(result.stderr).toContain("dist/ was published by a concurrent build");
		expect(existsSync(join(dir, "dist", "winner.txt"))).toBe(true);
		expect(stagingDirs(dir)).toEqual([]);
	});

	it("does not accept an empty dist directory as a published winner", async () => {
		const dir = makeFixture();
		fixtures.push(dir);

		const result = await runBuild(dir, { BUILD_SWAP_FAULT: "empty-dist" }, faultArgs());

		expect(result).toEqual({ code: 0, stderr: "" });
		expect(existsSync(join(dir, "dist", "index.js"))).toBe(true);
		expect(stagingDirs(dir)).toEqual([]);
	});

	it("caps persistent rename failures and preserves the original diagnostic", async () => {
		const dir = makeFixture();
		fixtures.push(dir);
		mkdirSync(join(dir, "dist"));
		writeFileSync(join(dir, "dist", "sentinel.txt"), "previous build");

		const result = await runBuild(dir, { BUILD_SWAP_FAULT: "rename-always" }, faultArgs());

		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("synthetic permanent rename failure after 2500ms");
		expect(existsSync(join(dir, "dist"))).toBe(false);
		expect(existsSync(join(dir, "dist", "sentinel.txt"))).toBe(false);
		expect(stagingDirs(dir)).toEqual([]);
	}, 10_000);

	it("rethrows when the staged emit disappears before publication", async () => {
		const dir = makeFixture();
		fixtures.push(dir);

		const result = await runBuild(dir, { BUILD_SWAP_FAULT: "vanish-staging" }, faultArgs());

		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("ENOENT");
		expect(existsSync(join(dir, "dist"))).toBe(false);
		expect(stagingDirs(dir)).toEqual([]);
	}, 10_000);
});
