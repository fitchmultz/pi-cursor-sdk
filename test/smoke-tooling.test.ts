import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { parseArgs as parsePiArgs } from "../node_modules/@earendil-works/pi-coding-agent/dist/cli/args.js";
import { buildInitialMessage } from "../node_modules/@earendil-works/pi-coding-agent/dist/cli/initial-message.js";
import { CURSOR_TOOL_PRESENTATION_SPECS } from "../src/cursor-tool-presentation-registry.js";
import { getScenario, renderPrompt, SCENARIOS } from "../scripts/platform-smoke/scenarios.mjs";

function run(command: string, args: string[], env = process.env, cwd = process.cwd()) {
	return spawnSync(command, args, { cwd, encoding: "utf8", env, shell: process.platform === "win32" && command === "npm" });
}

describe("smoke tooling behavior", () => {
	it("rejects local-resume evidence from any non-packed extension path", () => {
		const code = String.raw`
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { summarizeLocalResumeEvidence } from "./scripts/platform-smoke/local-resume-runner.mjs";
const root = mkdtempSync(join(tmpdir(), "local-resume-packed-path-"));
try {
  mkdirSync(join(root, "sessions"), { recursive: true });
  mkdirSync(join(root, "debug"), { recursive: true });
  writeFileSync(join(root, "sessions", "session.jsonl"), "{}\n");
  writeFileSync(join(root, "debug", "session.json"), "{}\n");
  writeFileSync(join(root, "runtime-launches.jsonl"), [
    JSON.stringify({ extensionPath: "/work/prep/packed-workspace/node_modules/pi-cursor-sdk" }),
    JSON.stringify({ extensionPath: "/work/checkout" }),
  ].join("\n") + "\n");
  const mismatch = summarizeLocalResumeEvidence(root, "/work/prep/packed-workspace/node_modules/pi-cursor-sdk");
  writeFileSync(join(root, "runtime-launches.jsonl"), [
    JSON.stringify({ extensionPath: "C:\\work\\prep\\packed-workspace\\node_modules\\pi-cursor-sdk" }),
    JSON.stringify({ extensionPath: "c:/work/prep/packed-workspace/node_modules/pi-cursor-sdk" }),
  ].join("\n") + "\n");
  const windowsMatch = summarizeLocalResumeEvidence(root, "C:\\work\\prep\\packed-workspace\\node_modules\\pi-cursor-sdk");
  const result = { mismatch: mismatch.packedExtensionPathMatched, windowsMatch: windowsMatch.packedExtensionPathMatched };
  console.log(JSON.stringify(result));
  if (result.mismatch !== false || result.windowsMatch !== true) process.exit(1);
} finally {
  rmSync(root, { recursive: true, force: true });
}
`;
		const result = run(process.execPath, ["--input-type=module", "-e", code]);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain('{"mismatch":false,"windowsMatch":true}');
	});

	it("disables retry sync and captures full remote bundle output outside Crabbox's terminal ceiling", () => {
		const runtime = readFileSync("scripts/platform-smoke/target-runtime.mjs", "utf8");
		const crabbox = readFileSync("scripts/platform-smoke/crabbox-runner.mjs", "utf8");
		expect(runtime).toMatch(/return await run\(targetName, leaseId, command, \{ \.\.\.options, sync: false \}\);/);
		expect(runtime).toContain('{ timeout: 120_000, sync: false, config }');
		expect(runtime).toContain("metadata.path !== PLATFORM_ARTIFACT_BUNDLE_PATH");
		expect(readFileSync("scripts/platform-smoke/artifact-bundle-chunk.mjs", "utf8")).toContain("pathValue !== PLATFORM_ARTIFACT_BUNDLE_PATH");
		expect(crabbox).toContain('args.push("--capture-stdout", opts.captureStdoutPath)');
		for (const runner of ["scripts/platform-smoke/targets.mjs", "scripts/platform-smoke/local-resume-runner.mjs"]) {
			expect(readFileSync(runner, "utf8"), runner).toContain("captureStdoutPath:");
		}
	});

	it("isolates cloud smoke from user and project Cursor config", async () => {
		const artifactRoot = mkdtempSync(join(tmpdir(), "cloud-smoke-env-test-"));
		try {
			process.env.PI_CURSOR_CLOUD_REPO = "ambient/repo";
			process.env.PI_CURSOR_CLOUD_DIRECT_PUSH = "1";
			process.env.PI_CURSOR_CLOUD_AUTO_CREATE_PR = "1";
			process.env.PI_CURSOR_CLOUD_SKIP_REVIEWER_REQUEST = "1";
			process.env.PI_CURSOR_CLOUD_ENV = "SECRET";
			process.env.PI_CURSOR_CLOUD_ENV_TYPE = "pool";
			process.env.PI_CURSOR_CLOUD_ENV_NAME = "ambient-pool";
			process.env.CURSOR_CLOUD_SMOKE_ENV_TYPE = "machine";
			process.env.CURSOR_CLOUD_SMOKE_ENV_NAME = "smoke-machine";
			const {
				assertCloudSmokeEvidenceSafe,
				buildCloudSmokeEnv,
				buildCloudSmokeWorkspace,
				normalizeCloudSmokeGitHubRepo,
			} = await import("../scripts/cloud-runtime-smoke.mjs");
			const env = buildCloudSmokeEnv(artifactRoot);
			const workspace = buildCloudSmokeWorkspace(artifactRoot);
			const agentDir = env.PI_CODING_AGENT_DIR;

			expect(agentDir).toBe(join(artifactRoot, "agent"));
			expect(existsSync(agentDir!)).toBe(true);
			expect(workspace).toBe(join(artifactRoot, "workspace"));
			expect(existsSync(workspace)).toBe(true);
			expect(env.PI_CURSOR_RUNTIME).toBe("cloud");
			expect(env.PI_CURSOR_CLOUD_CONTEXT).toBe("fresh");
			expect(buildCloudSmokeEnv(artifactRoot, { contextHandoff: "bootstrap" }).PI_CURSOR_CLOUD_CONTEXT).toBe("bootstrap");
			const repoEnv = buildCloudSmokeEnv(artifactRoot, {
				repoUrl: "https://github.com/example/throwaway.git",
				startingRef: "starting-ref",
				directPush: true,
			});
			expect(repoEnv.PI_CURSOR_CLOUD_REPO).toBe("https://github.com/example/throwaway.git");
			expect(repoEnv.PI_CURSOR_CLOUD_BRANCH).toBe("starting-ref");
			expect(repoEnv.PI_CURSOR_CLOUD_DIRECT_PUSH).toBe("1");
			expect(repoEnv.PI_CURSOR_CLOUD_ENV_TYPE).toBeUndefined();
			expect(assertCloudSmokeEvidenceSafe({ schemaVersion: 1, agentId: "bc-00000000-0000-0000-0000-000000000001" }, "secret-key")).toContain('"schemaVersion": 1');
			expect(() => assertCloudSmokeEvidenceSafe({ value: "secret-key" }, "secret-key")).toThrow("secret scan");
			expect(() => assertCloudSmokeEvidenceSafe({ stdout: "safe" })).toThrow("forbidden");
			expect(normalizeCloudSmokeGitHubRepo("github.com/Example/Repo")).toBe("example/repo");
			expect(normalizeCloudSmokeGitHubRepo("https://github.com/Example/Repo.git")).toBe("example/repo");
			expect(normalizeCloudSmokeGitHubRepo("ssh://git@github.com/example/repo")).toBeUndefined();
			expect(normalizeCloudSmokeGitHubRepo("https://github.com/example/repo/more")).toBeUndefined();
			expect(env.PI_CURSOR_SETTING_SOURCES).toBe("none");
			expect(env.PI_CURSOR_CLOUD_REPO).toBeUndefined();
			expect(env.PI_CURSOR_CLOUD_DIRECT_PUSH).toBeUndefined();
			expect(env.PI_CURSOR_CLOUD_AUTO_CREATE_PR).toBeUndefined();
			expect(env.PI_CURSOR_CLOUD_SKIP_REVIEWER_REQUEST).toBeUndefined();
			expect(env.PI_CURSOR_CLOUD_ENV).toBeUndefined();
			expect(env.PI_CURSOR_CLOUD_ENV_TYPE).toBe("machine");
			expect(env.PI_CURSOR_CLOUD_ENV_NAME).toBe("smoke-machine");
		} finally {
			delete process.env.PI_CURSOR_CLOUD_REPO;
			delete process.env.PI_CURSOR_CLOUD_DIRECT_PUSH;
			delete process.env.PI_CURSOR_CLOUD_AUTO_CREATE_PR;
			delete process.env.PI_CURSOR_CLOUD_SKIP_REVIEWER_REQUEST;
			delete process.env.PI_CURSOR_CLOUD_ENV;
			delete process.env.PI_CURSOR_CLOUD_ENV_TYPE;
			delete process.env.PI_CURSOR_CLOUD_ENV_NAME;
			delete process.env.CURSOR_CLOUD_SMOKE_ENV_TYPE;
			delete process.env.CURSOR_CLOUD_SMOKE_ENV_NAME;
			rmSync(artifactRoot, { recursive: true, force: true });
		}
	});

	it("harvests exact Cloud cleanup IDs from session JSONL and framed lifecycle journals", async () => {
		const artifactRoot = mkdtempSync(join(tmpdir(), "cloud-smoke-lifecycle-test-"));
		try {
			const sessions = join(artifactRoot, "sessions");
			mkdirSync(sessions, { recursive: true });
			const firstId = "bc-00000000-0000-0000-0000-000000000001";
			const secondId = "bc-00000000-0000-0000-0000-000000000002";
			writeFileSync(join(sessions, "session.jsonl"), [
				JSON.stringify({ type: "custom", customType: "cursor-cloud-lifecycle", data: { action: "record", agentId: firstId } }),
				JSON.stringify({ type: "custom", customType: "other", data: { agentId: "bc-*" } }),
			].join("\n"));
			writeFileSync(join(sessions, ".cursor-cloud-lifecycle-test.journal"), [
				'{"partial":',
				JSON.stringify({ version: 1, action: "record", agentId: secondId }),
			].join("\n"));
			const { cloudAgentIdsFromLifecycleArtifacts } = await import("../scripts/cloud-runtime-smoke.mjs");

			expect(new Set(cloudAgentIdsFromLifecycleArtifacts(artifactRoot))).toEqual(new Set([firstId, secondId]));
		} finally {
			rmSync(artifactRoot, { recursive: true, force: true });
		}
	});

	it("forces local runtime and allows durable shutdown for local resume smoke", async () => {
		const harnessSource = readFileSync("scripts/lib/local-resume-smoke-harness.mjs", "utf8");
		expect(harnessSource).toContain("terminateChild(child, { graceMs: 15_000 })");
		const smokeSource = readFileSync("scripts/local-resume-smoke.mjs", "utf8");
		expect(smokeSource).toContain("Do not use tools or inspect files. Reply with only MARKER=<marker>.");

		const artifactRoot = mkdtempSync(join(tmpdir(), "local-resume-smoke-env-test-"));
		try {
			const { buildLocalResumeSmokeEnv } = await import("../scripts/local-resume-smoke.mjs");
			const env = buildLocalResumeSmokeEnv(artifactRoot, {
				baseEnv: {
					...process.env,
					PI_CURSOR_RUNTIME: "cloud",
					PI_CURSOR_CLOUD_ACK: "1",
					PI_CURSOR_CLOUD_REPO: "ambient/repo",
					PI_CURSOR_CLOUD_AUTO_CREATE_PR: "1",
					PI_CURSOR_CLOUD_SKIP_REVIEWER_REQUEST: "1",
					PI_CURSOR_CLOUD_ENV: "SECRET",
				},
			});

			expect(env.PI_CURSOR_RUNTIME).toBe("local");
			expect(env.PI_CURSOR_LOCAL_RESUME).toBe("1");
			expect(env.PI_CURSOR_CLOUD_ACK).toBeUndefined();
			expect(env.PI_CURSOR_CLOUD_REPO).toBeUndefined();
			expect(env.PI_CURSOR_CLOUD_AUTO_CREATE_PR).toBeUndefined();
			expect(env.PI_CURSOR_CLOUD_SKIP_REVIEWER_REQUEST).toBeUndefined();
			expect(env.PI_CURSOR_CLOUD_ENV).toBeUndefined();
			expect(env.PI_CURSOR_PI_TOOL_BRIDGE).toBe("0");
			expect(env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS).toBe("0");
			const unsetEnv = buildLocalResumeSmokeEnv(artifactRoot, { localResumeEnv: "unset", baseEnv: { ...process.env, PI_CURSOR_LOCAL_RESUME: "1" } });
			expect(unsetEnv.PI_CURSOR_LOCAL_RESUME).toBeUndefined();
			const optOutEnv = buildLocalResumeSmokeEnv(artifactRoot, { localResumeEnv: "off", baseEnv: { ...process.env, PI_CURSOR_LOCAL_RESUME: "1" } });
			expect(optOutEnv.PI_CURSOR_LOCAL_RESUME).toBe("0");
			const bridgeEnv = buildLocalResumeSmokeEnv(artifactRoot, { bridge: true, exposeBuiltinTools: true });
			expect(bridgeEnv.PI_CURSOR_PI_TOOL_BRIDGE).toBe("1");
			expect(bridgeEnv.PI_CURSOR_EXPOSE_BUILTIN_TOOLS).toBe("1");
			expect(env.PI_CODING_AGENT_DIR).toBe(join(artifactRoot, "agent"));
			expect(existsSync(env.PI_CODING_AGENT_DIR!)).toBe(true);
		} finally {
			rmSync(artifactRoot, { recursive: true, force: true });
		}
	});

	it("allows Windows VM tests more scheduling headroom without weakening normal npm tests", () => {
		const windowsBuild = readFileSync("scripts/platform-smoke/platform-build-windows.ps1", "utf8");
		expect(windowsBuild).toContain("npm.cmd run check:platform-smoke -- --testTimeout=15000");
		expect(windowsBuild).toContain("npm.cmd test -- --testTimeout=15000");
		expect(readFileSync("package.json", "utf8")).toContain('"test": "vitest run"');
	});

	it("runs and documents required platform targets sequentially to avoid shared host and API contention", () => {
		const platformSmoke = readFileSync("scripts/platform-smoke.mjs", "utf8");
		expect(platformSmoke).toContain("for (const targetName of targets)");
		expect(platformSmoke).not.toContain("Promise.all(targetRuns)");
		expect(platformSmoke).toContain("Run one or more comma-separated targets sequentially");
		const docs = readFileSync("docs/platform-smoke.md", "utf8");
		expect(docs).toContain("release-gate entrypoint runs required targets sequentially");
		expect(docs).toContain("Total wall time is therefore additive across required targets");
	});

	it("passes live prompts through Pi's interactive initial-message contract", () => {
		const liveRunner = readFileSync("scripts/platform-smoke/live-suite-runner.mjs", "utf8");
		expect(liveRunner).toContain("`platform-${args.suite}-${Date.now()}`, prompt]");
		expect(liveRunner).toContain('PI_OFFLINE: "1"');
		expect(liveRunner).toContain("file: process.execPath, args: [cliEntry, ...args]");
		expect(liveRunner).toContain("const ptyCommand = ptySpawnCommand(piArgs)");
		expect(liveRunner).toContain("...ptyCommand");
		expect(liveRunner).not.toContain("pty-spawn-command.json");
		expect(liveRunner).not.toContain("child.write(`\\x1b[200~${prompt}");
		const artifacts = readFileSync("scripts/platform-smoke/artifacts.mjs", "utf8");
		expect(artifacts).toContain("pi-command\\.json");

		const prompt = "first line\nsecond line: ' \\\" & | ; $() <> `";
		const parsed = parsePiArgs([
			"--approve", "--cursor-no-fast", "--cursor-mode", "agent", "--model", "cursor/grok-4.6",
			"--session-dir", "C:\\smoke sessions", "--session-id", "platform-test", prompt,
		]);
		expect(parsed.unknownFlags.get("cursor-no-fast")).toBe(true);
		expect(parsed.unknownFlags.get("cursor-mode")).toBe("agent");
		expect(buildInitialMessage({ parsed }).initialMessage).toBe(prompt);
		expect(parsed.messages).toEqual([]);

		const piArgs = readFileSync("node_modules/@earendil-works/pi-coding-agent/dist/cli/args.js", "utf8");
		expect(piArgs).toContain("# Interactive mode with initial prompt");
		expect(piArgs).toContain('${APP_NAME} "List all .ts files in src/"');
		expect(piArgs).toContain("PI_OFFLINE");
		expect(piArgs).toContain("Disable startup network operations");
	});

	it("keeps assistant final markers out of rendered live prompts", () => {
		for (const scenario of Object.values(SCENARIOS)) {
			if (!(scenario.finalMarker && scenario.promptTemplate)) continue;
			const promptScenario = { ...scenario, promptTemplate: scenario.promptTemplate };
			for (const platform of ["posix", "powershell"] as const) {
				expect(renderPrompt(promptScenario, platform)).not.toContain(scenario.finalMarker);
			}
		}
	});

	it("keeps the required HTTP/1.1 live lane explicit", () => {
		const scenario = getScenario("cursor-http1-live");
		expect(scenario).toMatchObject({
			cursorCalls: 1,
			finalMarker: "HTTP1_LIVE_OK",
			requiredCards: ["http1-status"],
			env: { PI_CURSOR_HTTP_1_1: "1", PI_CURSOR_PI_TOOL_BRIDGE: "0", PI_CURSOR_SDK_EVENT_DEBUG: "1" },
		});
	});

	it("rejects invalid platform smoke targets and suites before Crabbox runs", () => {
		const invalidTarget = run(process.execPath, ["scripts/platform-smoke.mjs", "run", "--target", "plan9"]);
		expect(invalidTarget.status).toBe(2);
		expect(invalidTarget.stderr).toContain("unknown target(s): plan9");
		expect(invalidTarget.stderr).toContain("macos, ubuntu, windows-native");

		const invalidSuite = run(process.execPath, ["scripts/platform-smoke.mjs", "run", "--suite", "stdout-only"]);
		expect(invalidSuite.status).toBe(2);
		expect(invalidSuite.stderr).toContain("unknown suite(s): stdout-only");
		expect(invalidSuite.stderr).toContain("platform-build");
	});

	it("keeps card and bundle evidence checks strict against prompt/path false positives", () => {
		const code = String.raw`
import { detectCards, assertRequiredCards } from "./scripts/platform-smoke/card-detect.mjs";
import { isSafeBundlePath } from "./scripts/platform-smoke/targets.mjs";
const promptOnly = detectCards("1. call pi__read on ./package.json\n2. grep ./README.md\n");
const rendered = detectCards("read /workspace/pi-cursor-sdk/package.json\ngrep /pi-cursor-sdk/ in C:/workspace/README.md\nbridge visual smoke\nENOENT: no such file or directory\ncursor:local · fast:off · http1\ngrok-4.6\n");
const wrapped = detectCards("read /workspace/very-long-test-workspace/package.js\non\n");
const wrappedMidToken = detectCards("read /workspace/very-long-test-workspace/package.j\nson\n");
const localPreview = detectCards("read package.json · local file preview\n");
const checks = assertRequiredCards(".", rendered, ["bridge-read-success", "grep", "bridge-shell-success", "bridge-read-failure", "http1-status", "footer-status"]);
const wrappedChecks = assertRequiredCards(".", wrapped, ["bridge-read-success"]);
const wrappedMidTokenChecks = assertRequiredCards(".", wrappedMidToken, ["bridge-read-success"]);
const localPreviewChecks = assertRequiredCards(".", localPreview, ["read"]);
const result = {
  promptCardCount: promptOnly.length,
  renderedOk: checks.every((check) => check.ok),
  wrappedOk: wrappedChecks.every((check) => check.ok) && wrappedMidTokenChecks.every((check) => check.ok),
  localPreviewOk: localPreviewChecks.every((check) => check.ok),
  traversalRejected: !isSafeBundlePath("/tmp/platform-smoke-suite", "../outside.txt"),
  absoluteRejected: !isSafeBundlePath("/tmp/platform-smoke-suite", "/tmp/outside.txt"),
  normalAccepted: isSafeBundlePath("/tmp/platform-smoke-suite", "artifacts/terminal.txt"),
};
console.log(JSON.stringify(result));
if (result.promptCardCount !== 0 || !result.renderedOk || !result.wrappedOk || !result.localPreviewOk || !result.traversalRejected || !result.absoluteRejected || !result.normalAccepted) process.exit(1);
`;
		const result = run(process.execPath, ["--input-type=module", "-e", code]);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain('"promptCardCount":0');
		expect(result.stdout).toContain('"renderedOk":true');
		expect(result.stdout).toContain('"localPreviewOk":true');
		expect(result.stdout).toContain('"traversalRejected":true');
	});

	it("prunes old platform smoke run artifacts without touching recent or non-run directories", () => {
		const code = String.raw`
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { prunePlatformSmokeArtifacts } from "./scripts/platform-smoke/artifacts.mjs";
const root = mkdtempSync(join(tmpdir(), "platform-smoke-prune-test-"));
const nowMs = 2_000_000_000_000;
const hourMs = 60 * 60 * 1000;
function runDir(ageHours, suffix) {
  const dir = join(root, "run-" + (nowMs - ageHours * hourMs) + "-" + suffix);
  mkdirSync(dir, { recursive: true });
  return dir;
}
const staleByAge = runDir(24 * 20, "staleage");
const staleByCount = runDir(24 * 5, "stalecount");
const keepOlder = runDir(24 * 4, "keepolder");
const keepNewest = runDir(24 * 3, "keepnewest");
const keepRecent = runDir(1, "keeprecent");
const ignored = join(root, "manual-notes");
mkdirSync(ignored);
try {
  const pruned = prunePlatformSmokeArtifacts(root, { maxRunDirs: 3, maxAgeDays: 14, preserveRecentHours: 24 }, { nowMs });
  const removed = pruned.removed.map((name) => basename(name));
  const result = {
    removed,
    staleByAgeGone: !existsSync(staleByAge),
    staleByCountGone: !existsSync(staleByCount),
    keepOlderExists: existsSync(keepOlder),
    keepNewestExists: existsSync(keepNewest),
    keepRecentExists: existsSync(keepRecent),
    ignoredExists: existsSync(ignored),
  };
  console.log(JSON.stringify(result));
  if (!result.staleByAgeGone || !result.staleByCountGone || !result.keepOlderExists || !result.keepNewestExists || !result.keepRecentExists || !result.ignoredExists) process.exit(1);
} finally {
  rmSync(root, { recursive: true, force: true });
}
`;
		const result = run(process.execPath, ["--input-type=module", "-e", code]);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain('"staleByAgeGone":true');
		expect(result.stdout).toContain('"staleByCountGone":true');
		expect(result.stdout).toContain('"keepRecentExists":true');
	});

	it("writes an agent-readable latest platform smoke artifact index", () => {
		const code = String.raw`
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { platformSmokeSuiteEvidence, writeLatestPlatformSmokeIndex } from "./scripts/platform-smoke/artifacts.mjs";
const root = mkdtempSync(join(tmpdir(), "platform-smoke-latest-test-"));
try {
  const suiteDir = join(root, "run-2000-abc123", "macos", "cursor-native-visual-matrix");
  mkdirSync(join(suiteDir, "artifacts"), { recursive: true });
  mkdirSync(join(suiteDir, "cursor-sdk-events", "sessions", "s1"), { recursive: true });
  mkdirSync(join(suiteDir, "local-resume-evidence"), { recursive: true });
  writeFileSync(join(suiteDir, "target.json"), JSON.stringify({ targetName: "macos", runId: "run-2000-abc123" }));
  writeFileSync(join(suiteDir, "suite.json"), JSON.stringify({ suiteName: "cursor-native-visual-matrix" }));
  writeFileSync(join(suiteDir, "summary.json"), JSON.stringify({ ok: false, target: "macos", suite: "cursor-native-visual-matrix" }));
  writeFileSync(join(suiteDir, "assertions.json"), JSON.stringify({ ok: false }));
  writeFileSync(join(suiteDir, "failures.md"), "failed\n");
  writeFileSync(join(suiteDir, "artifact-manifest.json"), "{}\n");
  writeFileSync(join(suiteDir, "artifacts", "terminal.html"), "<html></html>");
  writeFileSync(join(suiteDir, "artifacts", "terminal.full.png"), "png");
  writeFileSync(join(suiteDir, "artifacts", "visual-evidence.json"), "{}\n");
  writeFileSync(join(suiteDir, "artifacts", "session.jsonl"), "{}\n");
  writeFileSync(join(suiteDir, "cursor-sdk-events", "sessions", "s1", "session.json"), "{}\n");
  writeFileSync(join(suiteDir, "local-resume-evidence.json"), "{}\n");
  writeFileSync(join(suiteDir, "local-resume-evidence", "runtime-launches.jsonl"), "{}\n");
  const latest = writeLatestPlatformSmokeIndex({ artifactRoot: root }, [{ targetName: "macos", result: { ok: false, results: [{ ok: false, suiteDir }] } }], {
    startedAt: "start",
    finishedAt: "finish",
    command: { targets: ["macos"], suites: ["cursor-native-visual-matrix"] },
  });
  const index = JSON.parse(readFileSync(join(root, "latest.json"), "utf8"));
  const evidence = platformSmokeSuiteEvidence({ ok: false, suiteDir }, root);
  const errorLatest = writeLatestPlatformSmokeIndex({ artifactRoot: root }, [{ targetName: "ubuntu", result: { ok: false, error: "boom" } }], {});
  const errorIndex = JSON.parse(readFileSync(errorLatest.path, "utf8"));
  const result = {
    latestPathEnds: latest.path.endsWith("latest.json"),
    runId: index.runId,
    timestamps: index.startedAt === "start" && index.finishedAt === "finish",
    suitePath: index.targets[0].suites[0].paths.terminalHtml,
    providerDebugCount: index.targets[0].suites[0].paths.providerDebugArtifacts.length,
    providerDebugTotal: index.targets[0].suites[0].paths.providerDebugArtifactCount,
    localResumeEvidence: index.targets[0].suites[0].paths.localResumeEvidence,
    localResumeRuntime: index.targets[0].suites[0].paths.localResumeRuntimeLaunches,
    evidenceFailures: evidence.paths.failures,
    targetError: errorIndex.targets[0].error,
  };
  console.log(JSON.stringify(result));
  if (!result.latestPathEnds || result.runId !== "run-2000-abc123" || !result.timestamps || !result.suitePath.endsWith("terminal.html") || result.providerDebugCount !== 1 || result.providerDebugTotal !== 1 || !result.localResumeEvidence.endsWith("local-resume-evidence.json") || !result.localResumeRuntime.endsWith("runtime-launches.jsonl") || !result.evidenceFailures.endsWith("failures.md") || result.targetError !== "boom") process.exit(1);
} finally {
  rmSync(root, { recursive: true, force: true });
}
`;
		const result = run(process.execPath, ["--input-type=module", "-e", code]);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain('"runId":"run-2000-abc123"');
		expect(result.stdout).toContain('"providerDebugCount":1');
	});

	it("fails suite artifacts when required manifests or lease cleanup are missing", () => {
		const code = String.raw`
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { finalizeSuiteArtifacts, createLeaseCleanupFailureResult } from "./scripts/platform-smoke/targets.mjs";
const root = mkdtempSync(join(tmpdir(), "platform-smoke-manifest-test-"));
try {
  const suiteDir = join(root, "suite");
  await import("node:fs").then(({ mkdirSync }) => mkdirSync(suiteDir, { recursive: true }));
  writeFileSync(join(suiteDir, "present.txt"), "ok");
  const finalized = finalizeSuiteArtifacts(
    suiteDir,
    [{ id: "base-ok", fn: () => true }],
    { target: "unit", suite: "manifest", exitCode: 0, elapsedMs: 1 },
    ["summary.json", "assertions.json", "present.txt", "missing.txt"],
  );
  const manifest = JSON.parse(readFileSync(join(suiteDir, "artifact-manifest.json"), "utf8"));
  const cleanup = createLeaseCleanupFailureResult({ artifactRoot: root, packageName: "pi-cursor-sdk" }, "ubuntu", "cbx_failed", {
    stdout: "",
    stderr: "stop failed",
    code: 1,
    signal: null,
  });
  const cleanupAssertions = JSON.parse(readFileSync(join(cleanup.suiteDir, "assertions.json"), "utf8"));
  const result = {
    manifestOk: finalized.assertions.ok,
    missing: manifest.missing,
    cleanupOk: cleanup.ok,
    cleanupAssertionOk: cleanupAssertions.ok,
    cleanupHasStopFailure: cleanupAssertions.checks.some((check) => check.id === "lease-stop" && check.ok === false),
  };
  console.log(JSON.stringify(result));
  if (result.manifestOk || !result.missing.includes("missing.txt") || result.cleanupOk || result.cleanupAssertionOk || !result.cleanupHasStopFailure) process.exit(1);
} finally {
  rmSync(root, { recursive: true, force: true });
}
`;
		const result = run(process.execPath, ["--input-type=module", "-e", code]);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain('"manifestOk":false');
		expect(result.stdout).toContain('"missing.txt"');
		expect(result.stdout).toContain('"cleanupHasStopFailure":true');
	});

	it("requires platform final markers in the last non-empty assistant text part", () => {
		const code = String.raw`
import { extractContentText, extractFinalTextContent, jsonlHasAssistantFinalTextMarker } from "./scripts/platform-smoke/jsonl-text.mjs";
import { hasAbortSuccessClaim } from "./scripts/platform-smoke/targets.mjs";
const content = [
  { type: "text", text: "LIVE TEST PASS only appeared in progress\n" },
  { type: "thinking", thinking: "tool metadata" },
  { type: "text", text: "   \n" },
  { type: "text", text: "actual final report" },
];
const raw = JSON.stringify({ message: { role: "assistant", content } }) + "\n";
const abortRaw = JSON.stringify({ message: { role: "assistant", content: [
  { type: "thinking", thinking: "wait for the tool to complete" },
  { type: "text", text: "aborting now" },
] } }) + "\n";
const result = {
  allTextIncludesMarker: extractContentText(content).includes("LIVE TEST PASS"),
  finalText: extractFinalTextContent(content),
  markerAccepted: jsonlHasAssistantFinalTextMarker(raw, "LIVE TEST PASS"),
  abortSuccessClaim: hasAbortSuccessClaim(abortRaw),
};
console.log(JSON.stringify(result));
if (!result.allTextIncludesMarker || result.finalText !== "actual final report" || result.markerAccepted || result.abortSuccessClaim) process.exit(1);
`;
		const result = run(process.execPath, ["--input-type=module", "-e", code]);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain('"allTextIncludesMarker":true');
		expect(result.stdout).toContain('"finalText":"actual final report"');
		expect(result.stdout).toContain('"markerAccepted":false');
		expect(result.stdout).toContain('"abortSuccessClaim":false');
	});

	it("asserts rendered visual evidence patterns from output lines rather than prompt text", () => {
		const code = String.raw`
import { getScenario } from "./scripts/platform-smoke/scenarios.mjs";
import { findVisualEvidenceItems } from "./scripts/platform-smoke/visual-evidence.mjs";
const positive = findVisualEvidenceItems([
  "read ./package.json",
  "native shell failure",
], [
  { id: "read", pattern: "^\\s*read \\./package\\.json" },
  { id: "failure", pattern: "^\\s*native shell failure\\s*$" },
]);
const promptOnly = findVisualEvidenceItems([
  "1. call pi__read on ./package.json",
], [
  { id: "read", pattern: "^\\s*read \\./package\\.json" },
]);
const wrapped = findVisualEvidenceItems([
  "read /workspace/very-long-test-workspace/package.j",
  "son",
], [
  { id: "read", pattern: "^\\s*read \\./package\\.json", wrappedPattern: "^\\s*read\\s+.*[\\\\/]package\\.(?:json|js\\s+on|j\\s*son)\\s*$" },
]);
const nativeReadSpec = getScenario("cursor-native-visual-matrix").visualEvidence.find((item) => item.id === "native-read-package");
const localPreview = findVisualEvidenceItems(["read package.json · local file preview"], [nativeReadSpec]);
const positiveItemsOk = positive.every((item) => item.ok === true);
console.log(JSON.stringify({ positiveItemsOk, promptOnlyItemOk: promptOnly[0]?.ok ?? null, wrappedItemOk: wrapped[0]?.ok ?? null, localPreviewItemOk: localPreview[0]?.ok ?? null }));
if (!positiveItemsOk || promptOnly[0]?.ok !== false || wrapped[0]?.ok !== true || localPreview[0]?.ok !== true) process.exit(1);
`;
		const result = run(process.execPath, ["--input-type=module", "-e", code]);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain('"positiveItemsOk":true');
		expect(result.stdout).toContain('"promptOnlyItemOk":false');
		expect(result.stdout).toContain('"localPreviewItemOk":true');
	});

	it("classifies every Cursor tool presentation surface for platform visual coverage", () => {
		const classified = {
			coveredByNativeVisualMatrix: ["read", "grep", "glob", "shell", "edit", "write"],
			coveredByBridgeVisualMatrix: ["shell", "read"],
			excludedFromPlatformVisualMatrix: ["ls", "delete", "readLints", "updateTodos", "createPlan", "task", "generateImage", "mcp", "semSearch", "recordScreen", "webSearch", "webFetch"],
		};
		const allClassified = new Set([
			...classified.coveredByNativeVisualMatrix,
			...classified.coveredByBridgeVisualMatrix,
			...classified.excludedFromPlatformVisualMatrix,
		]);
		const registryNames = CURSOR_TOOL_PRESENTATION_SPECS.map((spec) => spec.normalizedName);
		expect(new Set(registryNames)).toEqual(allClassified);
	});

});
