import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
	__testUtils, installCursorSdkOutputFilter, installCursorSdkProcessOutputFilter,
	isCursorSdkOutputSuppressed,
} from "../src/cursor-sdk-output-filter.js";
import { prepareInstalledBootstrapEmitters } from "./helpers/cursor-sdk-bootstrap.js";
import { collectOutput } from "./helpers/process-output.js";

describe("Cursor SDK process output filter lifetime", () => {
	it("shares one sink and async ownership across reevaluation, temporary leases and reload gaps", async () => {
		const bindSdk = await prepareInstalledBootstrapEmitters();
		const output = collectOutput();
		const original = { stdout: process.stdout.write, stderr: process.stderr.write };
		const listeners = { beforeExit: process.listenerCount("beforeExit"), exit: process.listenerCount("exit") };
		let releaseTurn: (() => void) | undefined;
		try {
			const sdk = await bindSdk(false);
			installCursorSdkProcessOutputFilter(); // extension initialization, before any turn
			const filtered = process.stdout.write;
			installCursorSdkProcessOutputFilter(); // another extension/session
			expect(process.stdout.write).toBe(filtered);
			expect(process.listenerCount("beforeExit")).toBe(listeners.beforeExit + 1);
			expect(process.listenerCount("exit")).toBe(listeners.exit + 1);
			// A distinct native module evaluation must reuse the full process state,
			// including ALS scopes, not just a flag pointing at old stream wrappers.
			const fresh = await import(/* @vite-ignore */ new URL("../shared/cursor-sdk-output-filter.mjs?lifetime-contract", import.meta.url).href) as typeof import("../shared/cursor-sdk-output-filter.mjs");
			expect(fresh.installCursorSdkProcessOutputFilter).not.toBe(installCursorSdkProcessOutputFilter);
			fresh.installCursorSdkProcessOutputFilter();
			expect(process.stdout.write).toBe(filtered);
			expect(process.listenerCount("beforeExit")).toBe(listeners.beforeExit + 1);
			releaseTurn = fresh.installCursorSdkOutputFilter();
			sdk.completion(sdk.completions[0]!);
			releaseTurn();
			// No active provider/session lease: this is the asynchronous interval
			// between old shutdown and replacement initialization, or failed reload.
			await new Promise<void>(resolve => setImmediate(() => { sdk.completion(sdk.completions[1]!); resolve(); }));
			expect(output.stdout).toEqual([]);
			const notices: string[] = [];
			await fresh.withCursorSdkOutputNoticeHandler((kind) => { notices.push(kind); }, async () => {
				await Promise.resolve();
				process.stderr.write(sdk.parserWarning + "\n");
			});
			expect(notices).toEqual(["parserUnavailable"]);
			expect(output.stderr).toEqual([]);
			fresh.suppressCursorSdkOutput(() => {
				expect(isCursorSdkOutputSuppressed()).toBe(true);
				process.stdout.write("creation-only mute\n");
			});
			expect(output.stdout).toEqual([]);
			const detached = Promise.withResolvers<void>();
			const detachedSuppression: boolean[] = [];
			await fresh.suppressCursorSdkOutput(async () => {
				setImmediate(() => {
					detachedSuppression.push(isCursorSdkOutputSuppressed());
					process.stdout.write("VISIBLE detached warning after creation\n");
					detached.resolve();
				});
				process.stdout.write("still inside creation\n");
				await Promise.resolve();
			});
			await detached.promise;
			expect(detachedSuppression).toEqual([false]);
			expect(Buffer.concat(output.stdout).toString()).toBe("VISIBLE detached warning after creation\n");
			output.stdout.length = 0;
			process.stderr.write('[hooks] Refusing to load user config via symlink path: /unsafe\n');
			process.stderr.write(sdk.parserWarning + "\n"); // no owner: warning stays raw
			expect(Buffer.concat(output.stderr).toString()).toBe(`[hooks] Refusing to load user config via symlink path: /unsafe\n${sdk.parserWarning}\n`);
			releaseTurn = installCursorSdkOutputFilter();
			process.stdout.write("18:05:");
			fresh.__testUtils.resetProcessOutputFilter();
			expect(process.stdout.write).toBe(filtered); // temporary owner still active
			releaseTurn();
			expect(process.stdout.write).toBe(original.stdout);
			expect(process.stderr.write).toBe(original.stderr);
			expect(Buffer.concat(output.stdout).toString()).toBe("18:05:");
			expect(process.listenerCount("beforeExit")).toBe(listeners.beforeExit);
			expect(process.listenerCount("exit")).toBe(listeners.exit);
			filtered.call(process.stdout, "VISIBLE retained delegate\n");
			expect(Buffer.concat(output.stdout).toString()).toBe("18:05:VISIBLE retained delegate\n");
		} finally { releaseTurn?.(); __testUtils.resetProcessOutputFilter(); output.restore(); }
	}, 30_000);

	it.each([
		{ explicit: false, temporary: false }, { explicit: true, temporary: false },
		{ explicit: false, temporary: true }, { explicit: true, temporary: true },
	])("flushes exit tails with explicit=$explicit temporary=$temporary", ({ explicit, temporary }) => {
		const moduleUrl = new URL("../shared/cursor-sdk-output-filter.mjs", import.meta.url).href;
		const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `
			import { installCursorSdkProcessOutputFilter, installCursorSdkOutputFilter } from ${JSON.stringify(moduleUrl)};
			installCursorSdkProcessOutputFilter();
			${temporary ? "installCursorSdkOutputFilter();" : ""}
			process.stdout.write("18:05:");
			${explicit ? "process.exit(0);" : ""}
		`], { encoding: "utf8", timeout: 10_000 });
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toBe("18:05:");
	});

	it("keeps the lifetime sink when another beforeExit listener schedules more work", () => {
		const moduleUrl = new URL("../shared/cursor-sdk-output-filter.mjs", import.meta.url).href;
		const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `
			import { installCursorSdkProcessOutputFilter } from ${JSON.stringify(moduleUrl)};
			installCursorSdkProcessOutputFilter();
			process.stdout.write("18:05:");
			process.once("beforeExit", () => setImmediate(() => {
				process.stdout.write('12:34:56.789 INFO  LocalCursorRulesService load completed\\n');
				process.stdout.write('VISIBLE resumed work\\n');
			}));
		`], { encoding: "utf8", timeout: 10_000 });
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toBe("18:05:VISIBLE resumed work\n");
	});
});
