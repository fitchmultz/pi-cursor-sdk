import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
const tempDirs: string[] = [];

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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
		vi.stubEnv("PLATFORM_SMOKE_CRABBOX", process.execPath);
		vi.stubEnv("NODE_OPTIONS", `--import=${pathToFileURL(resolve("test/fixtures/fake-crabbox.mjs")).href}`);
		vi.resetModules();
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
});
