import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
const tempDirs: string[] = [];
const targetsModule = "../scripts/platform-smoke/targets.mjs";
const artifactsModule = "../scripts/platform-smoke/artifacts.mjs";
// One suite per lease-bound executor: platform build, live PTY suite, and local resume.
const EXECUTOR_SUITES = ["platform-build", "cursor-http1-live", "cursor-local-resume-restart"];
// One warmup, the suite command on the warmed lease, and exactly one stop by the lease owner.
const LEASE_CALLS = [
	{ subcommand: "warmup" },
	{ subcommand: "run", id: "cbx_fake_owned" },
	{ subcommand: "stop", id: "cbx_fake_owned" },
];
// Stop output that an owned lease's suite keeps and lists in its artifact manifest.
const STOP_ARTIFACTS = ["crabbox.stop.stdout.txt", "crabbox.stop.stderr.txt", "crabbox.stop.exit-code.txt"];
// A completed owner's stop exit and the lease-stop check it records.
const LEASE_STOP_OUTCOMES = [
	{ stopExit: 0, leaseStop: { id: "lease-stop", ok: true } },
	{ stopExit: 1, leaseStop: { id: "lease-stop", ok: false, error: "Crabbox stop failed (exit 1); check crabbox.stop.stderr.txt" } },
];

// live-status.json as the live-suite runner recorded it for cursor-http1-live when pi answered and quit, answered but
// outlived every exit step, and exited before answering. Observation and PTY exit are independent facts.
const LIVE_RUN = { suite: "cursor-http1-live", target: "macos", model: "cursor/grok-4.6", cursorNoFast: true, platform: "posix" };
const LIVE_OUTCOMES = [
	{
		outcome: "answered and exited",
		status: { ...LIVE_RUN, jsonlCount: 1, observation: "evidence-observed", ptyExit: { kind: "exited", exitCode: 0, signal: 0 }, ok: true },
		finalMarker: { id: "final-marker", ok: true },
		piExit: { id: "pi-exit", ok: true },
	},
	{
		outcome: "answered without an observed exit",
		status: { ...LIVE_RUN, jsonlCount: 1, observation: "evidence-observed", ptyExit: { kind: "not-observed" }, ok: false, error: "pi PTY exit was not observed after /quit, EOF, Ctrl+C and kill; pi may still be running" },
		finalMarker: { id: "final-marker", ok: true },
		piExit: { id: "pi-exit", ok: false, error: 'live-status.json ptyExit: {"kind":"not-observed"}' },
	},
	{
		outcome: "exited before answering",
		status: { ...LIVE_RUN, jsonlCount: 0, observation: "pi-exited", ptyExit: { kind: "exited", exitCode: 3, signal: 0 }, ok: false, error: "pi exited (exit code 3) before final marker HTTP1_LIVE_OK and its persisted session JSONL evidence were observed" },
		finalMarker: { id: "final-marker", ok: false, error: "live-status.json observation: pi-exited" },
		piExit: { id: "pi-exit", ok: true },
	},
];

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function useFakeCrabboxCli(env: Record<string, string> = {}) {
	vi.stubEnv("PLATFORM_SMOKE_CRABBOX", process.execPath);
	vi.stubEnv("NODE_OPTIONS", `--import=${pathToFileURL(resolve("test/fixtures/fake-crabbox.mjs")).href}`);
	for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
	vi.resetModules();
}

/** Runs target suites through the fake Crabbox CLI, recording each Crabbox lease command. */
function useFakeCrabboxLeases({ breakSuiteStdout = false, breakStopStdoutOf = "", warmupExit = 0, stopExit = 0, suiteStdout = "" } = {}) {
	const root = mkdtempSync(join(tmpdir(), "platform-target-lease-"));
	tempDirs.push(root);
	const artifactRoot = join(root, "artifacts");
	const callsPath = join(root, "crabbox-calls.jsonl");
	useFakeCrabboxCli({
		FAKE_CRABBOX_CALLS: callsPath,
		FAKE_CRABBOX_WARMUP_EXIT: String(warmupExit),
		FAKE_CRABBOX_STOP_EXIT: String(stopExit),
		...(breakSuiteStdout ? { FAKE_CRABBOX_BREAK_SUITE_STDOUT_IN: artifactRoot } : {}),
		...(breakStopStdoutOf ? { FAKE_CRABBOX_BREAK_STOP_STDOUT_IN: artifactRoot, FAKE_CRABBOX_BREAK_STOP_STDOUT_OF: breakStopStdoutOf } : {}),
		...(suiteStdout ? { FAKE_CRABBOX_SUITE_STDOUT: suiteStdout } : {}),
	});
	vi.spyOn(console, "log").mockImplementation(() => undefined);
	return {
		config: { artifactRoot, packageName: "pi-cursor-sdk" },
		calls: () => readFileSync(callsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line)),
		suiteDir: (suiteName: string) => join(artifactRoot, readdirSync(artifactRoot)[0], "macos", suiteName),
	};
}

