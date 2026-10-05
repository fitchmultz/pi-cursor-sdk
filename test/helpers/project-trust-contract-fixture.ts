import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect } from "vitest";
import { attachJsonlLineReader } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/jsonl.js";

// Shared fixture for the four cursor-project-trust-contract-*.test.ts shards.
// The original single-file suite ran its 24 scenarios sequentially inside one
// vitest fork because resetCursorProviderTestState mutates provider globals,
// making in-file concurrency unsafe. The shards split at FILE level (one
// describe per fork) to parallelize the real-pi spawns while keeping every
// scenario and assertion verbatim; this module owns the shared fixture.

const packageRoot = process.cwd();
const piCli = resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const trustManagerUrl = pathToFileURL(join(dirname(piCli), "core/trust-manager.js")).href;
const rpcFramingText = "RPC framing: x\u2028y\u2029z \uD83D\uDC08";
const OS_ENV_KEYS = new Set(["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TMPDIR", "TMP", "TEMP"]);

export const PROJECT_TRUST_FIXTURE_SETUP_TIMEOUT_MS = 180_000;

export type PiMode = "print" | "json" | "rpc";
type MarkerEvent = {
	event: string;
	mode?: string;
	hasUI?: boolean;
	trusted?: boolean;
	runtime?: string;
	runtimeSource?: string;
	acknowledged?: boolean;
	acknowledgementSource?: string;
};

function isolatedPiEnv(homeDir: string, agentDir: string): NodeJS.ProcessEnv {
	return {
		...Object.fromEntries(Object.entries(process.env).filter(([name]) => OS_ENV_KEYS.has(name.toUpperCase()))),
		HOME: homeDir,
		USERPROFILE: homeDir,
		XDG_CONFIG_HOME: join(homeDir, ".config"),
		XDG_CACHE_HOME: join(homeDir, ".cache"),
		PI_CODING_AGENT_DIR: agentDir,
		PI_OFFLINE: "1",
		PI_SKIP_VERSION_CHECK: "1",
		PI_TELEMETRY: "0",
	};
}

function runNativeProbe<T>(source: string, env: NodeJS.ProcessEnv): T {
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
		cwd: packageRoot,
		env,
		encoding: "utf8",
		timeout: 10_000,
	});
	expect(result.error).toBeUndefined();
	expect(result.status, result.stderr).toBe(0);
	return JSON.parse(result.stdout) as T;
}

export function inspectNativeTrust(cwd: string, homeDir: string, agentDir: string): { requiresTrust: boolean; decision: boolean | null } {
	return runNativeProbe(`
const { hasTrustRequiringProjectResources, ProjectTrustStore } = await import(${JSON.stringify(trustManagerUrl)});
console.log(JSON.stringify({
	requiresTrust: hasTrustRequiringProjectResources(${JSON.stringify(cwd)}),
	decision: new ProjectTrustStore(process.env.PI_CODING_AGENT_DIR).get(${JSON.stringify(cwd)}),
}));
`, isolatedPiEnv(homeDir, agentDir));
}

function createTrustIsolatedFixtureRoot(): string {
	// Pi scans .agents/skills through every cwd ancestor, except the current HOME's
	// user skills. A redirected TMPDIR under the real home is therefore NOT isolated
	// when the child has a synthetic HOME. Verify with the native child contract,
	// falling back to Node's OS-default temp root without TMPDIR/TMP/TEMP overrides.
	const systemTempEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
		OS_ENV_KEYS.has(name.toUpperCase()) && !["TMPDIR", "TMP", "TEMP"].includes(name.toUpperCase()),
	));
	const systemTemp = runNativeProbe<string>('import { tmpdir } from "node:os"; console.log(JSON.stringify(tmpdir()));', systemTempEnv);
	for (const base of new Set([tmpdir(), systemTemp])) {
		const root = mkdtempSync(join(base, "pi-cursor-project-trust-package-"));
		let accepted = false;
		try {
			const snapshot = inspectNativeTrust(root, join(root, "home"), join(root, "agent"));
			accepted = !snapshot.requiresTrust && snapshot.decision === null;
			if (accepted) return root;
		} finally {
			if (!accepted) rmSync(root, { recursive: true, force: true });
		}
	}
	throw new Error("Trust fixture requires a writable temp root without ancestor .agents/skills resources.");
}

