import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import type {
	CursorPiToolBridge,
	CursorPiToolBridgeRun,
	CursorPiToolBridgeRunOptions,
	CursorPiToolBridgeSnapshotApi,
} from "./cursor-pi-tool-bridge-types.js";
import { asRecord } from "./cursor-record-utils.js";
import type { CursorPiToolBridgeRunImpl } from "./cursor-pi-tool-bridge-run.js";
import {
	buildCursorPiToolBridgeSnapshot,
	buildCursorPiToolBridgeSurfaceSignature,
	createEmptySnapshot,
	resolveCursorPiToolBridgeBuiltinsEnabled,
	resolveCursorPiToolBridgeEnabled,
} from "./cursor-pi-tool-bridge-snapshot.js";

export const LOOPBACK_HOST = "127.0.0.1";
const HTTP_SERVER_CLOSE_GRACE_MS = 250;

export class CursorPiToolBridgeRegistry implements CursorPiToolBridge {
	private readonly pi: CursorPiToolBridgeSnapshotApi;
	private readonly env: Record<string, string | undefined>;
	private readonly runs = new Set<CursorPiToolBridgeRunImpl>();
	private readonly routes = new Map<string, CursorPiToolBridgeRunImpl>();
	private httpServer?: HttpServer;
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

	getToolSurfaceSignature(): string {
		if (!this.isEnabled()) return "bridge:off";
		const snapshot = buildCursorPiToolBridgeSnapshot(this.pi, {
			exposeOverlappingBuiltins: resolveCursorPiToolBridgeBuiltinsEnabled(this.env),
		});
		return buildCursorPiToolBridgeSurfaceSignature(snapshot);
	}

	async createRun(options: CursorPiToolBridgeRunOptions = {}): Promise<CursorPiToolBridgeRun> {
		const bridgeEnabled = this.isEnabled();
		const snapshot = bridgeEnabled
			? buildCursorPiToolBridgeSnapshot(this.pi, {
				exposeOverlappingBuiltins: resolveCursorPiToolBridgeBuiltinsEnabled(this.env),
			})
			: createEmptySnapshot();
		const { CursorPiToolBridgeRunImpl } = await import("./cursor-pi-tool-bridge-run.js");
		const run = new CursorPiToolBridgeRunImpl(this, this.env, snapshot, bridgeEnabled && snapshot.tools.length > 0, options);
		this.runs.add(run);
		await run.start();
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
			if (!address) throw new Error("Cursor pi tool bridge HTTP server is not listening");
			return `http://${LOOPBACK_HOST}:${address.port}${pathname}`;
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
		const address = asRecord(this.httpServer?.address());
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
			this.httpServer = undefined;
			this.listenPromise = undefined;
			throw error;
		});
		await this.listenPromise;
	}

	private async startHttpServer(): Promise<void> {
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
		const server = createServer(getRequestListener(app.fetch));
		this.httpServer = server;
		await new Promise<void>((resolve, reject) => {
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
			server.listen(0, LOOPBACK_HOST);
		});
	}

	private async closeHttpServer(): Promise<void> {
		await this.listenPromise?.catch(() => undefined);
		const server = this.httpServer;
		if (!server) return;
		this.httpServer = undefined;
		this.listenPromise = undefined;
		await new Promise<void>((resolve, reject) => {
			let settled = false;
			let closeTimer: ReturnType<typeof setTimeout> | undefined;
			const settle = (error?: Error): void => {
				if (settled) return;
				settled = true;
				if (closeTimer) clearTimeout(closeTimer);
				if (error) reject(error);
				else resolve();
			};

			closeTimer = setTimeout(() => settle(), HTTP_SERVER_CLOSE_GRACE_MS);
			closeTimer.unref?.();

			server.close((error) => {
				settle(error ?? undefined);
			});
			server.closeIdleConnections();
			server.closeAllConnections();
		});
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
