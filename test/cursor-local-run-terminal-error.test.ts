import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { LocalAgentStore, Run, RunResult } from "@cursor/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	observeCursorLocalRunTerminalErrors,
	resolveCursorLocalRunTerminalError,
	watchCursorLocalRunTerminalError,
} from "../src/cursor-local-run-terminal-error.js";

const FAILURE = "[permission_denied] offline terminal failure";

function connectEndStream(body: object): Buffer {
	const json = Buffer.from(JSON.stringify(body));
	const head = Buffer.alloc(5);
	head.writeUInt8(2, 0);
	head.writeUInt32BE(json.length, 1);
	return Buffer.concat([head, json]);
}

// Credential-free Cursor backend stand-in: every run stream fails with a non-retryable Connect error.
async function startFailingRunBackend(): Promise<Server> {
	const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
	const token = `${encode({ alg: "none", typ: "JWT" })}.${encode({ sub: "offline", exp: Math.floor(Date.now() / 1000) + 3600 })}.offline`;
	const server = createServer((request, response) => {
		request.resume();
		request.on("end", () => {
			const path = request.url ?? "";
			const contentType = String(request.headers["content-type"] ?? "");
			if (path === "/auth/exchange_user_api_key") {
				response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ accessToken: token }));
			} else if (path.startsWith("/v1/models")) {
				response.writeHead(200, { "content-type": "application/json" })
					.end(JSON.stringify({ items: [{ id: "offline-model", displayName: "Offline model", aliases: [] }] }));
			} else if (path === "/agent.v1.AgentService/RunSSE") {
				response.writeHead(200, { "content-type": "application/connect+proto" });
				setTimeout(() => response.end(connectEndStream({ error: { code: "permission_denied", message: "offline terminal failure" } })), 50);
			} else if (contentType.includes("connect+")) {
				response.writeHead(200, { "content-type": contentType }).end(connectEndStream({}));
			} else {
				const json = contentType.includes("json");
				response.writeHead(200, { "content-type": json ? "application/json" : "application/proto" }).end(json ? "{}" : undefined);
			}
		});
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return server;
}

async function runInstalledSdk(mode: "baseline" | "observed", backendUrl: string, root: string) {
	const home = join(root, `home-${mode}`);
	const child = spawn(process.execPath, [resolve("test/fixtures/cursor-local-run-terminal-error-child.mjs"), mode, root], {
		cwd: process.cwd(),
		env: {
			PATH: process.env.PATH, HOME: home, USERPROFILE: home, CURSOR_BACKEND_URL: backendUrl,
			...(process.platform === "win32" && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => { stdout += chunk; });
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
	const [code] = await once(child, "exit");
	clearTimeout(timer);
	expect(code, stderr.slice(-2000)).toBe(0);
	return JSON.parse(stdout.trim().split("\n").at(-1)!);
}

describe("cursor local run terminal error", () => {
	let root: string | undefined;
	let server: Server | undefined;
	afterEach(() => {
		server?.close();
		server = undefined;
		if (root) rmSync(root, { recursive: true, force: true });
		root = undefined;
	});

	it("cancels an installed-SDK local run from its error row while it is still running and restores the SDK error", async () => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "cursor-run-terminal-error-")));
		server = await startFailingRunBackend();
		const backendUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

		const baseline = await runInstalledSdk("baseline", backendUrl, root);
		const observed = await runInstalledSdk("observed", backendUrl, root);

		expect(baseline).toEqual({
			statusAtSend: "running",
			wait: { status: "error", error: { message: FAILURE } },
			row: { status: "error", error: FAILURE },
		});
		// Run.cancel() is a no-op once the status leaves "running", so "cancelled" proves the write came first.
		expect(observed).toEqual({
			statusAtSend: "running",
			wait: { status: "cancelled" },
			resolved: { status: "error", error: baseline.wait.error },
			row: { status: "error", error: FAILURE },
		});
	}, 120_000);

	it("cancels only a still-running watched run once and leaves caller aborts and other outcomes unchanged", async () => {
		const written: unknown[] = [];
		const update = vi.fn(async (input: { run: unknown }) => { written.push(input.run); });
		const store = observeCursorLocalRunTerminalErrors({ agents: {}, checkpoints: {}, runEvents: {}, runs: { update } } as unknown as LocalAgentStore);
		const run = (id: string) => ({ id, status: "running", cancel: vi.fn(async () => {}) }) as { id: string; status: Run["status"]; cancel: ReturnType<typeof vi.fn> };
		const row = (runId: string, status: string, error?: string) => ({ run: { runId, status, error: error ?? null } }) as never;
		const finished = run("finished");
		const userCancelled = run("user-cancelled");
		const failed = run("failed");
		const failedWrite = run("failed-write");
		for (const watched of [finished, userCancelled, failed, failedWrite]) watchCursorLocalRunTerminalError(store, watched as unknown as Run);
		userCancelled.status = "cancelled";

		await store.runs.update(row("finished", "finished"));
		await store.runs.update(row("finished", "error", "late"));
		await store.runs.update(row("user-cancelled", "error", "ignored"));
		await store.runs.update(row("failed", "running"));
		await store.runs.update(row("failed", "error", " stream failed "));
		await store.runs.update(row("failed", "error", "again"));
		update.mockRejectedValueOnce(new Error("disk full"));
		await expect(store.runs.update(row("failed-write", "error", "write failed"))).rejects.toThrow("disk full");

		expect(written).toHaveLength(6);
		expect(finished.cancel).not.toHaveBeenCalled();
		expect(userCancelled.cancel).not.toHaveBeenCalled();
		expect(failed.cancel).toHaveBeenCalledTimes(1);
		expect(failedWrite.cancel).toHaveBeenCalledTimes(1);
		const resolve = (watched: { id: string }, status: RunResult["status"], callerAborted = false) =>
			resolveCursorLocalRunTerminalError(watched as unknown as Run, { id: watched.id, status }, callerAborted);
		expect(resolve(finished, "finished")).toEqual({ id: "finished", status: "finished" });
		expect(resolve(userCancelled, "cancelled")).toEqual({ id: "user-cancelled", status: "cancelled" });
		expect(resolve(failed, "cancelled")).toEqual({ id: "failed", status: "error", error: { message: "stream failed" } });
		expect(resolve(failedWrite, "cancelled", true)).toEqual({ id: "failed-write", status: "cancelled" });
	});
});
