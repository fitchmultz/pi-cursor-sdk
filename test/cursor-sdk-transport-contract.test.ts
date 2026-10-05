import { createServer } from "node:http";
import { createServer as createHttp2Server, type ServerHttp2Session } from "node:http2";
import { once } from "node:events";
import { Empty, MethodKind } from "@bufbuild/protobuf";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installedCursorModules } from "./helpers/cursor-sdk-installed-modules.js";
import { classifyCursorConnectError } from "../src/cursor-provider-errors.js";
import { installCursorSdkProcessErrorGuard } from "../src/cursor-sdk-process-error-guard.js";

afterEach(() => vi.unstubAllGlobals());

describe("installed SDK vendored Node transport", () => {
	it.each(["1.1", "2"] as const)("performs credential-free loopback HTTP/%s RPC and retains abort provenance", async (httpVersion) => {
		const modules = await installedCursorModules();
		const { createSafeConnectTransport } = modules("./src/agent/safe-connect-transport.ts");
		const delays: number[] = [];
		const timeout = globalThis.setTimeout;
		vi.stubGlobal("setTimeout", ((callback: any, delay: number, ...args: any[]) => {
			delays.push(delay);
			return timeout(callback, delay, ...args);
		}) as typeof setTimeout);
		const server = httpVersion === "2" ? createHttp2Server() : createServer();
		const sessions = new Set<ServerHttp2Session>();
		server.on("session", (session: ServerHttp2Session) => sessions.add(session));
		server.on("request", (request: any, response: any) => {
			request.resume();
			if (request.url.endsWith("/Wait")) return; // Abort exercises the real vendored client.
			response.writeHead(200, { "content-type": "application/proto" });
			response.end();
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address() as { port: number };
		const transport = createSafeConnectTransport({ baseUrl: `http://127.0.0.1:${address.port}`, httpVersion });
		const service = { typeName: "offline.Contract" };
		const method = { name: "Probe", kind: MethodKind.Unary, I: Empty, O: Empty };
		try {
			const result = await transport.unary(service, method, undefined, 1000, {}, new Empty());
			expect(result.message).toBeInstanceOf(Empty);
			if (httpVersion === "2") expect(delays).toEqual(expect.arrayContaining([29_000, 59_000]));
			const controller = new AbortController();
			const pending = transport.unary(service, { ...method, name: "Wait" }, controller.signal, 1000, {}, new Empty());
			controller.abort();
			let error: any;
			try { await pending; } catch (caught) { error = caught; }
			expect(error.name).toBe("ConnectError");
			expect(error.code).toBe(2);
			expect(error.cause).toMatchObject({ name: "ConnectError", code: 1, cause: { name: "AbortError" } });
			expect(error.stack).toContain("@cursor/sdk/dist");
			expect(classifyCursorConnectError(error)).toEqual({ kind: "abort", source: "cursor-sdk-stack" });
			const guard = installCursorSdkProcessErrorGuard();
			const listener = vi.fn();
			process.on("uncaughtException", listener);
			try {
				process.emit("uncaughtException", error);
				expect(listener).toHaveBeenCalledOnce();
				listener.mockClear();
				guard.suppressAbortErrors();
				process.emit("uncaughtException", error);
				expect(listener).not.toHaveBeenCalled();
				// Same observed cause chain with SDK stall provenance is a retryable
				// network failure, never a user's cancellation.
				error.stack += "\nSDK stall signal: reportStall"; // Synthetic signal, not an observed SDK frame.
				expect(classifyCursorConnectError(error)).toEqual({ kind: "network", source: "cursor-sdk-stack" });
			} finally {
				process.off("uncaughtException", listener);
				guard.dispose();
			}
		} finally {
			for (const session of sessions) session.destroy();
			if ("closeAllConnections" in server) server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		}
	});
});