function preparePackedProbeExtension(fixtureRoot: string): { packedPackageRoot: string; probeExtensionPath: string } {
	let packedPackageRoot = "";
	let probeExtensionPath = "";
	const packDir = join(fixtureRoot, "pack");
	const extractDir = join(fixtureRoot, "extract");
	mkdirSync(packDir);
	mkdirSync(extractDir);
	const npmCli = process.env.npm_execpath;
	const packArgs = ["pack", "--silent", "--pack-destination", packDir];
	const pack = npmCli
		? spawnSync(process.execPath, [npmCli, ...packArgs], {
				cwd: packageRoot,
				encoding: "utf8",
				timeout: 60_000,
			})
			: spawnSync("npm", packArgs, {
					cwd: packageRoot,
				encoding: "utf8",
				shell: process.platform === "win32",
					timeout: 60_000,
				});
	expect(pack.error).toBeUndefined();
	expect(pack.status, pack.stderr).toBe(0);
	const tarballName = pack.stdout.trim().split(/\r?\n/).filter(Boolean).pop();
	expect(tarballName).toBeTruthy();
	const extract = spawnSync("tar", ["-xzf", `pack/${tarballName}`, "-C", "extract"], {
		cwd: fixtureRoot,
		encoding: "utf8",
		timeout: 60_000,
	});
	expect(extract.error).toBeUndefined();
	expect(extract.status, extract.stderr).toBe(0);
	packedPackageRoot = join(extractDir, "package");
	expect(existsSync(join(packedPackageRoot, "src", "index.ts"))).toBe(true);
	probeExtensionPath = join(packedPackageRoot, "src", "project-trust-contract-probe.ts");
	writeFileSync(probeExtensionPath, `
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import cursorExtension from "./index.js";
import { resolveCursorProviderTurnConfig } from "./cursor-provider-turn-prepare.js";
const mark = (event: unknown) => appendFileSync(process.env.PI_CURSOR_CONTRACT_MARKER!, JSON.stringify(event) + "\\n");
export default async function (pi: any) {
	pi.on("project_trust", (event: any) => {
		mark({ event: "project_trust", cwd: event.cwd });
		return { trusted: "undecided" };
	});
	pi.on("session_start", (_event: unknown, ctx: any) => {
		if (process.env.PI_CURSOR_CONTRACT_ADD_TRUST_RESOURCE_AT_SESSION_START === "1") {
			mkdirSync(join(ctx.cwd, ".pi"), { recursive: true });
			writeFileSync(join(ctx.cwd, ".pi", "settings.json"), "{}\\n");
		}
		mark({ event: "session_start", mode: ctx.mode, hasUI: ctx.hasUI, trusted: ctx.isProjectTrusted?.() === true });
		if (ctx.mode === "rpc") ctx.ui.notify(${JSON.stringify(rpcFramingText)}, "info");
		ctx.ui.confirm = async (title: string) => {
			mark({ event: "ui_confirm", title });
			return false;
		};
	});
	await cursorExtension(pi);
	pi.on("before_agent_start", () => {
		const config = resolveCursorProviderTurnConfig(process.cwd());
		mark({
			event: "provider_config",
			runtime: config.runtime.value,
			runtimeSource: config.runtime.source,
			acknowledged: config.cloud.acknowledged.value,
			acknowledgementSource: config.cloud.acknowledged.source,
		});
	});
}
`);
	const packageJsonPath = join(packedPackageRoot, "package.json");
	const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { pi?: { extensions?: string[] } };
	packageJson.pi = { ...packageJson.pi, extensions: ["./src/project-trust-contract-probe.ts"] };
	writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
	return { packedPackageRoot, probeExtensionPath };
}

