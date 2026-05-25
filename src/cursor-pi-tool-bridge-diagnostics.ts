import { stableNameHash } from "./cursor-pi-tool-bridge-mcp.js";
import { parseEnvBoolean } from "./cursor-env-boolean.js";
import type { CursorSdkEventDebugRecorder } from "./cursor-sdk-event-debug.js";

export const CURSOR_PI_TOOL_BRIDGE_DEBUG_ENV = "PI_CURSOR_PI_TOOL_BRIDGE_DEBUG";
export const CURSOR_PI_TOOL_BRIDGE_DIAGNOSTIC_PREFIX = "[pi-cursor-sdk:bridge]";

export function resolveCursorPiToolBridgeDebugEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return parseEnvBoolean(env[CURSOR_PI_TOOL_BRIDGE_DEBUG_ENV], false);
}

function createCursorMcpCallDiagnosticId(cursorMcpCallId: string | undefined): string | undefined {
	return cursorMcpCallId ? `cursor-mcp-call-${stableNameHash(cursorMcpCallId)}` : undefined;
}

type CursorPiToolBridgeSkippedReason = "disabled" | "no_exposed_tools";
export type CursorPiToolBridgeRejectionKind = "cancelled" | "error";

export interface CursorPiToolBridgeLifecycleDiagnosticFields {
	runId: string;
	enabled: boolean;
	exposedToolCount: number;
	pendingCount: number;
}

interface CursorPiToolBridgeRunCreatedDiagnostic extends CursorPiToolBridgeLifecycleDiagnosticFields {
	event: "run_created";
}

interface CursorPiToolBridgeRunSkippedDiagnostic extends CursorPiToolBridgeLifecycleDiagnosticFields {
	event: "run_skipped";
	reason: CursorPiToolBridgeSkippedReason;
}

interface CursorPiToolBridgeToolsExposedDiagnostic extends CursorPiToolBridgeLifecycleDiagnosticFields {
	event: "tools_exposed";
	pairs: Array<{ piToolName: string; mcpToolName: string }>;
}

interface CursorPiToolBridgeRunCancelledDiagnostic extends CursorPiToolBridgeLifecycleDiagnosticFields {
	event: "run_cancelled";
	queuedCount: number;
	cancelledRequestCount: number;
}

interface CursorPiToolBridgeRunDisposedDiagnostic extends CursorPiToolBridgeLifecycleDiagnosticFields {
	event: "run_disposed";
}

export interface CursorPiToolBridgeRequestDiagnosticFields {
	runId: string;
	bridgeCallId: string;
	cursorMcpCallId?: string;
	piToolCallId: string;
	mcpToolName: string;
	piToolName: string;
	pendingCount: number;
}

interface CursorPiToolBridgeRequestQueuedDiagnostic extends CursorPiToolBridgeRequestDiagnosticFields {
	event: "request_queued";
}

interface CursorPiToolBridgeRequestResolvedDiagnostic extends CursorPiToolBridgeRequestDiagnosticFields {
	event: "request_resolved";
	isError: boolean;
}

interface CursorPiToolBridgeRequestRejectedDiagnostic extends CursorPiToolBridgeRequestDiagnosticFields {
	event: "request_rejected";
	rejectionKind: CursorPiToolBridgeRejectionKind;
}

export type CursorPiToolBridgeDiagnosticEvent =
	| CursorPiToolBridgeRunCreatedDiagnostic
	| CursorPiToolBridgeRunSkippedDiagnostic
	| CursorPiToolBridgeToolsExposedDiagnostic
	| CursorPiToolBridgeRunCancelledDiagnostic
	| CursorPiToolBridgeRunDisposedDiagnostic
	| CursorPiToolBridgeRequestQueuedDiagnostic
	| CursorPiToolBridgeRequestResolvedDiagnostic
	| CursorPiToolBridgeRequestRejectedDiagnostic;

function assertNeverDiagnosticEvent(_event: never): never {
	throw new Error("Unhandled Cursor pi tool bridge diagnostic event");
}

export function serializeCursorPiToolBridgeDiagnostic(event: CursorPiToolBridgeDiagnosticEvent): Record<string, unknown> {
	switch (event.event) {
		case "run_created":
			return {
				event: event.event,
				runId: event.runId,
				enabled: event.enabled,
				exposedToolCount: event.exposedToolCount,
				pendingCount: event.pendingCount,
			};
		case "run_skipped":
			return {
				event: event.event,
				runId: event.runId,
				enabled: event.enabled,
				exposedToolCount: event.exposedToolCount,
				pendingCount: event.pendingCount,
				reason: event.reason,
			};
		case "tools_exposed":
			return {
				event: event.event,
				runId: event.runId,
				enabled: event.enabled,
				exposedToolCount: event.exposedToolCount,
				pendingCount: event.pendingCount,
				pairs: event.pairs.map((pair) => ({ piToolName: pair.piToolName, mcpToolName: pair.mcpToolName })),
			};
		case "run_cancelled":
			return {
				event: event.event,
				runId: event.runId,
				enabled: event.enabled,
				exposedToolCount: event.exposedToolCount,
				pendingCount: event.pendingCount,
				queuedCount: event.queuedCount,
				cancelledRequestCount: event.cancelledRequestCount,
			};
		case "run_disposed":
			return {
				event: event.event,
				runId: event.runId,
				enabled: event.enabled,
				exposedToolCount: event.exposedToolCount,
				pendingCount: event.pendingCount,
			};
		case "request_queued":
			return {
				event: event.event,
				runId: event.runId,
				bridgeCallId: event.bridgeCallId,
				cursorMcpCallId: createCursorMcpCallDiagnosticId(event.cursorMcpCallId),
				piToolCallId: event.piToolCallId,
				mcpToolName: event.mcpToolName,
				piToolName: event.piToolName,
				pendingCount: event.pendingCount,
			};
		case "request_resolved":
			return {
				event: event.event,
				runId: event.runId,
				bridgeCallId: event.bridgeCallId,
				cursorMcpCallId: createCursorMcpCallDiagnosticId(event.cursorMcpCallId),
				piToolCallId: event.piToolCallId,
				mcpToolName: event.mcpToolName,
				piToolName: event.piToolName,
				pendingCount: event.pendingCount,
				isError: event.isError,
			};
		case "request_rejected":
			return {
				event: event.event,
				runId: event.runId,
				bridgeCallId: event.bridgeCallId,
				cursorMcpCallId: createCursorMcpCallDiagnosticId(event.cursorMcpCallId),
				piToolCallId: event.piToolCallId,
				mcpToolName: event.mcpToolName,
				piToolName: event.piToolName,
				pendingCount: event.pendingCount,
				rejectionKind: event.rejectionKind,
			};
	}
	return assertNeverDiagnosticEvent(event);
}

export function writeCursorPiToolBridgeDiagnostic(
	env: Record<string, string | undefined>,
	event: CursorPiToolBridgeDiagnosticEvent,
	debugRecorder?: CursorSdkEventDebugRecorder,
): void {
	try {
		debugRecorder?.recordBridgeDiagnostic(event);
	} catch {
		// Diagnostics must never affect bridge execution.
	}
	if (!resolveCursorPiToolBridgeDebugEnabled(env)) return;
	try {
		process.stderr.write(`${CURSOR_PI_TOOL_BRIDGE_DIAGNOSTIC_PREFIX} ${JSON.stringify(serializeCursorPiToolBridgeDiagnostic(event))}\n`);
	} catch {
		// Diagnostics must never affect bridge execution.
	}
}
