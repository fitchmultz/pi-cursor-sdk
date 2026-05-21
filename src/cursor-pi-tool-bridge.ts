import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { McpServerConfig } from "@cursor/sdk";
import type { Context } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import { Server as McpProtocolServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
	type CallToolResult,
	type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { isExcludedFromCursorBridgeExposure } from "./cursor-tool-names.js";

const CURSOR_PI_TOOL_BRIDGE_ENV = "PI_CURSOR_PI_TOOL_BRIDGE";
const CURSOR_PI_TOOL_BRIDGE_BUILTINS_ENV = "PI_CURSOR_EXPOSE_BUILTIN_TOOLS";
const LOOPBACK_HOST = "127.0.0.1";
const MCP_SERVER_NAME = "pi_tools";
const MCP_ENDPOINT_ROOT = "/cursor-pi-tool-bridge";
const MCP_SERVER_VERSION = "0.1.0";
const HTTP_SERVER_CLOSE_GRACE_MS = 250;
const DISABLED_ENV_VALUES = new Set(["0", "false", "off", "none", "no", "disabled"]);
const ENABLED_ENV_VALUES = new Set(["1", "true", "on", "yes", "enabled"]);
const OVERLAPPING_CURSOR_NATIVE_PI_BUILTIN_TOOL_NAMES = new Set(["read", "bash", "write", "edit", "grep", "find", "ls"]);

export interface CursorPiMcpInputSchema {
	type: "object";
	properties?: Record<string, object>;
	required?: string[];
	[key: string]: unknown;
}

export interface CursorPiBridgeToolDefinition {
	piToolName: string;
	mcpToolName: string;
	description: string;
	inputSchema: CursorPiMcpInputSchema;
	sourceInfo: ToolInfo["sourceInfo"];
}

export interface CursorPiToolBridgeSnapshot {
	tools: CursorPiBridgeToolDefinition[];
	mcpToolNameToPiToolName: ReadonlyMap<string, string>;
	piToolNameToMcpToolName: ReadonlyMap<string, string>;
}

export interface CursorPiToolBridgeSnapshotOptions {
	exposeOverlappingBuiltins?: boolean;
}

export interface CursorPiBridgeToolRequest {
	runId: string;
	bridgeCallId: string;
	cursorMcpCallId?: string;
	piToolCallId: string;
	piToolName: string;
	mcpToolName: string;
	args: Record<string, unknown>;
}

export interface CursorPiToolBridgeRun {
	id: string;
	enabled: boolean;
	mcpServers?: Record<string, McpServerConfig>;
	snapshot: CursorPiToolBridgeSnapshot;
	takeQueuedToolRequests(): CursorPiBridgeToolRequest[];
	resolveToolResultsFromContext(context: Context): void;
	hasPendingPiToolCallId(piToolCallId: string): boolean;
	isBridgeMcpToolCall(toolCall: unknown): boolean;
	cancel(reason: string): void;
	dispose(): Promise<void>;
}

export interface CursorPiToolBridgeRunOptions {
	onToolRequest?: (request: CursorPiBridgeToolRequest) => void;
}

export interface CursorPiToolBridge {
	isEnabled(): boolean;
	createRun(options?: CursorPiToolBridgeRunOptions): Promise<CursorPiToolBridgeRun>;
	disposeAll(reason?: string): Promise<void>;
}

interface PendingBridgeCall {
	request: CursorPiBridgeToolRequest;
	resolve: (result: CallToolResult) => void;
	reject: (error: Error) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
	settled: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function normalizeMcpInputSchema(schema: unknown): CursorPiMcpInputSchema {
	if (isRecord(schema) && schema.type === "object") return schema as CursorPiMcpInputSchema;
	return { type: "object", properties: {} };
}

function normalizeMcpArgs(args: unknown): Record<string, unknown> {
	return isRecord(args) ? { ...args } : {};
}

function waitForProtocolFlush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function sanitizeMcpToolNameStem(toolName: string): string {
	const stem = toolName
		.trim()
		.replace(/[^A-Za-z0-9_-]+/g, "_")
		.replace(/^_+|_+$/g, "");
	return stem || "tool";
}

function stableNameHash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

function createMcpToolName(piToolName: string, usedMcpToolNames: Set<string>): string {
	const baseName = `pi__${sanitizeMcpToolNameStem(piToolName)}`;
	if (!usedMcpToolNames.has(baseName)) {
		usedMcpToolNames.add(baseName);
		return baseName;
	}

	const hashedName = `${baseName}__${stableNameHash(piToolName)}`;
	if (!usedMcpToolNames.has(hashedName)) {
		usedMcpToolNames.add(hashedName);
		return hashedName;
	}

	let counter = 2;
	let candidate = `${hashedName}_${counter}`;
	while (usedMcpToolNames.has(candidate)) {
		counter += 1;
		candidate = `${hashedName}_${counter}`;
	}
	usedMcpToolNames.add(candidate);
	return candidate;
}

function createEmptySnapshot(): CursorPiToolBridgeSnapshot {
	return {
		tools: [],
		mcpToolNameToPiToolName: new Map(),
		piToolNameToMcpToolName: new Map(),
	};
}

export function resolveCursorPiToolBridgeEnabled(env: Record<string, string | undefined> = process.env): boolean {
	const raw = env[CURSOR_PI_TOOL_BRIDGE_ENV]?.trim().toLowerCase();
	if (!raw) return true;
	if (DISABLED_ENV_VALUES.has(raw)) return false;
	if (ENABLED_ENV_VALUES.has(raw)) return true;
	return true;
}

export function resolveCursorPiToolBridgeBuiltinsEnabled(env: Record<string, string | undefined> = process.env): boolean {
	const raw = env[CURSOR_PI_TOOL_BRIDGE_BUILTINS_ENV]?.trim().toLowerCase();
	if (!raw) return false;
	if (ENABLED_ENV_VALUES.has(raw)) return true;
	if (DISABLED_ENV_VALUES.has(raw)) return false;
	return false;
}

function isOverlappingCursorNativePiToolName(toolName: string): boolean {
	return OVERLAPPING_CURSOR_NATIVE_PI_BUILTIN_TOOL_NAMES.has(toolName);
}

export function buildCursorPiToolBridgeSnapshot(
	pi: Pick<ExtensionAPI, "getActiveTools" | "getAllTools">,
	options: CursorPiToolBridgeSnapshotOptions = {},
): CursorPiToolBridgeSnapshot {
	const activeToolNames = new Set(pi.getActiveTools());
	const allTools = pi.getAllTools();
	const usedMcpToolNames = new Set<string>();
	const mcpToolNameToPiToolName = new Map<string, string>();
	const piToolNameToMcpToolName = new Map<string, string>();
	const tools: CursorPiBridgeToolDefinition[] = [];

	const exposeOverlappingBuiltins = options.exposeOverlappingBuiltins === true;

	for (const tool of allTools) {
		if (!activeToolNames.has(tool.name)) continue;
		if (isExcludedFromCursorBridgeExposure(tool.name)) continue;
		if (!exposeOverlappingBuiltins && isOverlappingCursorNativePiToolName(tool.name)) continue;

		const mcpToolName = createMcpToolName(tool.name, usedMcpToolNames);
		const description = tool.description || `Run pi tool ${tool.name}`;
		mcpToolNameToPiToolName.set(mcpToolName, tool.name);
		piToolNameToMcpToolName.set(tool.name, mcpToolName);
		tools.push({
			piToolName: tool.name,
			mcpToolName,
			description,
			inputSchema: normalizeMcpInputSchema(tool.parameters),
			sourceInfo: tool.sourceInfo,
		});
	}

	return { tools, mcpToolNameToPiToolName, piToolNameToMcpToolName };
}

function snapshotToolToMcpTool(tool: CursorPiBridgeToolDefinition): Tool {
	return {
		name: tool.mcpToolName,
		description: tool.description,
		inputSchema: tool.inputSchema,
		_meta: { piToolName: tool.piToolName },
	};
}

function convertPiContentToMcpContent(content: unknown): CallToolResult["content"] {
	if (!Array.isArray(content)) {
		return [{ type: "text", text: typeof content === "string" ? content : JSON.stringify(content) }];
	}

	const mcpContent: CallToolResult["content"] = [];
	for (const block of content) {
		if (!isRecord(block)) continue;
		if (block.type === "text" && typeof block.text === "string") {
			mcpContent.push({ type: "text", text: block.text });
			continue;
		}
		if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
			mcpContent.push({ type: "image", data: block.data, mimeType: block.mimeType });
			continue;
		}
		mcpContent.push({ type: "text", text: JSON.stringify(block) });
	}

	return mcpContent.length > 0 ? mcpContent : [{ type: "text", text: "" }];
}

function asToolResultMessage(value: Context["messages"][number]): Extract<Context["messages"][number], { role: "toolResult" }> | undefined {
	return value.role === "toolResult" ? value : undefined;
}

function getStringField(record: Record<string, unknown>, fields: string[]): string | undefined {
	for (const field of fields) {
		const value = record[field];
		if (typeof value === "string" && value) return value;
	}
	return undefined;
}

function containsKnownMcpToolName(value: unknown, knownMcpToolNames: ReadonlySet<string>, depth = 0): boolean {
	if (depth > 4) return false;
	if (Array.isArray(value)) return value.some((entry) => containsKnownMcpToolName(entry, knownMcpToolNames, depth + 1));
	if (!isRecord(value)) return false;

	for (const field of ["tool", "toolName", "name", "mcpToolName", "serverToolName"]) {
		const fieldValue = value[field];
		if (typeof fieldValue === "string" && knownMcpToolNames.has(fieldValue)) return true;
	}

	for (const nestedField of ["args", "arguments", "input"]) {
		if (containsKnownMcpToolName(value[nestedField], knownMcpToolNames, depth + 1)) return true;
	}

	return false;
}

class CursorPiToolBridgeRunImpl implements CursorPiToolBridgeRun {
	readonly id: string;
	readonly enabled: boolean;
	readonly snapshot: CursorPiToolBridgeSnapshot;
	mcpServers?: Record<string, McpServerConfig>;

	private readonly registry: CursorPiToolBridgeRegistry;
	private readonly endpointPath: string;
	private readonly knownMcpToolNames: ReadonlySet<string>;
	private readonly knownCursorMcpCallIds = new Set<string>();
	private readonly queuedRequests: CursorPiBridgeToolRequest[] = [];
	private readonly pendingByPiToolCallId = new Map<string, PendingBridgeCall>();
	private readonly pendingByBridgeCallId = new Map<string, PendingBridgeCall>();
	private readonly pendingByCursorMcpCallId = new Map<string, PendingBridgeCall>();
	private readonly onToolRequest?: (request: CursorPiBridgeToolRequest) => void;
	private mcpServer?: McpProtocolServer;
	private mcpTransport?: StreamableHTTPServerTransport;
	private toolCallCounter = 0;
	private disposed = false;

	constructor(
		registry: CursorPiToolBridgeRegistry,
		snapshot: CursorPiToolBridgeSnapshot,
		enabled: boolean,
		options: CursorPiToolBridgeRunOptions = {},
	) {
		this.registry = registry;
		this.snapshot = snapshot;
		this.enabled = enabled;
		this.onToolRequest = options.onToolRequest;
		this.id = `cursor-pi-bridge-${randomUUID()}`;
		this.endpointPath = `${MCP_ENDPOINT_ROOT}/${this.id}/${randomUUID()}/mcp`;
		this.knownMcpToolNames = new Set(snapshot.tools.map((tool) => tool.mcpToolName));
	}

	async start(): Promise<void> {
		if (!this.enabled) return;
		await this.createMcpServer();
		const endpointUrl = await this.registry.registerRun(this.endpointPath, this);
		this.mcpServers = { [MCP_SERVER_NAME]: { type: "http", url: endpointUrl } };
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

	resolveToolResultsFromContext(context: Context): void {
		for (const message of context.messages) {
			const toolResult = asToolResultMessage(message);
			if (!toolResult) continue;
			const pending = this.pendingByPiToolCallId.get(toolResult.toolCallId);
			if (!pending || pending.settled) continue;
			this.resolvePending(pending, {
				content: convertPiContentToMcpContent(toolResult.content),
				isError: toolResult.isError || undefined,
			});
		}
	}

	hasPendingPiToolCallId(piToolCallId: string): boolean {
		return this.pendingByPiToolCallId.has(piToolCallId);
	}

	isBridgeMcpToolCall(toolCall: unknown): boolean {
		if (!isRecord(toolCall)) return false;
		const toolName = getStringField(toolCall, ["name", "toolName", "mcpToolName"]);
		if (toolName && this.knownMcpToolNames.has(toolName)) return true;

		const cursorMcpCallId = getStringField(toolCall, ["call_id", "callId", "id", "toolCallId", "requestId"]);
		if (cursorMcpCallId && this.knownCursorMcpCallIds.has(cursorMcpCallId)) return true;

		if (containsKnownMcpToolName(toolCall, this.knownMcpToolNames)) return true;

		return false;
	}

	cancel(reason: string): void {
		const error = new Error(reason);
		this.queuedRequests.splice(0);
		for (const pending of [...this.pendingByBridgeCallId.values()]) {
			this.rejectPending(pending, error);
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
				this.rejectPending(pending, new Error("Cursor MCP bridge tool request was aborted"));
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
			this.queuedRequests.push(request);
			this.onToolRequest?.(request);
		});
	}

	private resolvePending(pending: PendingBridgeCall, result: CallToolResult): void {
		if (pending.settled) return;
		pending.settled = true;
		this.removePending(pending);
		pending.resolve(result);
	}

	private rejectPending(pending: PendingBridgeCall, error: Error): void {
		if (pending.settled) return;
		pending.settled = true;
		this.removePending(pending);
		pending.reject(error);
	}

	private removePending(pending: PendingBridgeCall): void {
		pending.signal?.removeEventListener("abort", pending.onAbort ?? (() => undefined));
		this.pendingByPiToolCallId.delete(pending.request.piToolCallId);
		this.pendingByBridgeCallId.delete(pending.request.bridgeCallId);
		if (pending.request.cursorMcpCallId) this.pendingByCursorMcpCallId.delete(pending.request.cursorMcpCallId);
	}
}

class CursorPiToolBridgeRegistry implements CursorPiToolBridge {
	private readonly pi: Pick<ExtensionAPI, "getActiveTools" | "getAllTools">;
	private readonly env: Record<string, string | undefined>;
	private readonly runs = new Set<CursorPiToolBridgeRunImpl>();
	private readonly routes = new Map<string, CursorPiToolBridgeRunImpl>();
	private httpServer?: HttpServer;
	private listenPromise?: Promise<void>;

	constructor(
		pi: Pick<ExtensionAPI, "getActiveTools" | "getAllTools">,
		env: Record<string, string | undefined> = process.env,
	) {
		this.pi = pi;
		this.env = env;
	}

	isEnabled(): boolean {
		return resolveCursorPiToolBridgeEnabled(this.env);
	}

	async createRun(options: CursorPiToolBridgeRunOptions = {}): Promise<CursorPiToolBridgeRun> {
		const bridgeEnabled = this.isEnabled();
		const snapshot = bridgeEnabled
			? buildCursorPiToolBridgeSnapshot(this.pi, {
				exposeOverlappingBuiltins: resolveCursorPiToolBridgeBuiltinsEnabled(this.env),
			})
			: createEmptySnapshot();
		const run = new CursorPiToolBridgeRunImpl(this, snapshot, bridgeEnabled && snapshot.tools.length > 0, options);
		this.runs.add(run);
		await run.start();
		return run;
	}

	async disposeAll(reason = "Cursor pi tool bridge disposed"): Promise<void> {
		await Promise.all([...this.runs].map(async (run) => {
			run.cancel(reason);
			await run.dispose();
		}));
	}

	async registerRun(pathname: string, run: CursorPiToolBridgeRunImpl): Promise<string> {
		await this.ensureHttpServer();
		this.routes.set(pathname, run);
		const address = this.getHttpServerAddress();
		if (!address) throw new Error("Cursor pi tool bridge HTTP server is not listening");
		return `http://${LOOPBACK_HOST}:${address.port}${pathname}`;
	}

	async unregisterRun(pathname: string, run: CursorPiToolBridgeRunImpl): Promise<void> {
		if (this.routes.get(pathname) === run) this.routes.delete(pathname);
		this.runs.delete(run);
		if (this.routes.size === 0) await this.closeHttpServer();
	}

	getHttpServerAddress(): AddressInfo | undefined {
		const address = this.httpServer?.address();
		return isRecord(address) && typeof address.port === "number" ? address as AddressInfo : undefined;
	}

	getEndpointCount(): number {
		return this.routes.size;
	}

	private async ensureHttpServer(): Promise<void> {
		if (this.httpServer) {
			await this.listenPromise;
			return;
		}

		const server = createServer((req, res) => {
			void this.handleHttpRequest(req, res);
		});
		this.httpServer = server;
		this.listenPromise = new Promise<void>((resolve, reject) => {
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
		await this.listenPromise;
	}

	private async closeHttpServer(): Promise<void> {
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

	private async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (req.socket.localAddress !== LOOPBACK_HOST) {
			res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: "Cursor pi tool bridge only accepts loopback requests" }));
			return;
		}

		const url = new URL(req.url ?? "/", `http://${LOOPBACK_HOST}`);
		const run = this.routes.get(url.pathname);
		if (!run) {
			res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "Cursor pi tool bridge endpoint not found" }));
			return;
		}

		try {
			await run.handleHttpRequest(req, res);
		} catch (error) {
			if (!res.headersSent) {
				res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
			}
		}
	}
}