describe("platform target runtime", () => {
	it("captures full suite stdout and disables workspace sync on a transient SSH retry", async () => {
		vi.useFakeTimers();
		const suiteDir = mkdtempSync(join(tmpdir(), "platform-target-retry-"));
		tempDirs.push(suiteDir);
		const run = vi.fn()
			.mockResolvedValueOnce({ code: 255, signal: null, stdout: "", stderr: "ssh: connect to host example Operation timed out" })
			.mockResolvedValueOnce({ code: 0, signal: null, stdout: "ok", stderr: "" });

		const modulePath = "../scripts/platform-smoke/target-runtime.mjs";
		const { runOnLeaseWithTransientRetry } = await import(modulePath);
		const resultPromise = runOnLeaseWithTransientRetry(
			suiteDir,
			"macos",
			"lease-1",
			"echo ok",
			{ sync: true, freshSync: true },
			run,
		);
		await vi.runAllTimersAsync();

		await expect(resultPromise).resolves.toMatchObject({ code: 0, stdout: "ok" });
		const captureStdoutPath = join(suiteDir, ".crabbox.remote.stdout.raw");
		expect(run.mock.calls.map((call) => call[3])).toEqual([
			{ sync: true, freshSync: true, captureStdoutPath },
			{ sync: false, freshSync: true, captureStdoutPath },
		]);
	});

	it("returns Crabbox's captured stdout with the original exit code and removes the capture file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "platform-crabbox-capture-"));
		tempDirs.push(dir);
		const captureStdoutPath = join(dir, "remote.stdout.raw");
		useFakeCrabboxCli();
		const modulePath = "../scripts/platform-smoke/crabbox-runner.mjs";
		const { runOnLease } = await import(modulePath);

		const result = await runOnLease("ubuntu", "lease-1", "echo ok", {
			shell: true,
			sync: false,
			captureStdoutPath,
			config: { ubuntuContainerImage: "example/node:24" },
		});

		expect(result.code).toBe(7);
		expect(result.stdout.startsWith("FAKE_CRABBOX_ARGS="), result.stdout).toBe(true);
		const args: string[] = JSON.parse(result.stdout.slice("FAKE_CRABBOX_ARGS=".length));
		expect(args.slice(args.indexOf("--id"))).toEqual(["--id", "lease-1", "--no-sync", "--capture-stdout", captureStdoutPath, "--shell", "echo ok"]);
		expect(existsSync(captureStdoutPath)).toBe(false);
	});

	it("formats bundle extraction check errors for non-committed and malformed-structured bundles", async () => {
		const suiteDir = mkdtempSync(join(tmpdir(), "platform-bundle-check-"));
		tempDirs.push(suiteDir);
		const runtimeModule = "../scripts/platform-smoke/target-runtime.mjs";
		const assertionsModule = "../scripts/platform-smoke/assertions.mjs";
		const { bundleExtractedCheck } = await import(runtimeModule);
		const { runAssertions } = await import(assertionsModule);

		const assertions = runAssertions(suiteDir, [
			bundleExtractedCheck("bundle-extracted", { ok: true, violations: [], extraction: "committed" }),
			bundleExtractedCheck("rolled-back-check", { ok: false, violations: [], extraction: "rolled-back" }),
			bundleExtractedCheck("malformed-check", {
				ok: false,
				extraction: "committed",
				violations: [
					{ file: "metadata.json", violation: "invalid JSON" },
					{ file: "process-output", violation: "CURSOR_API_KEY literal found" },
				],
			}),
		]);

		expect(assertions.ok).toBe(false);
		expect(assertions.checks).toEqual([
			{ id: "bundle-extracted", ok: true },
			{ id: "rolled-back-check", ok: false, error: "extraction rolled-back" },
			{ id: "malformed-check", ok: false, error: "extraction committed (1 structured artifact violation)" },
		]);
	});

	it.each(EXECUTOR_SUITES)("returns a single %s run's failed suite result when its owned lease warmup fails", async (suiteName) => {
		const crabbox = useFakeCrabboxLeases({ warmupExit: 3 });
		const { runTargetSuite } = await import(targetsModule);

		const result = await runTargetSuite(crabbox.config, "macos", suiteName);

		const suiteDir = crabbox.suiteDir(suiteName);
		const assertions = JSON.parse(readFileSync(join(suiteDir, "assertions.json"), "utf8"));
		expect(result).toEqual({ ok: false, suiteDir, assertions });
		expect(assertions.checks).toContainEqual({ id: "execution", ok: false, error: "Crabbox warmup failed (exit 3): fake warmup refused\n" });
		expect(readFileSync(join(suiteDir, "crabbox.warmup.stderr.txt"), "utf8")).toBe("fake warmup refused\n");
		expect(crabbox.calls()).toEqual([{ subcommand: "warmup" }]);
		expect(existsSync(join(suiteDir, "crabbox.stop.exit-code.txt"))).toBe(false);
	});

	it.each(EXECUTOR_SUITES)("stops a single %s run's owned lease when the suite fails after warmup", async (suiteName) => {
		const crabbox = useFakeCrabboxLeases({ breakSuiteStdout: true });
		const { runTargetSuite } = await import(targetsModule);

		const error = await runTargetSuite(crabbox.config, "macos", suiteName).catch((reason: unknown) => reason);

		const suiteDir = crabbox.suiteDir(suiteName);
		expect(error).toMatchObject({ path: join(suiteDir, "crabbox.stdout.txt") });
		expect(crabbox.calls()).toEqual(LEASE_CALLS);
		expect(readFileSync(join(suiteDir, "crabbox.stop.exit-code.txt"), "utf8")).toBe("code=0\nsignal=none\n");
	});

	// A single suite records its owned lease's stop in its own directory; a target session records it in lease-cleanup.
	it.each([
		{ runner: "runTargetSuite", stopRecorder: "platform-build" },
		{ runner: "runTargetSuites", stopRecorder: "lease-cleanup" },
	].flatMap((owner) => [
		{ ...owner, stopEvidence: "written", breakStopStdout: false, cleanupError: { message: "Crabbox stop failed (exit 1); check crabbox.stop.stderr.txt" }, stopExitFile: "code=1\nsignal=none\n" },
		{
			...owner,
			stopEvidence: "unwritable",
			breakStopStdout: true,
			cleanupError: { message: expect.stringMatching(/^Crabbox stop exited 1 \(signal none\) but writing its stop artifacts failed: EISDIR/), cause: { code: "EISDIR" } },
			stopExitFile: false,
		},
	]))("$runner reports a failed owned-lease stop together with the suite error when its $stopRecorder stop evidence is $stopEvidence", async ({ runner, stopRecorder, breakStopStdout, cleanupError, stopExitFile }) => {
		const crabbox = useFakeCrabboxLeases({ breakSuiteStdout: true, breakStopStdoutOf: breakStopStdout ? stopRecorder : "", stopExit: 1 });
		const targets = await import(targetsModule);

		const run = runner === "runTargetSuite"
			? targets.runTargetSuite(crabbox.config, "macos", "platform-build")
			: targets.runTargetSuites(crabbox.config, "macos", ["platform-build"]);
		const error = await run.catch((reason: unknown) => reason);

		expect(error).toMatchObject({ suppressed: { path: join(crabbox.suiteDir("platform-build"), "crabbox.stdout.txt") }, error: cleanupError });
		expect(error.message).toContain(error.suppressed.message);
		expect(error.message).toContain(error.error.message);
		expect(crabbox.calls()).toEqual(LEASE_CALLS);
		const stopExitPath = join(crabbox.suiteDir(stopRecorder), "crabbox.stop.exit-code.txt");
		expect(existsSync(stopExitPath) && readFileSync(stopExitPath, "utf8")).toBe(stopExitFile);
	});

	it.each(EXECUTOR_SUITES.flatMap((suiteName) => LEASE_STOP_OUTCOMES.map((outcome) => ({ suiteName, ...outcome }))))("records a completed single $suiteName run's owned lease stop (exit $stopExit) in its lease-stop check and artifact manifest", async ({ suiteName, stopExit, leaseStop }) => {
		const crabbox = useFakeCrabboxLeases({ stopExit });
		const { runTargetSuite } = await import(targetsModule);

		const { suiteDir } = await runTargetSuite(crabbox.config, "macos", suiteName);

		// The fake suite output fails each suite's own checks either way, so read the stop's check and manifest entries.
		const readArtifact = (name: string) => JSON.parse(readFileSync(join(suiteDir, name), "utf8"));
		expect(readArtifact("assertions.json").checks).toContainEqual(leaseStop);
		const manifest = readArtifact("artifact-manifest.json");
		expect(manifest.expected).toEqual(expect.arrayContaining(STOP_ARTIFACTS));
		expect(manifest.present).toEqual(expect.arrayContaining(STOP_ARTIFACTS));
		expect(readFileSync(join(suiteDir, "crabbox.stop.exit-code.txt"), "utf8")).toBe(`code=${stopExit}\nsignal=none\n`);
		expect(crabbox.calls()).toEqual(LEASE_CALLS);
	});

	it.each(LEASE_STOP_OUTCOMES)("records a target session's owned lease stop (exit $stopExit) as its lease-cleanup result", async ({ stopExit, leaseStop }) => {
		const crabbox = useFakeCrabboxLeases({ stopExit });
		const { runTargetSuites } = await import(targetsModule);

		const { results } = await runTargetSuites(crabbox.config, "macos", ["platform-build"]);

		const suiteDir = crabbox.suiteDir("lease-cleanup");
		const assertions = JSON.parse(readFileSync(join(suiteDir, "assertions.json"), "utf8"));
		expect(results.at(-1)).toEqual({ ok: leaseStop.ok, suiteDir, assertions });
		expect(assertions.checks).toContainEqual(leaseStop);
		expect(readFileSync(join(suiteDir, "crabbox.stop.exit-code.txt"), "utf8")).toBe(`code=${stopExit}\nsignal=none\n`);
		expect(crabbox.calls()).toEqual(LEASE_CALLS);
	});

	// POSIX controllers only: artifact-anchored-extract.mjs fails closed on nonempty bundles on Windows controllers
	// (owned by platform-artifact-boundaries.test.ts), so a Windows host never reads an extracted live-status.json.
	it.skipIf(process.platform === "win32").each(LIVE_OUTCOMES)("checks a live run that $outcome for its final marker and pi exit independently", async ({ status, finalMarker, piExit }) => {
		const remote = mkdtempSync(join(tmpdir(), "platform-live-remote-"));
		tempDirs.push(remote);
		mkdirSync(join(remote, "run", "artifacts"), { recursive: true });
		writeFileSync(join(remote, "run", "artifacts", "live-status.json"), JSON.stringify(status, null, 2));
		const { buildPlatformArtifactBundle, formatPlatformArtifactBundle } = await import(artifactsModule);
		writeFileSync(join(remote, "suite.stdout.txt"), formatPlatformArtifactBundle(buildPlatformArtifactBundle(join(remote, "run"))));
		const crabbox = useFakeCrabboxLeases({ suiteStdout: join(remote, "suite.stdout.txt") });
		const { runTargetSuite } = await import(targetsModule);

		const { suiteDir, assertions } = await runTargetSuite(crabbox.config, "macos", "cursor-http1-live");

		expect(JSON.parse(readFileSync(join(suiteDir, "artifacts", "live-status.json"), "utf8"))).toEqual(status);
		expect(assertions.checks).toContainEqual(finalMarker);
		expect(assertions.checks).toContainEqual(piExit);
	});

	it.each(EXECUTOR_SUITES)("leaves the target session's borrowed lease to the session, which records its stop, when %s fails", async (suiteName) => {
		const crabbox = useFakeCrabboxLeases({ breakSuiteStdout: true });
		const { runTargetSuites } = await import(targetsModule);

		const error = await runTargetSuites(crabbox.config, "macos", [suiteName]).catch((reason: unknown) => reason);

		const suiteDir = crabbox.suiteDir(suiteName);
		expect(error).toMatchObject({ path: join(suiteDir, "crabbox.stdout.txt") });
		expect(crabbox.calls()).toEqual(LEASE_CALLS);
		expect(existsSync(join(suiteDir, "crabbox.stop.exit-code.txt"))).toBe(false);
		expect(readFileSync(join(crabbox.suiteDir("lease-cleanup"), "crabbox.stop.exit-code.txt"), "utf8")).toBe("code=0\nsignal=none\n");
	});
});
