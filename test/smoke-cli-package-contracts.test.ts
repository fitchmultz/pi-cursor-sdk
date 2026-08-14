import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";
import { LOCAL_RESUME_SUITES } from "../scripts/platform-smoke/local-resume-suites.mjs";

function run(command: string, args: string[], env = process.env, cwd = process.cwd()) {
	return spawnSync(command, args, { cwd, encoding: "utf8", env, shell: process.platform === "win32" && command === "npm" });
}

describe("smoke CLI and package contracts", () => {
	it("keeps smoke helper syntax and help paths working without live Cursor auth", () => {
		expect(run("bash", ["-n", "scripts/lib/cursor-smoke-shell.sh"]).status).toBe(0);
		expect(run("bash", ["-n", "scripts/tmux-live-smoke.sh"]).status).toBe(0);
		expect(run("bash", ["-n", "scripts/isolated-cursor-smoke.sh"]).status).toBe(0);
		expect(run(process.execPath, ["--check", "scripts/steering-rpc-smoke.mjs"]).status).toBe(0);
		expect(run(process.execPath, ["--check", "scripts/visual-tui-smoke.mjs"]).status).toBe(0);
		expect(run(process.execPath, ["--check", "scripts/visual-tui-smoke-self-test.mjs"]).status).toBe(0);
		expect(run(process.execPath, ["--check", "scripts/lib/cursor-visual-manifest.mjs"]).status).toBe(0);
		expect(run(process.execPath, ["--check", "scripts/validate-smoke-jsonl.mjs"]).status).toBe(0);
		expect(run(process.execPath, ["--check", "scripts/debug-sdk-events.mjs"]).status).toBe(0);
		expect(run(process.execPath, ["--check", "scripts/debug-provider-events.mjs"]).status).toBe(0);
		expect(run(process.execPath, ["--check", "scripts/local-resume-smoke.mjs"]).status).toBe(0);
		expect(run(process.execPath, ["--check", "scripts/lib/local-resume-smoke-harness.mjs"]).status).toBe(0);
		expect(run(process.execPath, ["--check", "scripts/platform-smoke.mjs"]).status).toBe(0);
		expect(run(process.execPath, ["--check", "scripts/platform-smoke/doctor.mjs"]).status).toBe(0);
		expect(run(process.execPath, ["--check", "scripts/platform-smoke/live-suite-runner.mjs"]).status).toBe(0);
		expect(run(process.execPath, ["--check", "scripts/platform-smoke/local-resume-runner.mjs"]).status).toBe(0);
		expect(run(process.execPath, ["--check", "scripts/platform-smoke/target-runtime.mjs"]).status).toBe(0);
		expect(run(process.execPath, ["--check", "scripts/platform-smoke/targets.mjs"]).status).toBe(0);

		const liveHelp = process.platform === "win32" ? undefined : run("scripts/tmux-live-smoke.sh", ["--help"]);
		const isolatedHelp = process.platform === "win32" ? undefined : run("scripts/isolated-cursor-smoke.sh", ["--help"]);
		const steeringHelp = run(process.execPath, ["scripts/steering-rpc-smoke.mjs", "--help"]);
		const visualHelp = run(process.execPath, ["scripts/visual-tui-smoke.mjs", "--help"]);
		const jsonlHelp = run(process.execPath, ["scripts/validate-smoke-jsonl.mjs", "--help"]);
		const sdkEventsHelp = run(process.execPath, ["scripts/debug-sdk-events.mjs", "--help"]);
		const providerEventsHelp = run(process.execPath, ["scripts/debug-provider-events.mjs", "--help"]);
		const platformLiveHelp = run(process.execPath, ["scripts/platform-smoke/live-suite-runner.mjs", "--help"]);
		const cloudHelp = run(process.execPath, ["scripts/cloud-runtime-smoke.mjs", "--help"]);
		const localResumeHelp = run(process.execPath, ["scripts/local-resume-smoke.mjs", "--help"]);

		if (process.platform !== "win32") {
			expect(liveHelp!.status).toBe(0);
			expect(liveHelp!.stdout).toContain("retry-empty-output");
			expect(liveHelp!.stdout).toContain("--self-test");
			expect(isolatedHelp!.status).toBe(0);
			expect(isolatedHelp!.stdout).toContain("plan-strip");
			expect(isolatedHelp!.stdout).toContain("--self-test");
		}
		expect(steeringHelp.status).toBe(0);
		expect(steeringHelp.stdout).toContain("RPC steering smoke");
		expect(visualHelp.status).toBe(0);
		expect(visualHelp.stdout).toContain("Canonical offscreen TUI visual smoke runner");
		expect(visualHelp.stdout).toContain("PI_CURSOR_REGISTER_NATIVE_TOOLS=1");
		expect(visualHelp.stdout).toContain("--expose-builtin-tools");
		expect(jsonlHelp.status).toBe(0);
		expect(jsonlHelp.stdout).toContain("Validate assistant presence");
		expect(jsonlHelp.stdout).toContain("--replay-errors");
		expect(sdkEventsHelp.status).toBe(0);
		expect(sdkEventsHelp.stdout).toContain("Capture timestamped Cursor SDK event timelines");
		expect(providerEventsHelp.status).toBe(0);
		expect(providerEventsHelp.stdout).toContain("Capture raw Cursor SDK onDelta/onStep payloads through pi's provider path");
		expect(platformLiveHelp.status).toBe(0);
		expect(platformLiveHelp.stdout).toContain("--prep-dir");
		expect(cloudHelp.status).toBe(0);
		expect(cloudHelp.stdout).toContain("--context-matrix");
		expect(cloudHelp.stdout).toContain("private throwaway GitHub repository");
		expect(cloudHelp.stdout).toContain("direct push");
		expect(cloudHelp.stdout).toContain("lifecycle delete");
		expect(cloudHelp.stdout).toContain("2  invalid command-line usage");
		expect(localResumeHelp.status).toBe(0);
		expect(localResumeHelp.stdout).toContain("smoke:local-resume");
		expect(localResumeHelp.stdout).toContain("--safety");
		expect(localResumeHelp.stdout).toContain("--tool-surface");
		expect(localResumeHelp.stdout).toContain("--abort");
		expect(localResumeHelp.stdout).toContain("--tree");
		expect(localResumeHelp.stdout).toContain("--copy-switch");
		expect(localResumeHelp.stdout).toContain("--fallback");
		expect(localResumeHelp.stdout).toContain("--compaction");
		expect(localResumeHelp.stdout).toContain("--default-dry-run");
		expect(localResumeHelp.stdout).toContain("--cleanup");
		expect(localResumeHelp.stdout).toContain("2  invalid command-line usage");

		if (process.platform !== "win32") {
			const failedCommand = run("bash", [
				"-c",
				"set -e; . scripts/lib/cursor-smoke-shell.sh; smoke_run_with_timeout_or_fail repro 1 bash -c 'exit 42'",
			]);
			expect(failedCommand.status).toBe(1);
			expect(failedCommand.stderr).toContain("repro exited 42");
		}

		if (process.platform !== "win32") {
			const visualSelfTest = run(process.execPath, ["scripts/visual-tui-smoke.mjs", "--self-test"]);
			expect(visualSelfTest.status).toBe(0);
			expect(visualSelfTest.stdout).toContain("self-test PASS");
		}
		if (process.platform !== "win32") {
			const steeringSelfTest = run(process.execPath, ["scripts/steering-rpc-smoke.mjs", "--self-test"]);
			expect(steeringSelfTest.status).toBe(0);
			expect(steeringSelfTest.stdout).toContain("self-test PASS");
		}
		if (process.platform !== "win32") {
			const liveSelfTest = run("scripts/tmux-live-smoke.sh", ["--self-test"]);
			expect(liveSelfTest.status).toBe(0);
			expect(liveSelfTest.stdout).toContain("self-test PASS");
			const isolatedSelfTest = run("scripts/isolated-cursor-smoke.sh", ["--self-test"]);
			expect(isolatedSelfTest.status).toBe(0);
			expect(isolatedSelfTest.stdout).toContain("self-test PASS");
		}
		const invalidVisualArgs = run(process.execPath, ["scripts/visual-tui-smoke.mjs", "--label", "bad", "--prompt", "bad", "--expose-builtin-tools"]);
		expect(invalidVisualArgs.status).toBe(2);
		expect(invalidVisualArgs.stderr).toContain("--expose-builtin-tools requires --bridge");
	}, 90_000);

	it("waits for final RPC settlement instead of a low-level run end", () => {
		for (const path of [
			"scripts/cloud-runtime-smoke.mjs",
			"scripts/debug-provider-events.mjs",
			"scripts/lib/local-resume-smoke-harness.mjs",
			"scripts/steering-rpc-smoke.mjs",
		]) {
			const source = readFileSync(path, "utf8");
			expect(source).toContain("agent_settled");
			expect(source).not.toContain("agent_end");
		}
	});

	it("keeps the required paid cloud matrix CLI contract and helper surface", () => {
		const entrypointSource = readFileSync("scripts/cloud-runtime-smoke.mjs", "utf8");
		const runnerSource = readFileSync("scripts/lib/cloud-smoke-pi-runner.mjs", "utf8");
		const source = `${entrypointSource}\n${runnerSource}`;
		const help = run(process.execPath, ["scripts/cloud-runtime-smoke.mjs", "--help"]);
		expect(help.status).toBe(0);
		expect(help.stdout).toContain("npm run smoke:cloud");
		expect(help.stdout).toContain("--context-matrix");
		expect(help.stdout).toContain("CURSOR_API_KEY");
		expect(source).toContain('"--session-dir"');
		expect(source).toContain('"--session-id"');
		expect(source).not.toContain('"--no-session"');
		for (const anchor of [
			"runCancelLane",
			"runBranchAndLifecycleLane",
			"runDirectPushLane",
			"runMissingBranchLane",
			"accountConditionalLane",
			"coordinateCloudSmokeReleaseGate",
			"installCloudSmokeSignalHandlers",
			"cloudSmokeShutdown",
			"deleteThrowawayRepository",
			"cursor-cloud-smoke-matrix-latest.json",
			"buildCloudSmokeEvidenceProvenance",
			"projectCloudSmokeMatrixEvidence",
			"listCloudSmokePackageSourcePaths",
		]) expect(source, anchor).toContain(anchor);
		// Helper modules are loaded by the entrypoint; CLI and child-transport contracts stay source-shape only.
		expect(source).toContain('from "./lib/cloud-smoke-cleanup-evidence.mjs"');
		expect(source).toContain('from "./lib/cloud-smoke-artifacts.mjs"');
		expect(source).toContain('from "./lib/cloud-smoke-pi-runner.mjs"');
		expect(source).toContain('from "./lib/cloud-smoke-github.mjs"');
		expect(source).toContain('from "./lib/cloud-smoke-shutdown.mjs"');
		for (const shutdownAnchor of [
			"timeoutTermination = terminateChild(child)",
			"stopCloudSmokeTrackedChild(",
			"() => terminateChild(child, { graceMs: 15_000 })",
			"createCloudSmokeTerminalFailureState(rejectPending)",
			"installCloudSmokeChildErrorHandlers(",
			"const routeRpcError = installCloudSmokeChildErrorHandlers(",
			"throwIfFailed: terminalState.throwIfFailed",
			"process.exitCode = 1",
		]) expect(source, shutdownAnchor).toContain(shutdownAnchor);
		expect(source).toContain('child.stdin.write(`${JSON.stringify({ id, type, ...extra })}\\n`);');
		expect(source).toContain("routeRpcError(error);");
		expect(source).toContain("installCloudSmokeSignalHandlers(cloudSmokeShutdown, process, () => { process.exitCode = 1; })");
		expect(source).not.toContain("removeSignalHandlers");
		expect(source.match(/await checkpointCloudSmokeShutdown\(cloudSmokeShutdown\)/g)).toHaveLength(3);
		const stageIndex = source.indexOf("const temporary = stageEvidenceSummary(summary)");
		const preCommitCheckpointIndex = source.indexOf("await checkpointCloudSmokeShutdown(cloudSmokeShutdown)", stageIndex);
		const commitIndex = source.indexOf("commitEvidenceSummary(temporary)", preCommitCheckpointIndex);
		const postCoordinatorCheckpointIndex = source.indexOf("await checkpointCloudSmokeShutdown(cloudSmokeShutdown)", commitIndex);
		const artifactRemovalIndex = source.indexOf("rmSync(artifactRoot", postCoordinatorCheckpointIndex);
		const finalCheckpointIndex = source.indexOf("await checkpointCloudSmokeShutdown(cloudSmokeShutdown)", artifactRemovalIndex);
		const failureIndex = source.indexOf("if (failure) throw failure", finalCheckpointIndex);
		const successMarkerIndex = source.indexOf("console.log(contextMatrix ?", failureIndex);
		expect(stageIndex).toBeGreaterThan(0);
		expect(preCommitCheckpointIndex).toBeGreaterThan(stageIndex);
		expect(commitIndex).toBeGreaterThan(preCommitCheckpointIndex);
		expect(postCoordinatorCheckpointIndex).toBeGreaterThan(commitIndex);
		expect(artifactRemovalIndex).toBeGreaterThan(postCoordinatorCheckpointIndex);
		expect(finalCheckpointIndex).toBeGreaterThan(artifactRemovalIndex);
		expect(failureIndex).toBeGreaterThan(finalCheckpointIndex);
		expect(successMarkerIndex).toBeGreaterThan(failureIndex);
	});

	it("rejects paid smoke typos and repeated or conflicting lanes before auth or runs", () => {
		const env: NodeJS.ProcessEnv = {
			...process.env,
			CURSOR_LOCAL_RESUME_SMOKE_TIMEOUT_MS: "-1",
		};
		delete env.CURSOR_API_KEY;
		const cases = [
			{
				args: ["scripts/local-resume-smoke.mjs", "--safty"],
				expected: "unknown argument(s): --safty",
			},
			{
				args: ["scripts/local-resume-smoke.mjs", "--safety", "--safety"],
				expected: "only one smoke lane may be selected",
			},
			{
				args: ["scripts/local-resume-smoke.mjs", "--safety", "--tree"],
				expected: "only one smoke lane may be selected",
			},
			{
				args: ["scripts/cloud-runtime-smoke.mjs", "--context-matix"],
				expected: "unknown argument(s): --context-matix",
			},
			{
				args: ["scripts/cloud-runtime-smoke.mjs", "--context-matrix", "--context-matrix"],
				expected: "only one smoke lane may be selected",
			},
		];
		for (const testCase of cases) {
			const result = run(process.execPath, testCase.args, env);
			expect(result.status, testCase.args.join(" ")).toBe(2);
			expect(result.stderr).toContain("usage error");
			expect(result.stderr).toContain(testCase.expected);
			expect(result.stderr).not.toContain("CURSOR_API_KEY is required");
			expect(result.stderr).not.toContain("CURSOR_LOCAL_RESUME_SMOKE_TIMEOUT_MS");
		}
	});

	it("scrubs API keys from offline cloud and local-resume CLI validation errors", () => {
		const apiKey = "cursor-offline-smoke-secret-12345";
		const env = { ...process.env, CURSOR_API_KEY: apiKey };
		for (const script of ["scripts/cloud-runtime-smoke.mjs", "scripts/local-resume-smoke.mjs"]) {
			const result = run(process.execPath, [script, `--${apiKey}`], env);
			expect(result.status, script).toBe(2);
			expect(result.stderr).toContain("usage error");
			expect(result.stderr).toContain("[redacted]");
			expect(result.stderr).not.toContain(apiKey);
		}
	});

	it("rejects invalid platform paid-run arguments before artifacts or target runners", () => {
		const cwd = mkdtempSync(join(tmpdir(), "platform-smoke-cli-test-"));
		const staleRun = join(cwd, ".artifacts", "platform-smoke", "run-1-stale");
		const sentinel = join(staleRun, "sentinel.txt");
		const loadedMarker = join(cwd, "targets-loaded.txt");
		const loader = join(cwd, "load-observer.mjs");
		mkdirSync(staleRun, { recursive: true });
		writeFileSync(sentinel, "keep");
		writeFileSync(loader, `import { appendFileSync } from "node:fs";\nexport async function load(url, context, nextLoad) {\n  if (url.endsWith("/scripts/platform-smoke/targets.mjs")) appendFileSync(${JSON.stringify(loadedMarker)}, url + "\\n");\n  return nextLoad(url, context);\n}\n`);
		const script = join(process.cwd(), "scripts", "platform-smoke.mjs");
		const cases = [
			["run", "extra"],
			["run", "--targt", "macos"],
			["run", "--target"],
			["run", "--suite"],
			["run", "run"],
			["run", "doctor"],
			["run", "--target", "macos", "--target", "ubuntu"],
			["run", "--target", "macos,macos"],
			["run", "--target", "macos,"],
			["run", "--suite", "platform-build", "--suite", "platform-build"],
			["run", "--target", "plan9"],
			["run", "--suite", "stdout-only"],
			["doctor", "--target", "macos"],
			["doctor", "--suite", "platform-build"],
			["--target", "macos"],
		];
		try {
			for (const args of cases) {
				const result = run(process.execPath, ["--experimental-loader", pathToFileURL(loader).href, script, ...args], {
					...process.env,
					PLATFORM_SMOKE_CRABBOX: process.execPath,
				}, cwd);
				expect(result.status, args.join(" ")).toBe(2);
				expect(result.stderr).toContain("usage error:");
				expect(existsSync(sentinel), args.join(" ")).toBe(true);
				expect(existsSync(loadedMarker), args.join(" ")).toBe(false);
			}
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}, 20_000);

	it("uses the platform local-resume suite manifest for CLI lane metadata", () => {
		expect(LOCAL_RESUME_SUITES.map(({ key, flag, script }) => ({ key, flag, script }))).toEqual([
			{ key: "restart", flag: undefined, script: "smoke:local-resume" },
			{ key: "safety", flag: "--safety", script: "smoke:local-resume:safety" },
			{ key: "toolSurface", flag: "--tool-surface", script: "smoke:local-resume:tool-surface" },
			{ key: "abort", flag: "--abort", script: "smoke:local-resume:abort" },
			{ key: "tree", flag: "--tree", script: "smoke:local-resume:tree" },
			{ key: "copySwitch", flag: "--copy-switch", script: "smoke:local-resume:copy-switch" },
			{ key: "fallback", flag: "--fallback", script: "smoke:local-resume:fallback" },
			{ key: "compaction", flag: "--compaction", script: "smoke:local-resume:compaction" },
			{ key: "defaultDryRun", flag: "--default-dry-run", script: "smoke:local-resume:default-dry-run" },
			{ key: "cleanup", flag: "--cleanup", script: "smoke:local-resume:cleanup" },
		]);
		const runbook = readFileSync("docs/platform-smoke.md", "utf8");
		for (const { suite } of LOCAL_RESUME_SUITES) expect(runbook).toContain(`run ${suite}`);
	});

	it("preserves local-resume target command construction in its focused runner", () => {
		const code = String.raw`
import { buildLocalResumeSuiteCommand } from "./scripts/platform-smoke/local-resume-runner.mjs";
const prepDir = ".platform-smoke-runs/local-resume-prep-1783794405965-windows-native";
const posix = buildLocalResumeSuiteCommand("ubuntu", "smoke:local-resume:safety", prepDir, "pi-cursor-sdk", "cursor-local-resume-safety");
const windowsCommand = buildLocalResumeSuiteCommand("windows-native", "smoke:local-resume:cleanup", prepDir, "pi-cursor-sdk", "cursor-local-resume-cleanup");
const encoded = windowsCommand.split(" -EncodedCommand ")[1];
const windows = encoded ? Buffer.from(encoded, "base64").toString("utf16le") : "";
const result = { posix, windowsCommand, windows };
console.log(JSON.stringify(result));
for (const command of [posix, windows]) {
  if (!command.includes("--prepare-only") || !command.includes("packed-workspace") || !command.includes("CURSOR_LOCAL_RESUME_SMOKE_EXTENSION_PATH") || !command.includes("CURSOR_LOCAL_RESUME_SMOKE_EMIT_BUNDLE")) process.exit(1);
  if (command.includes(" -e .") || command.includes("npm ci && npm run smoke:local-resume")) process.exit(1);
}
if (!posix.includes("npm run smoke:local-resume:safety")) process.exit(1);
if (!windowsCommand.startsWith("powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -EncodedCommand ") || windowsCommand.includes("$") || windowsCommand.length >= 2400) process.exit(1);
if (!windows.includes("npm run smoke:local-resume:cleanup") || !windows.includes("/lr") || windows.includes("local-resume-cursor-local-resume-cleanup")) process.exit(1);
if (!windows.includes("for($i=0;$i -lt 10") || !windows.includes("$w=$e.Replace('/','\\')") || !windows.includes("cmd.exe /d /c rd /s /q $w") || !windows.includes("Start-Sleep -Milliseconds 200") || !windows.includes("local-resume evidence cleanup failed") || windows.includes("SilentlyContinue")) process.exit(1);
`;
		const result = run(process.execPath, ["--input-type=module", "-e", code]);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain('"posix":"node scripts/platform-smoke/live-suite-runner.mjs --prepare-only');
	});

	it("packages smoke scripts and platform smoke docs", () => {
		const result = run("npm", ["pack", "--dry-run", "--json"]);
		expect(result.status).toBe(0);
		const [pack] = JSON.parse(result.stdout) as Array<{ name: string; version: string; files: Array<{ path: string }> }>;
		const paths = new Set(pack.files.map((file) => file.path));

		expect(pack.name).toBe("pi-cursor-sdk");
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
		// manifest target exists on disk after the pack-triggered build.
		const manifest = JSON.parse(readFileSync("package.json", "utf8")) as { pi?: { extensions?: string[] } };
		for (const entry of manifest.pi?.extensions ?? []) {
			expect(existsSync(entry), `pi.extensions entry missing on disk: ${entry}`).toBe(true);
		}
		expect(paths.has("tsconfig.build.json")).toBe(true);
		expect(paths.has("scripts/build.mjs")).toBe(true);
		expect(paths.has("scripts/prepare.mjs")).toBe(true);
		// Launchers import this helper; packed installs break without it.
		expect(paths.has("scripts/lib/ensure-built.mjs")).toBe(true);
		expect([...paths].some((path) => path.startsWith("coverage/") || path.startsWith(".pi/") || path.includes("smoke-dir"))).toBe(false);
	}, 90_000);
});
