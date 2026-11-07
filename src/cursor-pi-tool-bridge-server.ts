import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Tool } from "@earendil-works/pi-ai";
import type {
	CursorPiToolBridge,
	CursorPiToolBridgeRun,
	CursorPiToolBridgeRunOptions,
	CursorPiToolBridgeSnapshotApi,
} from "./cursor-pi-tool-bridge-types.js";
import {
	resolveCursorPiToolBridgePortRange,
	resolveCursorPiToolBridgeUrlHost,
} from "./cursor-pi-tool-bridge-env.js";
import { asRecord } from "./cursor-record-utils.js";
import { CursorPiToolBridgeRunImpl } from "./cursor-pi-tool-bridge-run.js";
import {
	buildCursorPiToolBridgeSnapshot,
	buildCursorPiToolBridgeSurfaceSignature,
	createEmptySnapshot,
	resolveCursorPiToolBridgeBuiltinsEnabled,
	resolveCursorPiToolBridgeEnabled,
} from "./cursor-pi-tool-bridge-snapshot.js";

const LOOPBACK_HOST = "127.0.0.1";
const HTTP_SERVER_CLOSE_GRACE_MS = 250;
const EPHEMERAL_BIND_ATTEMPTS = 10;

function listenOnce(server: HttpServer, port: number, host = LOOPBACK_HOST): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const onError = (error: Error) => {
			server.off("listening", onListening);
			reject(error);
		};
		const onListening = () => {
			server.off("error", onError);
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen({ port, host, ipv6Only: host === "::1" });
	});
}

async function closeServers(servers: readonly HttpServer[]): Promise<void> {
	await Promise.all(servers.map(async (server) => {
		if (!server.listening) return;
		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const settle = (error?: Error): void => {
				if (settled) return;
				settled = true;
				clearTimeout(closeTimer);
				if (error) reject(error);
				else resolve();
			};
			const closeTimer = setTimeout(() => settle(), HTTP_SERVER_CLOSE_GRACE_MS);
			closeTimer.unref?.();
			server.close((error) => settle(error ?? undefined));
			server.closeIdleConnections();
			server.closeAllConnections();
		});
	}));
}

export class CursorPiToolBridgeRegistry implements CursorPiToolBridge {
	private readonly pi: CursorPiToolBridgeSnapshotApi;
	private readonly env: Record<string, string | undefined>;
	private readonly runs = new Set<CursorPiToolBridgeRunImpl>();
	private readonly routes = new Map<string, CursorPiToolBridgeRunImpl>();
	private httpServers: HttpServer[] = [];
	private advertisedHost?: string;
	private listenPromise?: Promise<void>;
	private serverLifecycle = Promise.resolve();

	constructor(
		pi: CursorPiToolBridgeSnapshotApi,
		env: Record<string, string | undefined> = process.env,
	) {
		this.pi = pi;
		this.env = env;
	}

	isEnabled(): boolean {
		return resolveCursorPiToolBridgeEnabled(this.env);
	}

	getToolSurfaceSignature(declaredTools?: readonly Tool[]): string {
		if (!this.isEnabled()) return "bridge:off";
		const snapshot = buildCursorPiToolBridgeSnapshot(this.pi, {
			exposeOverlappingBuiltins: resolveCursorPiToolBridgeBuiltinsEnabled(this.env),
			declaredTools,
		});
		return buildCursorPiToolBridgeSurfaceSignature(snapshot);
	}

	async createRun(options: CursorPiToolBridgeRunOptions = {}): Promise<CursorPiToolBridgeRun> {
		const bridgeEnabled = this.isEnabled();
		const snapshot = bridgeEnabled
			? buildCursorPiToolBridgeSnapshot(this.pi, {
				exposeOverlappingBuiltins: resolveCursorPiToolBridgeBuiltinsEnabled(this.env),
				declaredTools: options.declaredTools,
			})
			: createEmptySnapshot();
		const run = new CursorPiToolBridgeRunImpl(this, this.env, snapshot, bridgeEnabled && snapshot.tools.length > 0, options);
		this.runs.add(run);
		try {
			await run.start();
		} catch (error) {
			try { await run.dispose(); }
			catch { /* Preserve the original startup failure, not a secondary cleanup error. */ }
			this.runs.delete(run);
			throw error;
		}
		run.emitStartDiagnostics(bridgeEnabled);
		return run;
	}

	async disposeAll(reason = "Cursor pi tool bridge disposed"): Promise<void> {
		await Promise.all([...this.runs].map(async (run) => {
			run.cancel(reason);
			await run.dispose();
		}));
	}