let registeredCursorPiToolBridge: CursorPiToolBridgeRegistry | undefined;

export function registerCursorPiToolBridge(pi: ExtensionAPI): CursorPiToolBridge {
	void registeredCursorPiToolBridge?.disposeAll("Cursor pi tool bridge extension reloaded");
	const bridge = new CursorPiToolBridgeRegistry(pi);
	registeredCursorPiToolBridge = bridge;
	pi.on("session_shutdown", async (event) => {
		await bridge.disposeAll(`Cursor pi tool bridge session shutdown: ${event.reason}`);
	});
	return bridge;
}

export function getRegisteredCursorPiToolBridge(): CursorPiToolBridge | undefined {
	return registeredCursorPiToolBridge;
}

export const __testUtils = {
	CURSOR_PI_TOOL_BRIDGE_ENV,
	CURSOR_PI_TOOL_BRIDGE_BUILTINS_ENV,
	LOOPBACK_HOST,
	MCP_SERVER_NAME,
	createRegistry(
		pi: Pick<ExtensionAPI, "getActiveTools" | "getAllTools">,
		env: Record<string, string | undefined> = process.env,
	) {
		return new CursorPiToolBridgeRegistry(pi, env);
	},
	getRegisteredBridgeForTests() {
		return registeredCursorPiToolBridge;
	},
	resetRegisteredBridgeForTests() {
		const bridge = registeredCursorPiToolBridge;
		registeredCursorPiToolBridge = undefined;
		return bridge?.disposeAll("Cursor pi tool bridge test reset") ?? Promise.resolve();
	},
};
