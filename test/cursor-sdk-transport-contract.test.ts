import { createServer } from "node:http";
import { createServer as createHttp2Server, type ServerHttp2Session } from "node:http2";
import { once } from "node:events";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "@typescript/typescript6";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installedCursorModuleDeclarations, installedCursorModules } from "./helpers/cursor-sdk-installed-modules.js";
import { resolveInstalledPackageRoot } from "./helpers/installed-package.js";
import { classifyCursorConnectError, sanitizeCursorProviderError } from "../src/cursor-provider-errors.js";
import { installCursorSdkProcessErrorGuard } from "../src/cursor-sdk-process-error-guard.js";

afterEach(() => vi.unstubAllGlobals());

describe("installed SDK vendored Node transport", () => {
	it.each(["1.1", "2"] as const)("performs credential-free loopback HTTP/%s RPC and retains abort provenance", async (httpVersion) => {
		const modules = await installedCursorModules();
		const sdkRequire = createRequire(join(resolveInstalledPackageRoot("@cursor/sdk"), "dist/esm/index.js"));
		const protobuf = await import(pathToFileURL(sdkRequire.resolve("@bufbuild/protobuf")).href);
		const connect = await import(pathToFileURL(sdkRequire.resolve("@connectrpc/connect")).href);
		const { Empty, MethodKind } = modules("@bufbuild/protobuf");
		expect(Empty).toBe(protobuf.Empty);
		expect(modules("@connectrpc/connect").ConnectError).toBe(connect.ConnectError);
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

	it("classifies the installed stall detector's cut of a real request as a network failure", async () => {
		const modules = await installedCursorModules();
		const { Empty, MethodKind } = modules("@bufbuild/protobuf");
		const { createSafeConnectTransport } = modules("./src/agent/safe-connect-transport.ts");
		const rootContexts = Object.values(modules("../context/dist/core.js"))
			.flatMap((value) => typeof value === "function" && value.length === 0 ? [value() as { withCancel?: unknown }] : [])
			.filter((context) => typeof context?.withCancel === "function");
		expect(rootContexts).toHaveLength(1);
		const rootContext = rootContexts[0] as { withCancel(): [{ signal: AbortSignal }, (reason: unknown) => void] };
		const { declarations } = installedCursorModuleDeclarations(modules.factorySource("./src/agent/local-executor.ts"));
		const detectors = [...declarations.values()].filter((node) => ts.isClassDeclaration(node) && node.getText().includes("reportStall("));
		expect(detectors).toHaveLength(1);
		const StallDetector = modules.observeFactoryBinding<new (
			context: { signal: AbortSignal },
			options: { thresholdMs: number; onStall(reason: unknown): void },
		) => Disposable>("./src/agent/local-executor.ts", detectors[0]!.name!.text);
		const server = createServer((request) => { request.resume(); }); // Never answers: the detector must cut it.
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address() as { port: number };
		const transport = createSafeConnectTransport({ baseUrl: `http://127.0.0.1:${address.port}`, httpVersion: "1.1" });
		// The installed executor wires the detector the same way: its stall reason cancels the request context.
		const [context, cancel] = rootContext.withCancel();
		const reasons: unknown[] = [];
		const pending = transport.unary({ typeName: "offline.Contract" },
			{ name: "Wait", kind: MethodKind.Unary, I: Empty, O: Empty }, context.signal, 60_000, {}, new Empty());
		const detector = new StallDetector(context, { thresholdMs: 25, onStall: (reason) => { reasons.push(reason); cancel(reason); } });
		try {
			let error: any;
			try { await pending; } catch (caught) { error = caught; }
			expect(reasons).toHaveLength(1);
			const reason = reasons[0] as DOMException & { cursorStallCut?: boolean };
			expect(reason.name).toBe("AbortError");
			expect(reason.message).toBe("the stall detector cut the stream: no activity for 25 ms");
			expect(reason.cursorStallCut).toBe(true);
			expect(reason.stack).toContain("reportStall");
			expect(error).toMatchObject({ name: "ConnectError", code: 2, cause: { name: "ConnectError", code: 1 } });
			expect(error.message).toBe(`[unknown] [canceled] ${reason.message}`);
			expect(error.cause.cause).toBe(reason);
			expect(classifyCursorConnectError(error)).toEqual({ kind: "network", source: "cursor-sdk-stack" });
			const sanitized = sanitizeCursorProviderError(error, "test-key");
			expect(sanitized.toLowerCase()).toContain("network error");
			expect(sanitized).not.toContain("stall");
			const guard = installCursorSdkProcessErrorGuard();
			const listener = vi.fn();
			process.on("uncaughtException", listener);
			try {
				process.emit("uncaughtException", error);
				process.emit("uncaughtException", reason as unknown as Error);
				expect(listener).not.toHaveBeenCalled();
			} finally {
				process.off("uncaughtException", listener);
				guard.dispose();
			}
		} finally {
			detector[Symbol.dispose]();
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		}
	});
});