	async registerRun(pathname: string, run: CursorPiToolBridgeRunImpl): Promise<string> {
		return this.serializeServerLifecycle(async () => {
			await this.ensureHttpServer();
			this.routes.set(pathname, run);
			const address = this.getHttpServerAddress();
			if (!address || !this.advertisedHost) throw new Error("Cursor pi tool bridge HTTP server is not listening");
			return `http://${this.advertisedHost}:${address.port}${pathname}`;
		});
	}

	async unregisterRun(pathname: string, run: CursorPiToolBridgeRunImpl): Promise<void> {
		await this.serializeServerLifecycle(async () => {
			if (this.routes.get(pathname) === run) this.routes.delete(pathname);
			this.runs.delete(run);
			if (this.routes.size === 0) await this.closeHttpServer();
		});
	}

	private serializeServerLifecycle<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.serverLifecycle.then(operation, operation);
		this.serverLifecycle = result.then(() => undefined, () => undefined);
		return result;
	}

	getHttpServerAddress(): AddressInfo | undefined {
		const address = asRecord(this.httpServers[0]?.address());
		if (typeof address?.port !== "number") return undefined;
		return {
			address: typeof address.address === "string" ? address.address : LOOPBACK_HOST,
			family: typeof address.family === "string" ? address.family : "IPv4",
			port: address.port,
		};
	}

	getEndpointCount(): number {
		return this.routes.size;
	}

	hasPendingPiToolCallId(piToolCallId: string): boolean {
		for (const run of this.runs) {
			if (run.hasPendingPiToolCallId(piToolCallId)) return true;
		}
		return false;
	}

	cancelPendingPiToolCallId(piToolCallId: string, reason: string): boolean {
		for (const run of this.runs) {
			if (run.cancelPendingPiToolCallId(piToolCallId, reason)) return true;
		}
		return false;
	}

	private async ensureHttpServer(): Promise<void> {
		this.listenPromise ??= this.startHttpServer().catch((error: unknown) => {
			this.httpServers = [];
			this.advertisedHost = undefined;
			this.listenPromise = undefined;
			throw error;
		});
		await this.listenPromise;
	}

	private async startHttpServer(): Promise<void> {
		// A hostname is a listener policy, not a mutable per-run URL preference.
		const advertisedHost = resolveCursorPiToolBridgeUrlHost(this.env);
		const range = resolveCursorPiToolBridgePortRange(this.env);
		const [{ getRequestListener }, { createMcpHonoApp }] = await Promise.all([
			import("@hono/node-server"),
			import("@modelcontextprotocol/hono"),
		]);
		const app = createMcpHonoApp({ host: LOOPBACK_HOST });
		app.all("*", (context) => {
			const parsedBody = (
				context as typeof context & { get(key: "parsedBody"): unknown }
			).get("parsedBody");
			return this.handleHttpRequest(context.req.raw, parsedBody);
		});
		const listener = getRequestListener(app.fetch, { overrideGlobalObjects: false });
		const attempts = range ? range.last - range.first + 1 : advertisedHost === "localhost" ? EPHEMERAL_BIND_ATTEMPTS : 1;
		for (let attempt = 0; attempt < attempts; attempt += 1) {
			const servers = [createServer(listener)];
			try {
				await listenOnce(servers[0]!, range ? range.first + attempt : 0);
				if (advertisedHost === "localhost") {
					const port = (servers[0]!.address() as AddressInfo).port;
					const ipv6 = createServer(listener);
					servers.push(ipv6);
					// Own both explicit loopbacks before publishing any tokenized URL.
					await listenOnce(ipv6, port, "::1");
				}
				this.httpServers = servers;
				this.advertisedHost = advertisedHost;
				return;
			} catch (error) {
				try { await closeServers(servers); }
				catch { throw error; } // Never retry or replace the bind failure when rollback fails.
				if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || (!range && advertisedHost !== "localhost")) throw error;
			}
		}
		if (range) throw new Error(`Cursor pi tool bridge could not listen on any port in ${range.first}-${range.last} (all in use)`);
		throw new Error("Cursor pi tool bridge could not own both localhost loopback listeners on an ephemeral port");
	}

	private async closeHttpServer(): Promise<void> {
		await this.listenPromise?.catch(() => undefined);
		const servers = this.httpServers;
		this.httpServers = [];
		this.advertisedHost = undefined;
		this.listenPromise = undefined;
		await closeServers(servers);
	}

	private async handleHttpRequest(request: Request, parsedBody?: unknown): Promise<Response> {
		const url = new URL(request.url);
		const run = this.routes.get(url.pathname);
		if (!run) {
			return Response.json({ error: "Cursor pi tool bridge endpoint not found" }, { status: 404 });
		}

		try {
			return await run.handleHttpRequest(request, parsedBody);
		} catch (error) {
			return Response.json(
				{ error: error instanceof Error ? error.message : String(error) },
				{ status: 500 },
			);
		}
	}
}
