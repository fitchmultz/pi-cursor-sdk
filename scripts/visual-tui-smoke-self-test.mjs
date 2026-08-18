import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter } from "node:path";
import { dirname, join } from "node:path";

function assertSelfTest(condition, message) {
	if (!condition) throw new Error(`self-test failed: ${message}`);
}

function envMap(assignments) {
	return new Map(assignments.map(([name, value]) => [name, value]));
}

function parseEnvCapture(path) {
	return new Map(
		readFileSync(path, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const index = line.indexOf("=");
				return index === -1 ? [line, ""] : [line.slice(0, index), line.slice(index + 1)];
			}),
	);
}

export function runVisualSmokeSelfTest(deps) {
	const { ROOT, DEFAULT_MODE, DEFAULT_MODEL, DEFAULT_SETTING_SOURCES, DEBUG_ENV_NAMES, shellQuote, parseArgs, snapshotJsonlMtimes, findLatestJsonl, sealedNodePath, resolveCommand, requireNode, requireCommand, buildLaunchPlan, run, runVisualSmoke } = deps;
	const tempDir = mkdtempSync(join(tmpdir(), "pi-cursor-sdk-visual-self-test-"));
	try {
		const binDir = join(tempDir, "bin");
		mkdirSync(binDir, { recursive: true });
		const fakePi = join(binDir, "pi");
		const fakeNode = join(binDir, "node");
		const fakeNodeMarker = join(tempDir, "fake-node-used");
		const envCapture = join(tempDir, "fake-pi.env");
		writeFileSync(
			fakePi,
			`#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(envCapture)}, Object.entries(process.env).map(([key, value]) => key + "=" + (value ?? "")).join("\\n") + "\\n", "utf8");\n`,
			"utf8",
		);
		writeFileSync(fakeNode, `#!/bin/sh\necho fake-node-used > ${shellQuote(fakeNodeMarker)}\nexit 99\n`, "utf8");
		chmodSync(fakePi, 0o755);
		chmodSync(fakeNode, 0o755);

		const promptFile = join(tempDir, "prompt.txt");
		writeFileSync(promptFile, "file prompt", "utf8");
		assertSelfTest(parseArgs(["--label", "prompt-order", "--prompt-file", promptFile, "--prompt", "inline prompt"]).prompt === "inline prompt", "--prompt should override an earlier --prompt-file");
		assertSelfTest(parseArgs(["--label", "prompt-dash", "--prompt", "--starts-with-dash"]).prompt === "--starts-with-dash", "--prompt should accept dash-prefixed free-form text");
		assertSelfTest(parseArgs(["--label", "prompt-order", "--prompt", "inline prompt", "--prompt-file", promptFile]).prompt === "file prompt", "--prompt-file should override an earlier --prompt");

		const jsonlDir = join(tempDir, "jsonl-filter");
		mkdirSync(jsonlDir, { recursive: true });
		const staleJsonl = join(jsonlDir, "stale.jsonl");
		const freshJsonl = join(jsonlDir, "fresh.jsonl");
		writeFileSync(staleJsonl, "{}\n", "utf8");
		utimesSync(staleJsonl, new Date(1_000), new Date(1_000));
		const previousJsonlMtimes = snapshotJsonlMtimes(jsonlDir);
		writeFileSync(freshJsonl, "{}\n", "utf8");
		utimesSync(freshJsonl, new Date(3_000), new Date(3_000));
		assertSelfTest(findLatestJsonl(jsonlDir, { sinceMs: 2_000, previousMtimes: previousJsonlMtimes }) === freshJsonl, "JSONL discovery should ignore unchanged stale files before run start");
		assertSelfTest(findLatestJsonl(jsonlDir, { sinceMs: 4_000, previousMtimes: snapshotJsonlMtimes(jsonlDir) }) === undefined, "JSONL discovery should not return stale evidence when current run has no changed JSONL");

		assertSelfTest(!sealedNodePath(process.execPath, "").includes(delimiter), "empty inherited PATH must not leave an empty PATH segment");
		const hostilePath = `${binDir}${delimiter}${process.env.PATH ?? ""}`;
		const sealedHostilePath = sealedNodePath(process.execPath, hostilePath);
		assertSelfTest(resolveCommand("pi", hostilePath) === fakePi, "direct PATH resolver did not prefer fake PATH head");
		assertSelfTest(requireNode() === process.execPath, "node resolver must use process.execPath");
		assertSelfTest(requireCommand("pi", { envPath: hostilePath, env: { ...process.env, PATH: sealedHostilePath } }) === fakePi, "pi prereq should use sealed PATH when executing the shim");
		assertSelfTest(!existsSync(fakeNodeMarker), "pi prereq should not use hostile fake node");

		const baseOptions = {
			ext: ROOT,
			cwd: ROOT,
			mode: DEFAULT_MODE,
			model: DEFAULT_MODEL,
			outDir: tempDir,
			safeLabel: "self-test",
			sessionDir: join(tempDir, "session"),
			sessionId: "self-test",
			settingSources: DEFAULT_SETTING_SOURCES,
			bridge: false,
			exposeBuiltinTools: false,
			eventDebug: false,
		};
		const plan = buildLaunchPlan(baseOptions, { pi: fakePi, node: process.execPath, sealedPath: sealedHostilePath }, "/bin/sh");
		const defaults = envMap(plan.envAssignments);
		assertSelfTest(defaults.get("PI_CURSOR_NATIVE_TOOL_DISPLAY") === "1", "native display must be forced on");
		assertSelfTest(defaults.get("PI_CURSOR_REGISTER_NATIVE_TOOLS") === "1", "native tool registration must be forced on");
		assertSelfTest(defaults.get("PI_CURSOR_SETTING_SOURCES") === "none", "setting sources must default to none");
		assertSelfTest(defaults.get("PI_CURSOR_PI_TOOL_BRIDGE") === "0", "bridge must default off");
		assertSelfTest(defaults.get("PI_CURSOR_EXPOSE_BUILTIN_TOOLS") === "0", "built-in exposure must default off");
		assertSelfTest(defaults.get("PI_CODING_AGENT_DIR") === join(tempDir, "pi-agent"), "agent dir must be isolated under out-dir");
		assertSelfTest(defaults.get("PI_OFFLINE") === "1", "startup network operations must be off");
		assertSelfTest(defaults.get("PI_SKIP_VERSION_CHECK") === "1", "pi.dev version check must be off");
		for (const name of DEBUG_ENV_NAMES) {
			assertSelfTest(plan.clearEnvNames.includes(name), `${name} must be cleared by default`);
		}
		assertSelfTest(plan.script.includes(shellQuote(fakePi)), "launch script must use resolved pi path");
		assertSelfTest(!plan.script.includes(" exec pi "), "launch script must not use bare pi");
		const hostileEnv = {
			...process.env,
			...Object.fromEntries(DEBUG_ENV_NAMES.map((name) => [name, join(tempDir, name)])),
			PATH: hostilePath,
			PI_CURSOR_REGISTER_NATIVE_TOOLS: "0",
			PI_CURSOR_SETTING_SOURCES: "all",
			PI_CURSOR_PI_TOOL_BRIDGE: "1",
			PI_CURSOR_EXPOSE_BUILTIN_TOOLS: "1",
		};
		const probe = run("/bin/sh", ["-c", plan.script], { env: hostileEnv });
		assertSelfTest(probe.status === 0, `fake-pi env capture exited ${probe.status}: ${probe.stderr?.toString() ?? ""}`);
		const capturedEnv = parseEnvCapture(envCapture);
		assertSelfTest(!existsSync(fakeNodeMarker), "launch PATH should force the resolved node before hostile fake node");
		assertSelfTest((capturedEnv.get("PATH") ?? "").split(delimiter)[0] === dirname(process.execPath), "captured PATH should start with resolved node directory");
		assertSelfTest(capturedEnv.get("PI_CURSOR_NATIVE_TOOL_DISPLAY") === "1", "captured env should force native display on");
		assertSelfTest(capturedEnv.get("PI_CURSOR_REGISTER_NATIVE_TOOLS") === "1", "captured env should force native registration on");
		assertSelfTest(capturedEnv.get("PI_CURSOR_SETTING_SOURCES") === "none", "captured env should force settings off");
		assertSelfTest(capturedEnv.get("PI_CURSOR_PI_TOOL_BRIDGE") === "0", "captured env should force bridge off");
		assertSelfTest(capturedEnv.get("PI_CURSOR_EXPOSE_BUILTIN_TOOLS") === "0", "captured env should force built-in exposure off");
		for (const name of DEBUG_ENV_NAMES) {
			assertSelfTest(!capturedEnv.has(name), `${name} should be absent from captured env by default`);
		}

		const optInPlan = buildLaunchPlan(
			{ ...baseOptions, settingSources: "all", bridge: true, exposeBuiltinTools: true, eventDebug: true },
			{ pi: fakePi, node: process.execPath, sealedPath: sealedHostilePath },
			"/bin/sh",
		);
		const optIns = envMap(optInPlan.envAssignments);
		assertSelfTest(optIns.get("PI_CURSOR_SETTING_SOURCES") === "all", "setting source opt-in must be reflected");
		assertSelfTest(optIns.get("PI_CURSOR_PI_TOOL_BRIDGE") === "1", "bridge opt-in must be reflected");
		assertSelfTest(optIns.get("PI_CURSOR_EXPOSE_BUILTIN_TOOLS") === "1", "built-in exposure opt-in must be reflected");
		assertSelfTest(optIns.get("PI_CURSOR_SDK_EVENT_DEBUG") === "1", "event debug opt-in must be reflected");
		assertSelfTest(optIns.get("PI_CURSOR_SDK_EVENT_DEBUG_DIR") === join(tempDir, "self-test.cursor-sdk-events"), "event debug dir must be deterministic under out-dir");
		for (const name of DEBUG_ENV_NAMES) {
			assertSelfTest(optInPlan.clearEnvNames.includes(name), `${name} must be cleared even when event debug is explicit`);
		}
		const eventDebugProbe = run("/bin/sh", ["-c", optInPlan.script], { env: hostileEnv });
		assertSelfTest(eventDebugProbe.status === 0, `fake-pi event-debug env capture exited ${eventDebugProbe.status}: ${eventDebugProbe.stderr?.toString() ?? ""}`);
		const capturedEventDebugEnv = parseEnvCapture(envCapture);
		assertSelfTest(capturedEventDebugEnv.get("PI_CURSOR_SDK_EVENT_DEBUG") === "1", "event debug should be explicitly enabled");
		assertSelfTest(capturedEventDebugEnv.get("PI_CURSOR_SDK_EVENT_DEBUG_DIR") === join(tempDir, "self-test.cursor-sdk-events"), "event debug dir should be deterministic under out-dir");
		assertSelfTest(!capturedEventDebugEnv.has("PI_CURSOR_SDK_EVENT_DEBUG_RUN_DIR"), "stale event debug run dir should be cleared");
		assertSelfTest(!capturedEventDebugEnv.has("PI_CURSOR_SDK_EVENT_DEBUG_SESSION_DIR"), "stale event debug session dir should be cleared");
		assertSelfTest(!capturedEventDebugEnv.has("PI_CURSOR_SDK_EVENT_DEBUG_STDERR"), "stale event debug stderr flag should be cleared");

		const fakeTmux = join(binDir, "tmux");
		const deleteBufferMarker = join(tempDir, "delete-buffer-called");
		writeFileSync(
			fakeTmux,
			`#!/bin/sh\ncase "$1" in\n  -V) echo 'tmux fake'; exit 0 ;;\n  new-session) exit 0 ;;\n  load-buffer) cat >/dev/null; exit 0 ;;\n  paste-buffer) exit 77 ;;\n  delete-buffer) echo deleted > ${shellQuote(deleteBufferMarker)}; exit 0 ;;\n  kill-session) exit 0 ;;\n  *) echo "unexpected tmux command: $*" >&2; exit 64 ;;\nesac\n`,
			"utf8",
		);
		chmodSync(fakeTmux, 0o755);
		const originalPath = process.env.PATH;
		try {
			process.env.PATH = hostilePath;
			let pasteFailed = false;
			try {
				runVisualSmoke({
					...baseOptions,
					prompt: "buffer cleanup prompt",
					startupMs: 1,
					waitMs: 1,
					width: 80,
					height: 24,
					historyLines: 100,
				});
			} catch (error) {
				pasteFailed = /paste-buffer failed/.test(error instanceof Error ? error.message : String(error));
			}
			assertSelfTest(pasteFailed, "fake tmux paste failure should exercise prompt-buffer cleanup path");
			assertSelfTest(existsSync(deleteBufferMarker), "prompt tmux buffer should be deleted when paste/send fails");
		} finally {
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
		}

		writeFileSync(
			fakeTmux,
			`#!/bin/sh
case "$1" in
  -V) echo 'tmux fake'; exit 0 ;;
  new-session) exit 0 ;;
  load-buffer) cat >/dev/null; exit 0 ;;
  paste-buffer) exit 0 ;;
  send-keys) exit 0 ;;
  delete-buffer) exit 0 ;;
  capture-pane) echo 'captured visual smoke output'; exit 0 ;;
  kill-session) exit 0 ;;
  *) echo "unexpected tmux command: $*" >&2; exit 64 ;;
esac
`,
			"utf8",
		);
		chmodSync(fakeTmux, 0o755);
		const noJsonlManifest = join(tempDir, "self-test-jsonl-missing.manifest.json");
		try {
			process.env.PATH = hostilePath;
			let missingJsonlFailed = false;
			let missingJsonlError = "";
			try {
				runVisualSmoke({
					...baseOptions,
					label: "self-test-jsonl-missing",
					safeLabel: "self-test-jsonl-missing",
					prompt: "jsonl failure prompt",
					startupMs: 1,
					waitMs: 1,
					width: 80,
					height: 24,
					historyLines: 100,
					sessionDir: join(tempDir, "missing-jsonl-session"),
				});
			} catch (error) {
				missingJsonlError = error instanceof Error ? error.message : String(error);
				missingJsonlFailed = /no current-run persisted \.jsonl/.test(missingJsonlError);
			}
			assertSelfTest(missingJsonlFailed, `missing JSONL should fail after partial visual artifacts are written: ${missingJsonlError || "no error"}`);
			assertSelfTest(existsSync(noJsonlManifest), "missing JSONL should still write a failure manifest");
			const manifest = JSON.parse(readFileSync(noJsonlManifest, "utf8"));
			assertSelfTest(manifest.failure?.message?.includes("no current-run persisted .jsonl"), "failure manifest should record the missing JSONL reason");
			assertSelfTest(manifest.paths?.html?.endsWith("self-test-jsonl-missing.html"), "failure manifest should point at partial HTML evidence");
		} finally {
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
		}
		console.log("[visual-smoke] self-test PASS");
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

