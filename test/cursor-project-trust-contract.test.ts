import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { attachJsonlLineReader } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/jsonl.js";
import {
	collectEvents,
	getErrorEvent,
	makeContext,
	makeModel,
	mockCreatedAgent,
	mockedCreate,
	mockedResume,
	resetCursorProviderTestState,
} from "./helpers/cursor-provider-harness.js";
import { streamCursor } from "../src/cursor-provider.js";
import { __testUtils as cursorSessionScopeTestUtils } from "../src/cursor-session-scope.js";

const packageRoot = process.cwd();
const piCli = resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const trustManagerUrl = pathToFileURL(join(dirname(piCli), "core/trust-manager.js")).href;
const rpcFramingText = "RPC framing: x\u2028y\u2029z 🐈";
const OS_ENV_KEYS = new Set(["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TMPDIR", "TMP", "TEMP"]);

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

function inspectNativeTrust(cwd: string, homeDir: string, agentDir: string): { requiresTrust: boolean; decision: boolean | null } {
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

type PiMode = "print" | "json" | "rpc";
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

describe("non-interactive project trust CLI/provider contract", () => {
	let fixtureRoot: string;
	let packedPackageRoot: string;
	let probeExtensionPath: string;
	let runRoot: string;
	let projectDir: string;
	let agentDir: string;
	let homeDir: string;
	let markerPath: string;

	beforeAll(() => {
		fixtureRoot = createTrustIsolatedFixtureRoot();
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
			timeout: 30_000,
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
	}, 120_000);

	beforeEach(async () => {
		await resetCursorProviderTestState();
		runRoot = mkdtempSync(join(fixtureRoot, "run-"));
		projectDir = join(runRoot, "project");
		agentDir = join(runRoot, "agent");
		homeDir = join(runRoot, "home");
		mkdirSync(homeDir);
		markerPath = join(runRoot, "events.jsonl");
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(projectDir, ".pi", "cursor-sdk.json"),
			JSON.stringify({ runtime: "cloud", cloud: { acknowledged: true } }),
		);
		// Standalone extension config is not a Pi trust resource. No ancestor skills
		// or inherited trust decisions may silently change the scenario under test.
		expect(inspectNativeTrust(projectDir, homeDir, agentDir)).toEqual({ requiresTrust: false, decision: null });
	});

	afterEach(() => {
		rmSync(runRoot, { recursive: true, force: true });
	});

	afterAll(() => {
		if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
	});

	async function runPi(
		mode: PiMode,
		trusted?: boolean,
		addTrustResourceAtSessionStart = false,
		projectLocalPackage = false,
	): Promise<{ output: string; events: MarkerEvent[] }> {
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
	}

	it.each([
		["print", false],
		["json", false],
		["rpc", true],
	] as const)("ignores project cloud runtime under --no-approve in %s mode", async (mode, hasUI) => {
		writeFileSync(join(projectDir, ".pi", "settings.json"), "{}\n");
		const { output, events } = await runPi(mode, false);

		expect(events).toContainEqual({ event: "session_start", mode, hasUI, trusted: false });
		expect(events).toContainEqual({
			event: "provider_config",
			runtime: "local",
			runtimeSource: "builtin",
			acknowledged: false,
			acknowledgementSource: "builtin",
		});
		expect(events).not.toEqual(expect.arrayContaining([expect.objectContaining({ event: "ui_confirm" })]));
		expect(output).toContain("Cursor SDK runs require a Cursor SDK API key");
		expect(output).not.toContain("Cursor cloud runtime requires first-use acknowledgement");
	}, 90_000);

	it.each([
		["print", false],
		["json", false],
		["rpc", true],
	] as const)("excludes project cloud acknowledgement in approved %s mode", async (mode, hasUI) => {
		writeFileSync(join(projectDir, ".pi", "settings.json"), "{}\n");
		const { output, events } = await runPi(mode, true);

		expect(events).toContainEqual({ event: "session_start", mode, hasUI, trusted: true });
		expect(events).toContainEqual({
			event: "provider_config",
			runtime: "cloud",
			runtimeSource: "project",
			acknowledged: false,
			acknowledgementSource: "builtin",
		});
		expect(events).not.toEqual(expect.arrayContaining([expect.objectContaining({ event: "ui_confirm" })]));
		expect(output).toContain("Cursor SDK runs require a Cursor SDK API key");
	}, 90_000);

	it.each([
		["print", false],
		["json", false],
		["rpc", true],
	] as const)("retains Pi project-trust event provenance in %s mode", async (mode, hasUI) => {
		writeFileSync(join(projectDir, ".pi", "settings.json"), "{}\n");
		new ProjectTrustStore(agentDir).set(projectDir, true);
		const { output, events } = await runPi(mode);

		expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ event: "project_trust" })]));
		expect(events).toContainEqual({ event: "session_start", mode, hasUI, trusted: true });
		expect(events).toContainEqual({
			event: "provider_config",
			runtime: "cloud",
			runtimeSource: "project",
			acknowledged: false,
			acknowledgementSource: "builtin",
		});
		expect(events).not.toEqual(expect.arrayContaining([expect.objectContaining({ event: "ui_confirm" })]));
		expect(output).toContain("Cursor SDK runs require a Cursor SDK API key");
	}, 90_000);

	it.each([
		["print", false],
		["json", false],
		["rpc", true],
	] as const)("honors explicit approval for standalone project config in %s mode", async (mode, hasUI) => {
		writeFileSync(join(agentDir, "cursor-sdk.json"), JSON.stringify({ cloud: { acknowledged: true } }));
		const { output, events } = await runPi(mode, true);

		expect(events).toContainEqual({ event: "session_start", mode, hasUI, trusted: true });
		expect(events).toContainEqual({
			event: "provider_config",
			runtime: "cloud",
			runtimeSource: "project",
			acknowledged: true,
			acknowledgementSource: "user",
		});
		expect(events).not.toEqual(expect.arrayContaining([expect.objectContaining({ event: "ui_confirm" })]));
		expect(output).toContain("Cursor SDK runs require a Cursor SDK API key");
	}, 90_000);

	it.each([
		["print", false],
		["json", false],
		["rpc", true],
	] as const)("ignores standalone project cloud runtime without a trust decision in %s mode", async (mode, hasUI) => {
		writeFileSync(join(agentDir, "cursor-sdk.json"), JSON.stringify({ cloud: { acknowledged: true } }));
		const { output, events } = await runPi(mode);

		// Native Pi auto-trusts a resource-free cwd WITHOUT emitting project_trust;
		// that implicit boolean must not authorize Cursor's standalone cloud config.
		expect(events.some((event) => event.event === "project_trust")).toBe(false);
		expect(events).toContainEqual({ event: "session_start", mode, hasUI, trusted: true });
		expect(events).toContainEqual({
			event: "provider_config",
			runtime: "local",
			runtimeSource: "builtin",
			acknowledged: true,
			acknowledgementSource: "user",
		});
		expect(events).not.toEqual(expect.arrayContaining([expect.objectContaining({ event: "ui_confirm" })]));
		expect(output).toContain("Cursor SDK runs require a Cursor SDK API key");
		expect(output).not.toContain("Cursor cloud runtime requires first-use acknowledgement");
	}, 90_000);

	it.each([
		["print", false],
		["json", false],
		["rpc", true],
	] as const)("ignores a trust resource added after Pi trust resolution in %s mode", async (mode, hasUI) => {
		writeFileSync(join(agentDir, "cursor-sdk.json"), JSON.stringify({ cloud: { acknowledged: true } }));
		const { output, events } = await runPi(mode, undefined, true);

		// The settings resource now requires trust, but it was created only inside
		// session_start, after Pi resolved trust. It cannot grant event provenance.
		expect(readFileSync(join(projectDir, ".pi", "settings.json"), "utf8")).toBe("{}\n");
		expect(inspectNativeTrust(projectDir, homeDir, agentDir)).toEqual({ requiresTrust: true, decision: null });
		expect(events.some((event) => event.event === "project_trust")).toBe(false);
		expect(events).toContainEqual({ event: "session_start", mode, hasUI, trusted: true });
		expect(events).toContainEqual({
			event: "provider_config",
			runtime: "local",
			runtimeSource: "builtin",
			acknowledged: true,
			acknowledgementSource: "user",
		});
		expect(events).not.toEqual(expect.arrayContaining([expect.objectContaining({ event: "ui_confirm" })]));
		expect(output).toContain("Cursor SDK runs require a Cursor SDK API key");
	}, 90_000);

	it.each([
		["print", false],
		["json", false],
		["rpc", true],
	] as const)("requires trust for ancestor Agent Skills even with --no-skills in %s mode", async (mode, hasUI) => {
		// Reproduce the original contamination intentionally, inside this test's
		// own ancestry. Disabling skill loading does not bypass Pi's trust gate.
		mkdirSync(join(runRoot, ".agents", "skills"), { recursive: true });
		expect(inspectNativeTrust(projectDir, homeDir, agentDir)).toEqual({ requiresTrust: true, decision: null });
		const { output, events } = await runPi(mode);

		expect(events.some((event) => event.event === "project_trust")).toBe(true);
		expect(events).toContainEqual({ event: "session_start", mode, hasUI, trusted: false });
		expect(events).toContainEqual({
			event: "provider_config",
			runtime: "local",
			runtimeSource: "builtin",
			acknowledged: false,
			acknowledgementSource: "builtin",
		});
		expect(events.some((event) => event.event === "ui_confirm")).toBe(false);
		expect(output).toContain("Cursor SDK runs require a Cursor SDK API key");
	}, 90_000);

	it.each([
		[undefined, "local", "builtin"],
		[true, "cloud", "project"],
	] as const)(
		"requires explicit --approve=%s for project-local package config",
		async (trusted, runtime, runtimeSource) => {
			writeFileSync(
				join(projectDir, ".pi", "settings.json"),
				JSON.stringify({ packages: [packedPackageRoot] }),
			);
			new ProjectTrustStore(agentDir).set(projectDir, true);

			const { events } = await runPi("print", trusted, false, true);

			expect(events).not.toEqual(expect.arrayContaining([expect.objectContaining({ event: "project_trust" })]));
			expect(events).toContainEqual({ event: "session_start", mode: "print", hasUI: false, trusted: true });
			expect(events).toContainEqual(expect.objectContaining({
				event: "provider_config",
				runtime,
				runtimeSource,
			}));
		},
		90_000,
	);

	it("fails cloud preflight before SDK create or send when project acknowledgement is the only acknowledgement", async () => {
		writeFileSync(join(projectDir, ".pi", "settings.json"), "{}\n");
		cursorSessionScopeTestUtils.set(projectDir, join(runRoot, "session.jsonl"), "contract-session", true);
		const send = vi.fn();
		mockCreatedAgent({ send });

		const events = await collectEvents(streamCursor(makeModel("composer-2.5"), makeContext(), { apiKey: "test-key" }));

		expect(getErrorEvent(events).error.errorMessage).toContain("Cursor cloud runtime requires first-use acknowledgement");
		expect(mockedCreate).not.toHaveBeenCalled();
		expect(mockedResume).not.toHaveBeenCalled();
		expect(send).not.toHaveBeenCalled();
	});
});
