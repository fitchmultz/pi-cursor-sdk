/**
 * Crabbox runner — thin wrapper around the Crabbox CLI.
 *
 * Handles warmup, sync-aware run, stop, and artifact collection.
 * Never prints CURSOR_API_KEY.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";

const CRABBOX_BIN = process.env.PLATFORM_SMOKE_CRABBOX || "crabbox";

function env(name) { return process.env[name] ?? ""; }

export function ensureUbuntuContainerImage(config = {}) {
	const override = env("PLATFORM_SMOKE_UBUNTU_IMAGE");
	if (override) return override;
	const image = config.ubuntuContainerImage;
	const baseImage = config.ubuntuContainerBaseImage;
	const nodeImage = config.ubuntuContainerNodeImage;
	if (!image || !baseImage || !nodeImage) throw new Error("platform smoke config requires ubuntuContainerImage, ubuntuContainerBaseImage and ubuntuContainerNodeImage");
	const childEnv = { ...process.env };
	delete childEnv.CURSOR_API_KEY;
	execFileSync("docker", ["build", "--quiet", "--tag", image, "-"], {
		env: childEnv,
		input: `FROM ${nodeImage} AS node\nFROM ${baseImage}\nUSER root\nCOPY --from=node /usr/local/bin/node /usr/local/bin/node\n`,
		stdio: ["pipe", "pipe", "pipe"],
		timeout: 300_000,
	});
	return image;
}

function buildCrabboxEnv(opts = {}) {
	const env = { ...process.env, CRABBOX_SYNC_GIT_SEED: "false", ...opts.env };
	const allowed = new Set(opts.allowEnv ?? []);
	if (!allowed.has("CURSOR_API_KEY")) delete env.CURSOR_API_KEY;
	return env;
}

/** Run a crabbox command, returning stdout+stderr+exit+signal. */
export function execCrabbox(args, opts = {}) {
	return new Promise((resolvePromise) => {
		const timeoutMs = opts.timeout ?? 0;
		const child = spawn(CRABBOX_BIN, args, {
			stdio: ["pipe", "pipe", "pipe"],
			env: buildCrabboxEnv(opts),
			...opts.spawnOpts,
		});

		const stdoutChunks = [];
		const stderrChunks = [];
		let timeout;
		let killTimeout;
		if (timeoutMs > 0) {
			timeout = setTimeout(() => {
				stderrChunks.push(Buffer.from(`\n[platform-smoke] crabbox command timed out after ${timeoutMs}ms\n`));
				try { child.kill("SIGTERM"); } catch {}
				killTimeout = setTimeout(() => {
					try { child.kill("SIGKILL"); } catch {}
				}, 10_000);
			}, timeoutMs);
		}

		child.stdout.on("data", (d) => stdoutChunks.push(d));
		child.stderr.on("data", (d) => stderrChunks.push(d));

		child.on("close", (code, signal) => {
			if (timeout) clearTimeout(timeout);
			if (killTimeout) clearTimeout(killTimeout);
			resolvePromise({
				stdout: Buffer.concat(stdoutChunks).toString(),
				stderr: Buffer.concat(stderrChunks).toString(),
				code: code ?? (signal ? 1 : 0),
				signal,
			});
		});

		child.on("error", (err) => {
			if (timeout) clearTimeout(timeout);
			if (killTimeout) clearTimeout(killTimeout);
			resolvePromise({
				stdout: Buffer.concat(stdoutChunks).toString(),
				stderr: (Buffer.concat(stderrChunks).toString() + "\n" + err.message).trim(),
				code: 1,
				signal: null,
			});
		});
	});
}

/**
 * Build the base crabbox args for a target (used for warmup, run, stop).
 * These include provider, connection details, and work root.
 * Callers should append command-specific flags/args.
 */
export function buildTargetBaseArgs(targetName, config = {}) {
	switch (targetName) {
		case "macos": {
			const host = env("PLATFORM_SMOKE_MAC_HOST") || "localhost";
			const user = env("PLATFORM_SMOKE_MAC_USER") || env("USER");
			const workRoot = env("PLATFORM_SMOKE_MAC_WORK_ROOT") || `/Users/${env("USER")}/crabbox/pi-cursor-sdk`;
			return [
				"--provider", "ssh",
				"--target", "macos",
				"--static-host", host,
				"--static-user", user,
				"--static-port", "22",
				"--static-work-root", workRoot,
			];
		}
		case "ubuntu": {
			const image = env("PLATFORM_SMOKE_UBUNTU_IMAGE") || config.ubuntuContainerImage;
			if (!image) throw new Error("platform smoke config requires ubuntuContainerImage");
			return [
				"--provider", "local-container",
				"--target", "linux",
				"--local-container-image", image,
			];
		}
		case "windows-native": {
			const windows = config.windowsParallels ?? {};
			const vm = env("PLATFORM_SMOKE_WINDOWS_VM") || windows.sourceVm || "pi-extension-windows-template";
			const snap = env("PLATFORM_SMOKE_WINDOWS_SNAPSHOT") || windows.snapshot || "crabbox-ready";
			const user = env("PLATFORM_SMOKE_WINDOWS_USER") || windows.user || env("USER");
			const workRoot = env("PLATFORM_SMOKE_WINDOWS_NATIVE_WORK_ROOT") || windows.workRoot || "C:\\crabbox\\pi-cursor-sdk";
			return [
				"--provider", "parallels",
				"--target", "windows",
				"--windows-mode", "normal",
				"--parallels-source", vm,
				"--parallels-source-snapshot", snap,
				"--parallels-user", user,
				"--parallels-work-root", workRoot,
			];
		}
		default:
			throw new Error(`unknown target: ${targetName}`);
	}
}

