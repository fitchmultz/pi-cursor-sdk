import { randomUUID } from "node:crypto";
import type { McpServerConfig } from "@cursor/sdk";
import type { Context, ToolResultMessage } from "@earendil-works/pi-ai";
import {
	type CallToolResult,
	Server as McpProtocolServer,
	WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { bridgeToolExecutionAbortTracker } from "./cursor-pi-tool-bridge-abort.js";
import {
	buildCursorPiBridgeToolCallId,
	MCP_ENDPOINT_ROOT,
	MCP_SERVER_NAME,
} from "./cursor-pi-tool-bridge-constants.js";
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
	CursorPiToolRequestHandler,
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

/** One Cursor MCP CallTool from receipt until its single settlement. */
interface PendingBridgeCall {
	readonly request: CursorPiBridgeToolRequest;
	/** `queued` awaits a handler or explicit claim, `dispatched` has been claimed, and `settled` is final. */
	disposition: "queued" | "dispatched" | "settled";
	readonly resolve: (result: CallToolResult) => void;
	readonly reject: (error: Error) => void;
	readonly signal?: AbortSignal;
	readonly onAbort: () => void;
	timeout?: ReturnType<typeof setTimeout>;
}

type PendingBridgeCallOutcome =
	| { kind: "resolved"; result: CallToolResult }
	| { kind: "rejected"; error: Error; rejectionKind: CursorPiToolBridgeRejectionKind };

/** `initial` queues requests for the first handler; `detached` rejects queued and later requests until a handler reattaches. */
type ToolRequestHandlerState =
	| { kind: "initial" }
	| { kind: "attached"; handler: CursorPiToolRequestHandler }
	| { kind: "detached" };

export class CursorPiToolBridgeRunImpl implements CursorPiToolBridgeRun {
	readonly id: string;
	readonly enabled: boolean;
	readonly snapshot: CursorPiToolBridgeSnapshot;
	mcpServers?: Record<string, McpServerConfig>;

	private readonly registry: CursorPiToolBridgeRunHost;
	private readonly env: Record<string, string | undefined>;
	private readonly endpointPath: string;
	private readonly runUuid: string;
	private readonly callTimeoutMs: number;
	private readonly knownMcpToolNames: ReadonlySet<string>;
	private readonly knownCursorMcpCallIds = new Set<string>();
	private readonly pendingToolCallListeners = new Set<() => void>();
	/** Unsettled calls in arrival order; only settlement removes them. */
	private readonly pendingByPiToolCallId = new Map<string, PendingBridgeCall>();
	private toolRequestHandler: ToolRequestHandlerState;
	private debugRecorder: CursorPiToolBridgeRunOptions["debugRecorder"];
	private mcpServer?: McpProtocolServer;
	private mcpTransport?: WebStandardStreamableHTTPServerTransport;
	private toolCallCounter = 0;
	private disposal?: Promise<void>;

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
		this.toolRequestHandler = options.onToolRequest
			? { kind: "attached", handler: options.onToolRequest }
			: { kind: "initial" };
		this.debugRecorder = options.debugRecorder;
		const runUuid = randomUUID();
		this.runUuid = runUuid;
		this.id = `cursor-pi-bridge-run-${runUuid}`;
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

	async handleHttpRequest(request: Request, parsedBody?: unknown): Promise<Response> {
		if (this.disposed || !this.mcpTransport) {
			return Response.json({ error: "Cursor pi tool bridge run is disposed" }, { status: 410 });
		}
		return this.mcpTransport.handleRequest(request, { parsedBody });
	}

	takeQueuedToolRequests(): CursorPiBridgeToolRequest[] {
		const queued = this.queuedCalls();
		for (const pending of queued) pending.disposition = "dispatched";
		return queued.map((pending) => pending.request);
	}

	setOnToolRequest(handler?: CursorPiToolRequestHandler): void {
		if (!handler) {
			this.toolRequestHandler = { kind: "detached" };
			this.rejectQueuedToolRequestsWithoutHandler("Cursor pi tool bridge has no active live run");
			return;
		}
		this.toolRequestHandler = { kind: "attached", handler };
		for (const pending of this.queuedCalls()) this.dispatchPendingToolRequest(pending, handler);
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
			if (!pending) continue;
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

	hasPendingToolCalls(): boolean {
		return this.pendingCount() > 0;
	}

	onPendingToolCallsChanged(listener: () => void): () => void {
		this.pendingToolCallListeners.add(listener);
		return () => { this.pendingToolCallListeners.delete(listener); };
	}

	private notifyPendingToolCallsChanged(): void {
		for (const listener of this.pendingToolCallListeners) {
			try { listener(); } catch {
				// Observers must not prevent call registration or protocol settlement.
			}
		}
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
		const calls = [...this.pendingByPiToolCallId.values()];
		if (calls.length > 0) {
			this.emitDiagnostic({
				event: "run_cancelled",
				...this.lifecycleDiagnosticFields(calls.length),
				queuedCount: calls.filter((pending) => pending.disposition === "queued").length,
				cancelledRequestCount: calls.length,
			});
		}
		for (const pending of calls) this.rejectAndAbortPending(pending, error, "cancelled");
	}

	private get disposed(): boolean {
		return this.disposal !== undefined;
	}

	dispose(): Promise<void> {
		this.disposal ??= this.disposeOnce();
		return this.disposal;
	}

	private async disposeOnce(): Promise<void> {
		this.cancel("Cursor pi tool bridge run disposed");
		this.pendingToolCallListeners.clear();
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
		const transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: randomUUID,
		});

		// ponytail: server-side receipts only, not SDK/model consumption or ongoing
		// connection health; upgrade when Cursor exposes public MCP lifecycle callbacks.
		server.oninitialized = () => {
			this.emitDiagnostic({ event: "mcp_initialized", runId: this.id });
		};
		server.setRequestHandler("tools/list", async () => {
			const tools = this.snapshot.tools.map(snapshotToolToMcpTool);
			this.emitDiagnostic({ event: "mcp_tools_list", runId: this.id, toolCount: tools.length });
			return { tools };
		});
		server.setRequestHandler("tools/call", async (request, context) => {
			return this.enqueueToolRequest(
				request.params.name,
				request.params.arguments,
				String(context.mcpReq.id),
				context.mcpReq.signal,
			);
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
		const piToolCallId = buildCursorPiBridgeToolCallId(this.runUuid, this.toolCallCounter);
		const request: CursorPiBridgeToolRequest = {
			runId: this.id,
			bridgeCallId,
			cursorMcpCallId,
			piToolCallId,
			piToolName,
			mcpToolName,
			args: normalizeMcpArgs(argsValue),
		};

		return new Promise<CallToolResult>((resolve, reject) => {
			const pending: PendingBridgeCall = {
				request,
				disposition: "queued",
				resolve,
				reject,
				signal,
				onAbort: () => {
					this.rejectAndAbortPending(pending, new Error("Cursor MCP bridge tool request was aborted"), "cancelled");
				},
			};
			if (signal?.aborted) {
				pending.onAbort();
				return;
			}
			signal?.addEventListener("abort", pending.onAbort, { once: true });
			this.pendingByPiToolCallId.set(request.piToolCallId, pending);
			this.knownCursorMcpCallIds.add(cursorMcpCallId);
			this.notifyPendingToolCallsChanged();
			pending.timeout = setTimeout(() => {
				const reason = `Cursor pi bridge CallTool timed out after ${this.callTimeoutMs} ms`;
				this.rejectAndAbortPending(pending, new Error(reason));
			}, this.callTimeoutMs);
			pending.timeout.unref?.();
			const handlerState = this.toolRequestHandler;
			if (handlerState.kind === "detached") {
				this.rejectPending(pending, new Error("Cursor pi tool bridge has no active live run"), "cancelled");
				return;
			}
			this.emitRequestQueuedDiagnostic(request);
			this.recordBridgeRaw({ kind: "queued", request });
			if (handlerState.kind === "attached") this.dispatchPendingToolRequest(pending, handlerState.handler);
		});
	}

	private queuedCalls(): PendingBridgeCall[] {
		return [...this.pendingByPiToolCallId.values()].filter((pending) => pending.disposition === "queued");
	}

	/** Hands a still-queued call to its handler exactly once. */
	private dispatchPendingToolRequest(
		pending: PendingBridgeCall,
		handler: CursorPiToolRequestHandler,
	): void {
		if (pending.disposition !== "queued") return;
		pending.disposition = "dispatched";
		try {
			handler(pending.request);
		} catch (error) {
			this.rejectPending(pending, error instanceof Error ? error : new Error(String(error)), "error");
		}
	}

	private rejectQueuedToolRequestsWithoutHandler(reason: string): void {
		for (const pending of this.queuedCalls()) this.rejectPending(pending, new Error(reason), "cancelled");
	}

	/** The only way out of pending: clears the MCP abort listener and deadline, leaves the index, then answers Cursor once. */
	private settle(pending: PendingBridgeCall, outcome: PendingBridgeCallOutcome): boolean {
		if (pending.disposition === "settled") return false;
		pending.disposition = "settled";
		pending.signal?.removeEventListener("abort", pending.onAbort);
		clearTimeout(pending.timeout);
		if (this.pendingByPiToolCallId.delete(pending.request.piToolCallId)) this.notifyPendingToolCallsChanged();
		if (outcome.kind === "resolved") {
			this.emitRequestResolvedDiagnostic(pending.request, outcome.result.isError === true);
			this.recordBridgeRaw({ kind: "resolved", request: pending.request, result: outcome.result });
			pending.resolve(outcome.result);
		} else {
			this.emitRequestRejectedDiagnostic(pending.request, outcome.rejectionKind);
			this.recordBridgeRaw({
				kind: "rejected",
				request: pending.request,
				error: outcome.error.message,
				rejectionKind: outcome.rejectionKind,
			});
			pending.reject(outcome.error);
		}
		return true;
	}

	private resolvePending(pending: PendingBridgeCall, result: CallToolResult): void {
		this.settle(pending, { kind: "resolved", result });
	}

	private rejectPending(pending: PendingBridgeCall, error: Error, kind: CursorPiToolBridgeRejectionKind = "error"): boolean {
		return this.settle(pending, { kind: "rejected", error, rejectionKind: kind });
	}

	private rejectAndAbortPending(
		pending: PendingBridgeCall,
		error: Error,
		kind: CursorPiToolBridgeRejectionKind = "error",
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
		return this.pendingByPiToolCallId.size;
	}
}