export function createTrustIsolatedRunRoot(fixtureRoot: string) {
	const runRoot = mkdtempSync(join(fixtureRoot, "run-"));
	const projectDir = join(runRoot, "project");
	const agentDir = join(runRoot, "agent");
	const homeDir = join(runRoot, "home");
	mkdirSync(homeDir);
	const markerPath = join(runRoot, "events.jsonl");
	mkdirSync(join(projectDir, ".pi"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(projectDir, ".pi", "cursor-sdk.json"),
		JSON.stringify({ runtime: "cloud", cloud: { acknowledged: true } }),
	);
	return { runRoot, projectDir, agentDir, homeDir, markerPath };
}

export function createTrustIsolatedPackedFixture(): { fixtureRoot: string; packedPackageRoot: string; probeExtensionPath: string } {
	const fixtureRoot = createTrustIsolatedFixtureRoot();
	try {
		const { packedPackageRoot, probeExtensionPath } = preparePackedProbeExtension(fixtureRoot);
		return { fixtureRoot, packedPackageRoot, probeExtensionPath };
	} catch (error) {
		try {
			rmSync(fixtureRoot, { recursive: true, force: true });
		} finally {
			throw error;
		}
	}
}

interface ProjectTrustRunContext {
	runRoot: string;
	projectDir: string;
	agentDir: string;
	homeDir: string;
	markerPath: string;
	probeExtensionPath: string;
}

export function makeRunPi(readContext: () => ProjectTrustRunContext) {
	return async function runPi(
		mode: PiMode,
		trusted?: boolean,
		addTrustResourceAtSessionStart = false,
		projectLocalPackage = false,
	): Promise<{ output: string; events: MarkerEvent[] }> {
		const { homeDir, agentDir, markerPath, projectDir, probeExtensionPath } = readContext();
		const env = isolatedPiEnv(homeDir, agentDir);
		Object.assign(env, {
			PI_CURSOR_CONTRACT_MARKER: markerPath,
			...(addTrustResourceAtSessionStart ? { PI_CURSOR_CONTRACT_ADD_TRUST_RESOURCE_AT_SESSION_START: "1" } : {}),
			PI_CURSOR_NATIVE_TOOL_DISPLAY: "0",
			PI_CURSOR_PI_TOOL_BRIDGE: "0",
			PI_CURSOR_SETTING_SOURCES: "none",
		});
		const args = [
			piCli,
			...(trusted === undefined ? [] : [trusted ? "--approve" : "--no-approve"]),
			...(projectLocalPackage ? [] : ["-e", probeExtensionPath]),
			"--model",
			"cursor/composer-2-5",
			"--cursor-no-fast",
			"--no-tools",
			"--no-session",
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
			...(projectLocalPackage ? [] : ["--no-extensions"]),
			"--offline",
		];
		let input: string | undefined;
		if (mode === "rpc") {
			args.push("--mode", "rpc");
			input = `${JSON.stringify({ id: "contract-prompt", type: "prompt", message: "contract probe" })}\n`;
		} else {
			if (mode === "json") args.push("--mode", "json");
			args.push("-p", "contract probe");
		}
		const options = {
			cwd: projectDir,
			encoding: "utf8" as const,
			env,
			timeout: 60_000,
			maxBuffer: 2 * 1024 * 1024,
		};
		let settled = false;
		const result = mode === "rpc"
			? await new Promise<{
				error: Error | undefined;
				signal: NodeJS.Signals | null;
				status: number | null;
				stdout: string;
				stderr: string;
			}>((resolveResult) => {
				let protocolError: Error | undefined;
				const child = execFile(process.execPath, args, { ...options, killSignal: "SIGKILL" }, (error, stdout, stderr) => {
					stopReading();
					resolveResult({
							error: protocolError ?? error ?? undefined,
						signal: error?.signal ?? null,
						status: error ? (typeof error.code === "number" ? error.code : null) : 0,
						stdout,
						stderr,
					});
				});
				const stopReading = attachJsonlLineReader(child.stdout!, (line) => {
					try {
						if (JSON.parse(line).type === "agent_settled") {
							settled = true;
							child.stdin!.end();
						}
					} catch (error) {
							protocolError = error instanceof Error ? error : new Error(String(error));
							child.kill("SIGKILL");
						}
					});
				child.stdin!.on("error", (error) => {
						protocolError = error;
						child.kill("SIGKILL");
					});
				// EOF disposes active RPC work: subscribe first and keep stdin open until settlement.
				child.stdin!.write(input);
			})
			: spawnSync(process.execPath, args, { ...options, input });
		expect(result.error).toBeUndefined();
		expect(result.signal).toBeNull();
		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(mode === "print" ? 1 : 0);
		if (mode === "rpc") {
			expect(settled).toBe(true);
			expect(result.stdout).toContain(JSON.stringify(rpcFramingText));
		}
		const events = readFileSync(markerPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as MarkerEvent);
		return { output: `${result.stdout}\n${result.stderr}`, events };
	};
}
