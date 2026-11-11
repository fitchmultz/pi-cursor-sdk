import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
	CHILD_PROCESS_TREE_SPAWN_OPTIONS,
	terminateChild,
} from "./cursor-child-process.mjs";
import { createPiRpcChannel } from "./cursor-pi-rpc.mjs";
import {
	awaitCloudSmokeShutdown,
	createCloudSmokeTerminalFailureState,
	installCloudSmokeChildErrorHandlers,
	routeCloudSmokeChildClose,
	stopCloudSmokeTrackedChild,
} from "./cloud-smoke-shutdown.mjs";

export function createCloudSmokePiRunner({ root, model, shutdown, buildEnv, buildWorkspace }) {
	const findPiBin = () => {
		const local = join(root, "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi");
		return existsSync(local) ? local : process.platform === "win32" ? "pi.cmd" : "pi";
	};

	const spawnPi = (artifactDir, args, envOptions, stdio) => {
		const sessionDir = join(artifactDir, "sessions");
		mkdirSync(sessionDir, { recursive: true });
		return spawn(findPiBin(), args(sessionDir), {
			cwd: buildWorkspace(artifactDir),
			env: buildEnv(artifactDir, envOptions),
			stdio,
			...CHILD_PROCESS_TREE_SPAWN_OPTIONS,
		});
	};

	const runPi = ({ artifactDir, envOptions = {}, message, sessionId, timeoutMs }) => {
		shutdown.throwIfRequested();
		const child = spawnPi(
			artifactDir,
			(sessionDir) => ["-e", root, "--model", model, "--approve", "--session-dir", sessionDir, "--session-id", sessionId, "-p", message],
			envOptions,
			["ignore", "pipe", "pipe"],
		);
		const tracking = shutdown.track(child);
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		return new Promise((resolveRun, rejectRun) => {
			let settled = false;
			let timeoutStarted = false;
			let timeoutTermination = Promise.resolve();
			const settle = (callback, value) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				shutdown.signal.removeEventListener("abort", onShutdown);
				callback(value);
			};
			const onShutdown = () => {
				const termination = Promise.allSettled([tracking, timeoutTermination]).then((results) => {
					const failed = results.find((result) => result.status === "rejected");
					if (failed) throw failed.reason;
				});
				void awaitCloudSmokeShutdown(shutdown, termination).then((error) => settle(rejectRun, error));
			};
			const timer = setTimeout(() => {
				if (shutdown.signal.aborted) return onShutdown();
				timeoutStarted = true;
				timeoutTermination = terminateChild(child);
				void timeoutTermination.then(
					() => shutdown.signal.aborted
						? onShutdown()
						: settle(rejectRun, new Error(`pi cloud smoke timed out after ${timeoutMs}ms`)),
					(error) => shutdown.signal.aborted
						? onShutdown()
						: settle(rejectRun, new Error(`pi cloud smoke timed out and cleanup failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error })),
				);
			}, timeoutMs);
			shutdown.signal.addEventListener("abort", onShutdown, { once: true });
			if (shutdown.signal.aborted) onShutdown();
			void tracking.catch((error) => shutdown.signal.aborted ? onShutdown() : settle(rejectRun, error));
			child.once("error", (error) => routeCloudSmokeChildClose(
				shutdown,
				timeoutStarted,
				onShutdown,
				(failure) => settle(rejectRun, failure),
				error,
			));
			child.once("close", (code, signal) => routeCloudSmokeChildClose(
				shutdown,
				timeoutStarted,
				onShutdown,
				(result) => settle(resolveRun, result),
				{ code, signal, stdout, stderr },
			));
		});
	};

	const startRpc = async ({ artifactDir, contextHandoff = "fresh", sessionId, envOptions = {} }) => {
		shutdown.throwIfRequested();
		const child = spawnPi(
			artifactDir,
			(sessionDir) => ["--mode", "rpc", "-e", root, "--model", model, "--approve", "--session-dir", sessionDir, "--session-id", sessionId],
			{ contextHandoff, ...envOptions },
			["pipe", "pipe", "pipe"],
		);
		const tracking = shutdown.track(child);
		const rpc = createPiRpcChannel(child, { idPrefix: "cloud_smoke" });
		const terminalState = createCloudSmokeTerminalFailureState(rpc.close);
		// After a shutdown request, nothing settles until child termination completes.
		const rejectAfterShutdown = () => rpc.close(awaitCloudSmokeShutdown(shutdown, tracking));
		shutdown.signal.addEventListener("abort", rejectAfterShutdown, { once: true });
		if (shutdown.signal.aborted) rejectAfterShutdown();
		installCloudSmokeChildErrorHandlers(child, shutdown, rejectAfterShutdown, terminalState.record);
		child.once("close", () => {
			shutdown.signal.removeEventListener("abort", rejectAfterShutdown);
			if (shutdown.signal.aborted) rejectAfterShutdown();
			else terminalState.record(new Error(`cloud smoke RPC exited. Stderr: ${rpc.stderr}`));
		});
		const send = (type, extra = {}, timeoutMs = 120000) => {
			try {
				shutdown.throwIfRequested();
				terminalState.throwIfFailed();
			} catch (error) {
				return Promise.reject(error);
			}
			return rpc.send(type, extra, timeoutMs);
		};
		const stop = async () => {
			shutdown.signal.removeEventListener("abort", rejectAfterShutdown);
			if (!shutdown.signal.aborted) terminalState.record(new Error("cloud smoke RPC stopped"));
			try {
				const shutdownReason = await stopCloudSmokeTrackedChild(
					shutdown,
					tracking,
					() => terminateChild(child, { graceMs: 15_000 }),
				);
				if (shutdownReason) rpc.close(shutdownReason);
			} catch (error) {
				rpc.close(error);
				throw error;
			}
		};
		try {
			await tracking;
			if (shutdown.signal.aborted) throw await awaitCloudSmokeShutdown(shutdown, tracking);
		} catch (error) {
			rpc.close(error);
			throw error;
		}
		return {
			events: rpc.events,
			send,
			stop,
			throwIfFailed: terminalState.throwIfFailed,
			get stderr() { return rpc.stderr; },
		};
	};

	return { runPi, startRpc };
}
