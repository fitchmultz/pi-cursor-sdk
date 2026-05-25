import type { McpServerConfig } from "@cursor/sdk";
import type { Context, ToolResultMessage } from "@earendil-works/pi-ai";
import type { CursorSdkEventDebugRecorder } from "./cursor-sdk-event-debug.js";
import type {
	ExtensionAPI,
	ExtensionHandler,
	SessionShutdownEvent,
	ToolCallEvent,
	ToolCallEventResult,
	ToolInfo,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";

export type CursorPiToolBridgeSnapshotApi = Pick<ExtensionAPI, "getActiveTools" | "getAllTools">;

export type CursorPiToolBridgeExtensionApi = CursorPiToolBridgeSnapshotApi & {
	on(event: "tool_call", handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>): void;
	on(event: "tool_result", handler: ExtensionHandler<ToolResultEvent>): void;
	on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>): void;
};

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
	resolveToolResults(toolResults: readonly ToolResultMessage[]): void;
	resolveToolResultsFromContext(context: Context): void;
	hasPendingPiToolCallId(piToolCallId: string): boolean;
	isBridgeMcpToolCall(toolCall: unknown): boolean;
	setOnToolRequest(handler?: (request: CursorPiBridgeToolRequest) => void): void;
	setDebugRecorder(recorder?: CursorSdkEventDebugRecorder): void;
	cancel(reason: string): void;
	dispose(): Promise<void>;
}

export interface CursorPiToolBridge {
	isEnabled(): boolean;
	getToolSurfaceSignature(): string;
	createRun(options?: CursorPiToolBridgeRunOptions): Promise<CursorPiToolBridgeRun>;
	disposeAll(reason?: string): Promise<void>;
}

export interface CursorPiToolBridgeRunOptions {
	onToolRequest?: (request: CursorPiBridgeToolRequest) => void;
	debugRecorder?: CursorSdkEventDebugRecorder;
}
