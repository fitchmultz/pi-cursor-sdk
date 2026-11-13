import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import {
	commonBooleanFlag,
	commonProbeFlags,
	commonRepeatStringFlag,
	apiKeySecretsFromProcess,
	defaultApiKeyFromEnv,
	defaultSettingSourcesFromEnv,
	defaultTimestampedDir,
	parseArgv,
	readArgvApiKey,
	requireApiKey,
} from "../scripts/lib/cursor-cli-args.mjs";
import {
	CHILD_PROCESS_TREE_SPAWN_OPTIONS,
	parseJsonLines,
	terminateChild,
	waitForChildClose,
} from "../scripts/lib/cursor-child-process.mjs";
import {
	buildCursorSmokeEnv,
	buildCursorSmokeEnvPlan,
	CURSOR_SDK_EVENT_DEBUG_ENV_NAMES as scriptSdkEventDebugEnvNames,
	sealedNodePath,
} from "../scripts/lib/cursor-smoke-env.mjs";
import { CURSOR_SDK_EVENT_DEBUG_ENV_NAMES as sharedSdkEventDebugEnvNames } from "../shared/cursor-sdk-event-debug-env.mjs";
import {
	serializeCursorSettingSources,
} from "../shared/cursor-setting-sources.mjs";
import { createScriptFail } from "../scripts/lib/cursor-script-fail.mjs";

const PROCESS_TREE_TEST_TIMEOUT_MS = 15_000;

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

async function waitUntilGone(pids: number[], timeoutMs = 5_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (pids.some(processExists) && Date.now() < deadline) {
		await new Promise((resolveWait) => setTimeout(resolveWait, 25));
	}
	return pids.every((pid) => !processExists(pid));
}

async function readChildPids(parent: ChildProcess): Promise<{ parentPid: number; grandchildPid: number }> {
	if (!parent.stdout) throw new Error("expected child stdout pipe");
	return new Promise((resolvePids, rejectPids) => {
		let stdout = "";
		const timer = setTimeout(() => rejectPids(new Error("timed out waiting for descendant pids")), 5_000);
		parent.stdout!.on("data", (chunk) => {
			stdout += chunk.toString();
			const line = stdout.split("\n").find(Boolean);
			if (!line) return;
			clearTimeout(timer);
			resolvePids(JSON.parse(line));
		});
		parent.once("error", (error) => {
			clearTimeout(timer);
			rejectPids(error);
		});
	});
}

async function waitForChildCloseWithinTest(parent: ChildProcess, timeoutMs = 5_000): Promise<number> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			waitForChildClose(parent),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("timed out waiting for child close")), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function outcomeWithin(promise: Promise<unknown>, timeoutMs: number): Promise<string> {
	return Promise.race([
		promise.then(
			() => "resolved",
			(error: unknown) => `rejected: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`,
		),
		delay(timeoutMs, "pending", { ref: false }),
	]);
}

// The parent exits as soon as its grandchild starts; the grandchild inherits the parent's stdout
// and writes to it only after the test creates the release file.
function stdoutHoldingParentSource(releasePath: string, detachedGrandchild: boolean): string {
	const grandchild = `const { existsSync } = require("node:fs");
const timer = setInterval(() => {
  if (!existsSync(${JSON.stringify(releasePath)})) return;
  clearInterval(timer);
  process.stdout.write("grandchild finished\\n");
}, 20);`;
	return `const { spawn } = require("node:child_process");
const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: ["ignore", "inherit", "ignore"], detached: ${detachedGrandchild} });
console.log(JSON.stringify({ parentPid: process.pid, grandchildPid: grandchild.pid }));
grandchild.unref();`;
}

const localResumeHarnessModule = "../scripts/lib/local-resume-smoke-harness.mjs";

