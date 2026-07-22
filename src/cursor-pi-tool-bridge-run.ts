import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpServerConfig } from "@cursor/sdk";
import type { Context, ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { Server as McpProtocolServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
	type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { bridgeToolExecutionAbortTracker } from "./cursor-pi-tool-bridge-abort.js";
import { MCP_ENDPOINT_ROOT, MCP_SERVER_NAME } from "./cursor-pi-tool-bridge-constants.js";
import {
	type CursorPiToolBridgeDiagnosticEvent,
	type CursorPiToolBridgeLifecycleDiagnosticFields,
	type CursorPiToolBridgeRejectionKind,
	type CursorPiToolBridgeRequestDiagnosticFields,
	writeCursorPiToolBridgeDiagnostic,
} from "./cursor-pi-tool-bridge-diagnostics.js";
import { resolveCursorPiToolBridgeCallTimeoutMs } from "./cursor-pi-tool-bridge-env.js";
import type {
	CursorPiBridgeToolRequest,
	CursorPiToolBridgeRun,
	CursorPiToolBridgeRunOptions,
	CursorPiToolBridgeSnapshot,
} from "./cursor-pi-tool-bridge-types.js";
import {
	asToolResultMessage,
	containsKnownMcpToolName,
	convertPiContentToMcpContent,
	normalizeMcpArgs,
	snapshotToolToMcpTool,
	waitForProtocolFlush,
} from "./cursor-pi-tool-bridge-mcp.js";
import { asRecord, getFirstStringByKeys } from "./cursor-record-utils.js";

export interface CursorPiToolBridgeRunHost {
	registerRun(pathname: string, run: CursorPiToolBridgeRunImpl): Promise<string>;
	unregisterRun(pathname: string, run: CursorPiToolBridgeRunImpl): Promise<void>;
}

const MCP_SERVER_VERSION = "0.1.0";

interface PendingBridgeCall {
	request: CursorPiBridgeToolRequest;
	resolve: (result: CallToolResult) => void;
	reject: (error: Error) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
	timeout?: ReturnType<typeof setTimeout>;
	settled: boolean;
}

export class CursorPiToolBridgeRunImpl implements CursorPiToolBridgeRun {
	readonly id: string;
	readonly enabled: boolean;
	readonly snapshot: CursorPiToolBridgeSnapshot;
	mcpServers?: Record<string, McpServerConfig>;

	private readonly registry: CursorPiToolBridgeRunHost;
	private readonly env: Record<string, string | undefined>;
	private readonly endpointPath: string;
	private readonly callTimeoutMs: number;
	private readonly knownMcpToolNames: ReadonlySet<string>;
	private readonly knownCursorMcpCallIds = new Set<string>();
	private readonly queuedRequests: CursorPiBridgeToolRequest[] = [];
	private readonly pendingByPiToolCallId = new Map<string, PendingBridgeCall>();
	private readonly pendingByBridgeCallId = new Map<string, PendingBridgeCall>();
	private readonly pendingByCursorMcpCallId = new Map<string, PendingBridgeCall>();
	private onToolRequest?: (request: CursorPiBridgeToolRequest) => void;
	private debugRecorder: CursorPiToolBridgeRunOptions["debugRecorder"];
	private liveRunHandlerDetached = false;
	private mcpServer?: McpProtocolServer;
	private mcpTransport?: StreamableHTTPServerTransport;
	private toolCallCounter = 0;
	private disposed = false;

	constructor(
		registry: CursorPiToolBridgeRunHost,
		env: Record<string, string | undefined>,
		snapshot: CursorPiToolBridgeSnapshot,
		enabled: boolean,
		options: CursorPiToolBridgeRunOptions = {},
	) {
		this.registry = registry;
		this.env = env;
		this.snapshot = snapshot;
		this.enabled = enabled;
		this.onToolRequest = options.onToolRequest;
		this.debugRecorder = options.debugRecorder;
		this.id = `cursor-pi-bridge-run-${randomUUID()}`;
		this.endpointPath = `${MCP_ENDPOINT_ROOT}/${randomUUID()}/mcp`;
		this.callTimeoutMs = resolveCursorPiToolBridgeCallTimeoutMs(env);
		this.knownMcpToolNames = new Set(snapshot.tools.map((tool) => tool.mcpToolName));
	}

	async start(): Promise<void> {
		if (!this.enabled) return;
		await this.createMcpServer();
		const endpointUrl = await this.registry.registerRun(this.endpointPath, this);
		this.mcpServers = { [MCP_SERVER_NAME]: { type: "http", url: endpointUrl } };
	}

	emitStartDiagnostics(bridgeEnabled: boolean): void {
		const base = this.lifecycleDiagnosticFields();
		this.emitDiagnostic({ event: "run_created", ...base });
		if (!this.enabled) {
			this.emitDiagnostic({
				event: "run_skipped",
				...base,
				reason: bridgeEnabled ? "no_exposed_tools" : "disabled",
			});
			return;
		}
		this.emitDiagnostic({
			event: "tools_exposed",
			...base,
			pairs: this.snapshot.tools.map((tool) => ({
				piToolName: tool.piToolName,
				mcpToolName: tool.mcpToolName,
			})),
		});
	}

	async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (this.disposed || !this.mcpTransport) {
			res.writeHead(410, { "content-type": "application/json" }).end(JSON.stringify({ error: "Cursor pi tool bridge run is disposed" }));
			return;
		}
		await this.mcpTransport.handleRequest(req, res);
	}

	takeQueuedToolRequests(): CursorPiBridgeToolRequest[] {
		return this.queuedRequests.splice(0);
	}

	setOnToolRequest(handler?: (request: CursorPiBridgeToolRequest) => void): void {
		if (!handler) {
			this.liveRunHandlerDetached = true;
			this.rejectQueuedToolRequestsWithoutHandler("Cursor pi tool bridge has no active live run");
		} else {
			this.liveRunHandlerDetached = false;
		}
		this.onToolRequest = handler;
		if (handler) {
			for (const request of this.queuedRequests.splice(0)) {
				const pending = this.pendingByPiToolCallId.get(request.piToolCallId);
				if (pending) this.dispatchPendingToolRequest(pending, handler);
			}
		}
	}

	setDebugRecorder(recorder?: CursorPiToolBridgeRunOptions["debugRecorder"]): void {
		this.debugRecorder = recorder;
	}

	private recordBridgeRaw(
		payload: Parameters<NonNullable<CursorPiToolBridgeRunOptions["debugRecorder"]>["recordBridgeRaw"]>[0],
	): void {
		try {
			this.debugRecorder?.recordBridgeRaw(payload);
		} catch {
			// Debug capture must never block or strand a bridge call.
		}
	}

	async resolveToolResults(toolResults: readonly ToolResultMessage[]): Promise<void> {
		let resolvedCount = 0;
		for (const toolResult of toolResults) {
			const pending = this.pendingByPiToolCallId.get(toolResult.toolCallId);
			if (!pending || pending.settled) continue;
			this.resolvePending(pending, {
				content: convertPiContentToMcpContent(toolResult.content),
				isError: toolResult.isError || undefined,
			});
			resolvedCount += 1;
		}
		if (resolvedCount > 0) await waitForProtocolFlush();
	}

	async resolveToolResultsFromContext(context: Context): Promise<void> {
		await this.resolveToolResults(context.messages.map(asToolResultMessage).filter((message): message is ToolResultMessage => message !== undefined));
	}

	hasPendingPiToolCallId(piToolCallId: string): boolean {
		return this.pendingByPiToolCallId.has(piToolCallId);
	}

	cancelPendingPiToolCallId(piToolCallId: string, reason: string): boolean {
		const pending = this.pendingByPiToolCallId.get(piToolCallId);
		if (!pending) return false;
		this.rejectPending(pending, new Error(reason), "cancelled");
		return true;
	}

	isBridgeMcpToolCall(toolCall: unknown): boolean {
		const record = asRecord(toolCall);
		if (!record) return false;
		const toolName = getFirstStringByKeys(record, ["name", "toolName", "mcpToolName"], { nonEmpty: true });
		if (toolName && this.knownMcpToolNames.has(toolName)) return true;

		const isMcpEnvelope = toolName === "mcp" || toolName === MCP_SERVER_NAME;
		const cursorMcpCallId = getFirstStringByKeys(record, ["call_id", "callId", "id", "toolCallId", "requestId"], { nonEmpty: true });
		if (cursorMcpCallId && this.knownCursorMcpCallIds.has(cursorMcpCallId) && isMcpEnvelope) return true;

		if (containsKnownMcpToolName(toolCall, this.knownMcpToolNames)) return true;

		return false;
	}

	cancel(reason: string): void {
		const error = new Error(reason);
		const pendingCount = this.pendingCount();
		const queuedCount = this.queuedRequests.length;
		if (pendingCount > 0 || queuedCount > 0) {
			this.emitDiagnostic({
				event: "run_cancelled",
				...this.lifecycleDiagnosticFields(pendingCount),
				queuedCount,
				cancelledRequestCount: pendingCount,
			});
		}
		this.queuedRequests.splice(0);
		for (const pending of [...this.pendingByBridgeCallId.values()]) {
			this.rejectAndAbortPending(pending, error, "cancelled");
		}
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.cancel("Cursor pi tool bridge run disposed");
		await waitForProtocolFlush();
		await Promise.allSettled([
			this.mcpTransport?.close(),
			this.mcpServer?.close(),
		]);
		await this.registry.unregisterRun(this.endpointPath, this);
		this.emitDiagnostic({
			event: "run_disposed",
			...this.lifecycleDiagnosticFields(),
		});
	}

	private async createMcpServer(): Promise<void> {
		const server = new McpProtocolServer(
			{ name: "pi-cursor-sdk-tool-bridge", version: MCP_SERVER_VERSION },
			{ capabilities: { tools: {} } },
		);
		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: randomUUID,
		});

		server.setRequestHandler(ListToolsRequestSchema, async () => ({
			tools: this.snapshot.tools.map(snapshotToolToMcpTool),
		}));
		server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
			return this.enqueueToolRequest(request.params.name, request.params.arguments, String(extra.requestId), extra.signal);
		});

		this.mcpServer = server;
		this.mcpTransport = transport;
		await server.connect(transport);
	}

	private enqueueToolRequest(mcpToolName: string, argsValue: unknown, cursorMcpCallId: string, signal?: AbortSignal): Promise<CallToolResult> {
		const piToolName = this.snapshot.mcpToolNameToPiToolName.get(mcpToolName);
		if (!piToolName) {
			return Promise.resolve({
				content: [{ type: "text", text: `Unknown pi bridge tool: ${mcpToolName}` }],
				isError: true,
			});
		}
		if (this.disposed) return Promise.reject(new Error("Cursor pi tool bridge run is disposed"));

		this.toolCallCounter += 1;
		const bridgeCallId = `${this.id}-bridge-${this.toolCallCounter}`;
		const request: CursorPiBridgeToolRequest = {
			runId: this.id,
			bridgeCallId,
			cursorMcpCallId,
			piToolCallId: `${this.id}-tool-${this.toolCallCounter}`,
			piToolName,
			mcpToolName,
			args: normalizeMcpArgs(argsValue),
		};

		return new Promise<CallToolResult>((resolve, reject) => {
			const pending: PendingBridgeCall = {
				request,
				resolve,
				reject,
				signal,
				settled: false,
			};
			pending.onAbort = () => {
				this.rejectAndAbortPending(pending, new Error("Cursor MCP bridge tool request was aborted"), "cancelled");
			};
			if (signal?.aborted) {
				pending.onAbort();
				return;
			}
			signal?.addEventListener("abort", pending.onAbort, { once: true });
			this.pendingByPiToolCallId.set(request.piToolCallId, pending);
			this.pendingByBridgeCallId.set(request.bridgeCallId, pending);
			this.pendingByCursorMcpCallId.set(cursorMcpCallId, pending);
			this.knownCursorMcpCallIds.add(cursorMcpCallId);
			pending.timeout = setTimeout(() => {
				const reason = `Cursor pi bridge CallTool timed out after ${this.callTimeoutMs} ms`;
				this.rejectAndAbortPending(pending, new Error(reason));
			}, this.callTimeoutMs);
			pending.timeout.unref?.();
			if (!this.onToolRequest) {
				if (this.liveRunHandlerDetached) {
					this.rejectPending(pending, new Error("Cursor pi tool bridge has no active live run"), "cancelled");
					return;
				}
				this.queuedRequests.push(request);
				this.emitRequestQueuedDiagnostic(request);
				this.recordBridgeRaw({ kind: "queued", request });
				return;
			}
			this.emitRequestQueuedDiagnostic(request);
			this.recordBridgeRaw({ kind: "queued", request });
			this.dispatchPendingToolRequest(pending, this.onToolRequest);
		});
	}

	private dispatchPendingToolRequest(
		pending: PendingBridgeCall,
		handler: (request: CursorPiBridgeToolRequest) => void,
	): void {
		try {
			handler(pending.request);
		} catch (error) {
			this.rejectPending(pending, error instanceof Error ? error : new Error(String(error)), "error");
		}
	}

	private rejectQueuedToolRequestsWithoutHandler(reason: string): void {
		while (this.queuedRequests.length > 0) {
			const request = this.queuedRequests.shift()!;
			const pending = this.pendingByPiToolCallId.get(request.piToolCallId);
			if (pending) this.rejectPending(pending, new Error(reason), "cancelled");
		}
	}

	private resolvePending(pending: PendingBridgeCall, result: CallToolResult): void {
		if (pending.settled) return;
		pending.settled = true;
		this.removePending(pending);
		this.emitRequestResolvedDiagnostic(pending.request, result.isError === true);
		this.recordBridgeRaw({ kind: "resolved", request: pending.request, result });
		pending.resolve(result);
	}

	private rejectPending(pending: PendingBridgeCall, error: Error, kind: "cancelled" | "error" = "error"): boolean {
		if (pending.settled) return false;
		pending.settled = true;
		this.removePending(pending);
		this.emitRequestRejectedDiagnostic(pending.request, kind);
		this.recordBridgeRaw({
			kind: "rejected",
			request: pending.request,
			error: error.message,
			rejectionKind: kind,
		});
		pending.reject(error);
		return true;
	}

	private rejectAndAbortPending(
		pending: PendingBridgeCall,
		error: Error,
		kind: "cancelled" | "error" = "error",
	): void {
		if (this.rejectPending(pending, error, kind)) {
			bridgeToolExecutionAbortTracker.abort(pending.request.piToolCallId, error.message);
		}
	}

	private lifecycleDiagnosticFields(pendingCount = this.pendingCount()): CursorPiToolBridgeLifecycleDiagnosticFields {
		return {
			runId: this.id,
			enabled: this.enabled,
			exposedToolCount: this.snapshot.tools.length,
			pendingCount,
		};
	}

	private requestDiagnosticFields(request: CursorPiBridgeToolRequest): CursorPiToolBridgeRequestDiagnosticFields {
		return {
			runId: this.id,
			bridgeCallId: request.bridgeCallId,
			cursorMcpCallId: request.cursorMcpCallId,
			piToolCallId: request.piToolCallId,
			mcpToolName: request.mcpToolName,
			piToolName: request.piToolName,
			pendingCount: this.pendingCount(),
		};
	}

	private emitRequestQueuedDiagnostic(request: CursorPiBridgeToolRequest): void {
		this.emitDiagnostic({ event: "request_queued", ...this.requestDiagnosticFields(request) });
	}

	private emitRequestResolvedDiagnostic(request: CursorPiBridgeToolRequest, isError: boolean): void {
		this.emitDiagnostic({ event: "request_resolved", ...this.requestDiagnosticFields(request), isError });
	}

	private emitRequestRejectedDiagnostic(request: CursorPiBridgeToolRequest, rejectionKind: CursorPiToolBridgeRejectionKind): void {
		this.emitDiagnostic({ event: "request_rejected", ...this.requestDiagnosticFields(request), rejectionKind });
	}

	private emitDiagnostic(event: CursorPiToolBridgeDiagnosticEvent): void {
		writeCursorPiToolBridgeDiagnostic(this.env, event, this.debugRecorder);
	}

	private pendingCount(): number {
		return this.pendingByBridgeCallId.size;
	}

	private removePending(pending: PendingBridgeCall): void {
		if (pending.onAbort) pending.signal?.removeEventListener("abort", pending.onAbort);
		if (pending.timeout) clearTimeout(pending.timeout);
		this.pendingByPiToolCallId.delete(pending.request.piToolCallId);
		this.pendingByBridgeCallId.delete(pending.request.bridgeCallId);
		if (pending.request.cursorMcpCallId) this.pendingByCursorMcpCallId.delete(pending.request.cursorMcpCallId);
		const queuedIndex = this.queuedRequests.findIndex((request) => request.bridgeCallId === pending.request.bridgeCallId);
		if (queuedIndex >= 0) this.queuedRequests.splice(queuedIndex, 1);
	}
}