/**
 * Get the internal lease ID for a target.
 * For static SSH, this is "static_localhost".
 * For local-container, it's the slug (pi-cursor-sdk-ubuntu).
 * For parallels, it's the slug used during warmup.
 */
export function leaseIdFor(targetName) {
	switch (targetName) {
		case "macos": return "static_localhost";
		case "ubuntu": return "pi-cursor-sdk-ubuntu";
		default: return `pi-cursor-sdk-${targetName}`;
	}
}

function parseLeaseId(output) {
	return output.match(/\bleased\s+(\S+)/)?.[1]
		?? output.match(/\blease=(\S+)/)?.[1]
		?? null;
}

/**
 * Warm up a Crabbox target lease.
 * Returns { ok, stdout, stderr, leaseId }.
 * The lease will be kept until explicitly stopped.
 */
export async function warmupLease(targetName, slug, config = {}) {
	if (targetName === "ubuntu") {
		try {
			const image = ensureUbuntuContainerImage(config);
			console.log(`  prepared Ubuntu container image ${image}`);
		} catch (error) {
			return {
				ok: false,
				stdout: "",
				stderr: `failed to prepare Ubuntu container image: ${error instanceof Error ? error.message : String(error)}`,
				code: 1,
				signal: null,
				leaseId: leaseIdFor(targetName),
			};
		}
	}
	const fullArgs = ["warmup", ...buildTargetBaseArgs(targetName, config), "--slug", slug, "--keep"];
	if (targetName === "macos") fullArgs.push("--reclaim");
	console.log(`  [crabbox] ${fullArgs.join(" ")}`);
	const result = await execCrabbox(fullArgs, { timeout: 300_000 });
	return {
		ok: result.code === 0,
		...result,
		leaseId: parseLeaseId(result.stdout) ?? parseLeaseId(result.stderr) ?? leaseIdFor(targetName),
	};
}

/**
 * Run a command on a warmed-up lease.
 * The lease must already exist from a prior warmup. By default this performs
 * one fresh sync so platform smoke always tests the current local checkout.
 */
export async function runOnLease(targetName, leaseId, command, opts = {}) {
	const args = [
		"run",
		...buildTargetBaseArgs(targetName, opts.config),
		"--id", leaseId,
	];
	for (const name of opts.allowEnv ?? []) {
		args.push("--allow-env", name);
	}
	if (opts.sync === false) {
		args.push("--no-sync");
	} else if (opts.freshSync !== false) {
		args.push("--fresh-sync");
	}
	if (opts.captureStdoutPath) args.push("--capture-stdout", opts.captureStdoutPath);
	if (opts.shell) {
		args.push("--shell", command);
	} else {
		args.push("--", ...(Array.isArray(command) ? command : command.split(" ")));
	}
	console.log(`  [crabbox] run ${args.slice(1, 6).join(" ")} ...`);
	const result = await execCrabbox(args, {
		timeout: opts.timeout ?? 600_000,
		env: opts.env,
		allowEnv: opts.allowEnv,
	});
	if (!opts.captureStdoutPath || !existsSync(opts.captureStdoutPath)) return result;
	try {
		return { ...result, stdout: readFileSync(opts.captureStdoutPath, "utf8") };
	} finally {
		rmSync(opts.captureStdoutPath, { force: true });
	}
}

/**
 * Stop/release a warmed-up lease.
 */
export async function stopLease(targetName, leaseId, config = {}) {
	const args = ["stop", ...buildTargetBaseArgs(targetName, config), "--id", leaseId];
	console.log(`  [crabbox] ${args.join(" ")}`);
	return execCrabbox(args, { timeout: 60_000 });
}

/**
 * One-shot: run a command through Crabbox without warmup.
 * Crabbox syncs the checkout, executes, and releases the lease.
 */
export async function runOneShot(targetName, command, opts = {}) {
	if (targetName === "ubuntu") ensureUbuntuContainerImage(opts.config);
	const args = ["run", ...buildTargetBaseArgs(targetName, opts.config)];
	if (opts.shell) {
		args.push("--shell", command);
	} else {
		args.push("--", ...(Array.isArray(command) ? command : command.split(" ")));
	}
	console.log(`  [crabbox] run (one-shot) ${args.slice(1, 6).join(" ")} ...`);
	return execCrabbox(args, {
		timeout: opts.timeout ?? 600_000,
		env: opts.env,
		allowEnv: opts.allowEnv,
	});
}