// Real offline Pi RPC child with the built extension: no Cursor credentials and no model turns.
async function startOfflineLocalResumeRpc(root: string) {
	const { startRpc } = await import(localResumeHarnessModule);
	const extensionPath = join(root, "rpc-lifecycle-extension.mjs");
	writeFileSync(extensionPath, `import { writeFileSync } from "node:fs";
export default function (pi) {
  writeFileSync(${JSON.stringify(join(root, "pi.pid"))}, String(process.pid));
  pi.registerCommand("rpc_lifecycle_exit", { description: "Exit before answering", handler: async () => process.exit(0) });
}
`);
	const baseEnv: NodeJS.ProcessEnv = { ...process.env, HOME: root, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1" };
	delete baseEnv.CURSOR_API_KEY;
	return startRpc({
		artifactDir: root,
		sessionDir: join(root, "sessions"),
		sessionId: "rpc-lifecycle",
		extraExtensions: [extensionPath],
		baseEnv,
	});
}

async function forceCleanupProcess(pid: number | undefined): Promise<void> {
	if (!pid || !processExists(pid)) return;
	try {
		process.kill(pid, "SIGKILL");
	} catch {}
	if (!(await waitUntilGone([pid], 2_000))) throw new Error(`failed to clean up child process ${pid}`);
}

describe("maintainer scripts shared lib", () => {

	it("builds sealed smoke env without leaking debug or setting-source state", () => {
		expect(scriptSdkEventDebugEnvNames).toEqual(sharedSdkEventDebugEnvNames);
		expect(sealedNodePath("/opt/node/bin/node", `/tmp/bin${delimiter}/usr/bin`)).toBe(`/opt/node/bin${delimiter}/tmp/bin${delimiter}/usr/bin`);
		expect(sealedNodePath("/opt/node/bin/node", "")).toBe("/opt/node/bin");
		const env = buildCursorSmokeEnv({
			baseEnv: {
				PATH: "/tmp/fake:/usr/bin",
				PI_CURSOR_SETTING_SOURCES: "all",
				PI_CURSOR_SDK_EVENT_DEBUG: "1",
				PI_CURSOR_SDK_EVENT_DEBUG_DIR: "/tmp/stale",
			},
			nodePath: "/opt/node/bin/node",
			settingSources: "none",
			nativeToolDisplay: true,
			registerNativeTools: true,
			bridge: false,
			exposeBuiltinTools: false,
		});
		expect(env.PATH).toBe(`/opt/node/bin${delimiter}/tmp/fake:/usr/bin`);
		expect(env.PI_CURSOR_SETTING_SOURCES).toBe("none");
		expect(env.PI_CURSOR_NATIVE_TOOL_DISPLAY).toBe("1");
		expect(env.PI_CURSOR_REGISTER_NATIVE_TOOLS).toBe("1");
		expect(env.PI_CURSOR_PI_TOOL_BRIDGE).toBe("0");
		expect(env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS).toBe("0");
		expect(env.PI_CURSOR_SDK_EVENT_DEBUG).toBeUndefined();
		expect(env.PI_CURSOR_SDK_EVENT_DEBUG_DIR).toBeUndefined();
		expect(() => (sharedSdkEventDebugEnvNames as unknown as string[]).push("MUTATED")).toThrow(TypeError);

		const defaultSettingsEnv = buildCursorSmokeEnv({
			baseEnv: { PATH: "/usr/bin", PI_CURSOR_SETTING_SOURCES: "none" },
			nodePath: "/opt/node/bin/node",
			settingSources: null,
		});
		expect(defaultSettingsEnv.PI_CURSOR_SETTING_SOURCES).toBeUndefined();

		const plan = buildCursorSmokeEnvPlan({
			baseEnv: { PATH: "/bin", PI_CURSOR_NATIVE_TOOL_DISPLAY: "0", PI_CURSOR_PI_TOOL_BRIDGE: "1", TERM: "bad" },
			nodePath: "/opt/node/bin/node",
		});
		expect(plan.envEntries).toEqual([]);
		expect(plan.env.PI_CURSOR_NATIVE_TOOL_DISPLAY).toBe("0");
	});

	it("serializes setting sources for child env forwarding", () => {
		expect(serializeCursorSettingSources(["all"])).toBe("all");
		expect(serializeCursorSettingSources(["project", "user"])).toBe("project,user");
		expect(serializeCursorSettingSources(undefined)).toBe("none");
		expect(serializeCursorSettingSources([])).toBe("none");
	});

	it("reads api keys from argv and process env for failure scrubbing", () => {
		expect(readArgvApiKey(["--api-key", " argv-key "])).toBe("argv-key");
		expect(readArgvApiKey(["--api-key=inline-key"])).toBe("inline-key");
		expect(readArgvApiKey(["--model", "composer-2.5"])).toBeUndefined();
		expect(apiKeySecretsFromProcess(["--api-key", "argv-key"], { CURSOR_API_KEY: "env-key" })).toEqual([
			"env-key",
			"argv-key",
		]);
	});

	it("parses common probe flags and enforces api key requirements", () => {
		expect(defaultSettingSourcesFromEnv({ PI_CURSOR_SETTING_SOURCES: "none" })).toBeUndefined();
		const fail = vi.fn((message: string) => {
			throw new Error(message);
		});
		const args = parseArgv(["--cwd", "/tmp/work", "--model", "composer-2.5", "--prompt", "hi", "--setting-sources", "none"], {
			defaults: {
				cwd: process.cwd(),
				model: "default",
				prompt: undefined,
				settingSources: defaultSettingSourcesFromEnv({ PI_CURSOR_SETTING_SOURCES: "all" }),
				apiKey: defaultApiKeyFromEnv({ CURSOR_API_KEY: "from-env" }),
			},
			flags: {
				cwd: commonProbeFlags.cwd,
				model: commonProbeFlags.model,
				prompt: commonProbeFlags.prompt,
				apiKey: commonProbeFlags.apiKey,
				settingSources: commonProbeFlags.settingSources,
			},
			fail,
		});
		expect(args).toMatchObject({
			cwd: resolve("/tmp/work"),
			model: "composer-2.5",
			prompt: "hi",
			settingSources: undefined,
			apiKey: "from-env",
		});
		const flagArgs = parseArgv(["--self-test", "--leftover-pattern", "one", "--leftover-pattern=two", "--prompt", "--starts-with-dash"], {
			defaults: { selfTest: false, leftoverPatterns: [] as string[], prompt: "" },
			flags: {
				selfTest: commonBooleanFlag("--self-test"),
				leftoverPatterns: commonRepeatStringFlag("--leftover-pattern"),
				prompt: { names: ["--prompt"], allowDashValue: true },
			},
			fail,
		});
		expect(flagArgs).toMatchObject({ selfTest: true, leftoverPatterns: ["one", "two"], prompt: "--starts-with-dash" });
		expect(() =>
			parseArgv(["--self-test=true"], {
				defaults: { selfTest: false },
				flags: { selfTest: commonBooleanFlag("--self-test") },
				fail,
			}),
		).toThrow(/--self-test does not accept a value/);

		expect(() =>
			parseArgv(["--model", "--model=bad"], {
				defaults: { model: "default" },
				flags: { model: commonProbeFlags.model },
				fail,
			}),
		).toThrow(/--model requires a value/);

		expect(requireApiKey({ apiKey: "key" }, {}, fail)).toBe("key");
		expect(() => requireApiKey({}, {}, fail)).toThrow(/Cursor API key is required/);
	});

	it("builds timestamped artifact directories under /tmp by default", () => {
		const dir = defaultTimestampedDir("pi-cursor-sdk-test-prefix");
		expect(dir.startsWith(resolve("/tmp", "pi-cursor-sdk-test-prefix-"))).toBe(true);
	});

	it("parses JSONL stdout and selects platform process-tree spawn options", () => {
		expect(parseJsonLines('{"type":"a"}\n\n{"type":"b"}\n')).toEqual([{ type: "a" }, { type: "b" }]);
		expect(CHILD_PROCESS_TREE_SPAWN_OPTIONS.detached).toBe(true);
	});

	it("allows child EOF cleanup before verified process-tree termination", async () => {
		const child = spawn(process.execPath, [
			"--input-type=module",
			"-e",
			`process.stdin.resume(); process.stdin.on("end", () => { console.log("graceful-cleanup"); process.exit(0); });`,
		], { stdio: ["pipe", "pipe", "pipe"], ...CHILD_PROCESS_TREE_SPAWN_OPTIONS });
		let stdout = "";
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk) => { stdout += chunk; });
		await terminateChild(child, { graceMs: 2_000 });
		expect(stdout).toContain("graceful-cleanup");
	}, PROCESS_TREE_TEST_TIMEOUT_MS);

	it("terminates a spawned parent and its long-lived grandchild", async () => {
		const parent = spawn(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`import { spawn } from "node:child_process";
const grandchild = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 60_000)"], { stdio: ["ignore", "pipe", "ignore"] });
grandchild.stdout.once("data", () => console.log(JSON.stringify({ parentPid: process.pid, grandchildPid: grandchild.pid })));
setInterval(() => {}, 60_000);`,
			],
			{ stdio: ["ignore", "pipe", "pipe"], ...CHILD_PROCESS_TREE_SPAWN_OPTIONS },
		);
		let grandchildPid: number | undefined;
		try {
			const pids = await readChildPids(parent);
			grandchildPid = pids.grandchildPid;
			expect(processExists(pids.parentPid)).toBe(true);
			expect(processExists(pids.grandchildPid)).toBe(true);
			await terminateChild(parent, { graceMs: 50 });
			expect(await waitUntilGone([pids.parentPid, pids.grandchildPid])).toBe(true);
		} finally {
			try {
				await terminateChild(parent, { graceMs: 500 });
			} finally {
				await forceCleanupProcess(grandchildPid);
			}
		}
	}, PROCESS_TREE_TEST_TIMEOUT_MS);

	it("terminates a live grandchild after its detached parent has exited", async () => {
		const parent = spawn(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`import { spawn } from "node:child_process";
const grandchild = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 60_000)"], { stdio: ["ignore", "pipe", "ignore"] });
grandchild.stdout.once("data", () => {
  console.log(JSON.stringify({ parentPid: process.pid, grandchildPid: grandchild.pid }));
  grandchild.stdout.destroy();
  grandchild.unref();
});`,
			],
			{ stdio: ["ignore", "pipe", "pipe"], ...CHILD_PROCESS_TREE_SPAWN_OPTIONS },
		);
		let grandchildPid: number | undefined;
		try {
			const pids = await readChildPids(parent);
			grandchildPid = pids.grandchildPid;
			expect(await waitForChildCloseWithinTest(parent)).toBe(0);
			expect(processExists(pids.parentPid)).toBe(false);
			expect(processExists(pids.grandchildPid)).toBe(true);

			await terminateChild(parent, { graceMs: 50 });

			expect(await waitUntilGone([pids.grandchildPid])).toBe(true);
		} finally {
			try {
				await terminateChild(parent, { graceMs: 500 });
			} finally {
				await forceCleanupProcess(grandchildPid);
			}
		}
	}, Math.max(30_000, PROCESS_TREE_TEST_TIMEOUT_MS));

	it("waits for stdio close, not exit, while a grandchild holds the parent's stdout", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-cursor-child-close-"));
		const releasePath = join(root, "release");
		const parent = spawn(process.execPath, ["-e", stdoutHoldingParentSource(releasePath, false)], { stdio: ["ignore", "pipe", "pipe"] });
		const exited = once(parent, "exit");
		let stdout = "";
		parent.stdout.setEncoding("utf8");
		parent.stdout.on("data", (chunk: string) => { stdout += chunk; });
		let grandchildPid: number | undefined;
		try {
			grandchildPid = (await readChildPids(parent)).grandchildPid;
			await exited;
			const closed = waitForChildClose(parent);
			expect(await outcomeWithin(closed, 200)).toBe("pending");
			writeFileSync(releasePath, "");
			expect(await closed).toBe(0);
			expect(stdout).toContain("grandchild finished");
		} finally {
			writeFileSync(releasePath, "");
			await forceCleanupProcess(grandchildPid);
			rmSync(root, { recursive: true, force: true });
		}
	}, PROCESS_TREE_TEST_TIMEOUT_MS);

	it("does not verify termination while an escaped grandchild still holds stdout", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-cursor-child-escaped-"));
		const releasePath = join(root, "release");
		const parent = spawn(
			process.execPath,
			["-e", stdoutHoldingParentSource(releasePath, true)],
			{ stdio: ["ignore", "pipe", "pipe"], ...CHILD_PROCESS_TREE_SPAWN_OPTIONS },
		);
		const exited = once(parent, "exit");
		let grandchildPid: number | undefined;
		try {
			grandchildPid = (await readChildPids(parent)).grandchildPid;
			await exited;
			await expect(terminateChild(parent, { graceMs: 100 })).rejects.toThrow("failed to verify termination of POSIX process tree");
			expect(processExists(grandchildPid)).toBe(true);
			writeFileSync(releasePath, "");
			expect(await waitForChildCloseWithinTest(parent)).toBe(0);
		} finally {
			writeFileSync(releasePath, "");
			await forceCleanupProcess(grandchildPid);
			rmSync(root, { recursive: true, force: true });
		}
	}, PROCESS_TREE_TEST_TIMEOUT_MS);

	it("rejects outstanding and later local resume RPC requests on stop, and every stop waits for termination", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-cursor-local-rpc-stop-"));
		const rpc = await startOfflineLocalResumeRpc(root);
		try {
			const sessionName = "rpc\u2028lifecycle\u2029name";
			expect((await rpc.send("set_session_name", { name: sessionName }, 60_000)).success).toBe(true);
			expect((await rpc.send("get_state", {}, 60_000)).data.sessionName).toBe(sessionName);
			const piPid = Number(readFileSync(join(root, "pi.pid"), "utf8"));
			const outstanding = rpc.send("get_state", {}, 60_000);
			const stops: Promise<boolean>[] = [rpc.stop(), rpc.stop()].map((stop: Promise<void>) => stop.then(() => processExists(piPid)));
			expect(await outcomeWithin(outstanding, 5_000)).toBe("rejected: local resume smoke RPC stopped");
			expect(await outcomeWithin(rpc.send("get_state", {}, 60_000), 5_000)).toBe("rejected: local resume smoke RPC stopped");
			expect(await Promise.all(stops)).toEqual([false, false]);
		} finally {
			await rpc.stop();
			rmSync(root, { recursive: true, force: true });
		}
	}, Math.max(30_000, PROCESS_TREE_TEST_TIMEOUT_MS));

	it("rejects outstanding and later local resume RPC requests when Pi exits", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-cursor-local-rpc-exit-"));
		const rpc = await startOfflineLocalResumeRpc(root);
		try {
			expect((await rpc.send("get_state", {}, 60_000)).success).toBe(true);
			const exitPrompt = rpc.send("prompt", { message: "/rpc_lifecycle_exit" }, 60_000);
			expect(await outcomeWithin(exitPrompt, 10_000)).toMatch(/^rejected: local resume smoke RPC exited\. Stderr:/);
			expect(await outcomeWithin(rpc.send("get_state", {}, 60_000), 5_000)).toMatch(/^rejected: local resume smoke RPC exited\. Stderr:/);
		} finally {
			await rpc.stop();
			rmSync(root, { recursive: true, force: true });
		}
	}, Math.max(30_000, PROCESS_TREE_TEST_TIMEOUT_MS));

	it("createScriptFail scrubs generic secrets before applying explicit secrets", () => {
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as typeof process.exit);
		const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const firstSecret = "super-secret-cursor-key-12345";
		const secondSecret = "another-secret-token-67890";
		const fail = createScriptFail("test-script");
		fail(
			`failed with Bearer generic-token apiKey=raw-key http://127.0.0.1:4242/cursor-pi-tool-bridge/abc/mcp ${firstSecret} and ${secondSecret}`,
			[firstSecret, secondSecret],
		);
		const output = stderr.mock.calls.join("");
		expect(stderr).toHaveBeenCalledWith(expect.stringContaining("[redacted]"));
		expect(output).toContain("Bearer [redacted]");
		expect(output).toContain("apiKey=[redacted]");
		expect(output).toContain("[redacted-bridge-endpoint]");
		expect(output).not.toContain(firstSecret);
		expect(output).not.toContain(secondSecret);
		exit.mockRestore();
		stderr.mockRestore();
	});
});
