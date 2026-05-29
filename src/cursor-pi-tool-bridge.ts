import {
	CURSOR_PI_TOOL_BRIDGE_DEBUG_ENV,
	CURSOR_PI_TOOL_BRIDGE_DIAGNOSTIC_PREFIX,
	type CursorPiToolBridgeDiagnosticEvent,
	serializeCursorPiToolBridgeDiagnostic,
} from "./cursor-pi-tool-bridge-diagnostics.js";
import {
	CURSOR_PI_TOOL_BRIDGE_BUILTINS_ENV,
	CURSOR_PI_TOOL_BRIDGE_ENV,
	buildCursorPiToolBridgeSnapshot,
	buildCursorPiToolBridgeSurfaceSignature,
	resolveCursorPiToolBridgeBuiltinsEnabled,
	resolveCursorPiToolBridgeEnabled,
} from "./cursor-pi-tool-bridge-snapshot.js";
import { bridgeToolExecutionAbortTracker } from "./cursor-pi-tool-bridge-abort.js";
import { MCP_SERVER_NAME } from "./cursor-pi-tool-bridge-constants.js";
import { LOOPBACK_HOST, CursorPiToolBridgeRegistry } from "./cursor-pi-tool-bridge-server.js";
import type {
	CursorPiToolBridge,
	CursorPiToolBridgeExtensionApi,
	CursorPiToolBridgeSnapshotApi,
} from "./cursor-pi-tool-bridge-types.js";

export type {
	CursorPiBridgeToolDefinition,
	CursorPiBridgeToolRequest,
	CursorPiMcpInputSchema,
	CursorPiToolBridge,
	CursorPiToolBridgeExtensionApi,
	CursorPiToolBridgeRun,
	CursorPiToolBridgeRunOptions,
	CursorPiToolBridgeSnapshot,
	CursorPiToolBridgeSnapshotApi,
	CursorPiToolBridgeSnapshotOptions,
} from "./cursor-pi-tool-bridge-types.js";
export type { CursorPiToolBridgeDiagnosticEvent } from "./cursor-pi-tool-bridge-diagnostics.js";
export { resolveCursorPiToolBridgeDebugEnabled } from "./cursor-pi-tool-bridge-diagnostics.js";
export {
	buildCursorPiToolBridgeSnapshot,
	buildCursorPiToolBridgeSurfaceSignature,
	resolveCursorPiToolBridgeBuiltinsEnabled,
	resolveCursorPiToolBridgeEnabled,
} from "./cursor-pi-tool-bridge-snapshot.js";

let registeredCursorPiToolBridge: CursorPiToolBridgeRegistry | undefined;

export function registerCursorPiToolBridge(pi: CursorPiToolBridgeExtensionApi): CursorPiToolBridge {
	bridgeToolExecutionAbortTracker.abortAll("Cursor pi tool bridge extension reloaded");
	void registeredCursorPiToolBridge?.disposeAll("Cursor pi tool bridge extension reloaded");
	const bridge = new CursorPiToolBridgeRegistry(pi);
	registeredCursorPiToolBridge = bridge;
	pi.on("tool_call", (event, ctx) => {
		if (!bridge.hasPendingPiToolCallId(event.toolCallId)) return undefined;
		const trackingStarted = bridgeToolExecutionAbortTracker.track(event.toolCallId, {
			signal: ctx.signal,
			abort: () => {
				void ctx.abort();
			},
			cancelPending: (reason) => {
				bridge.cancelPendingPiToolCallId(event.toolCallId, reason);
			},
		});
		if (trackingStarted) return undefined;
		return { block: true, reason: "Cursor pi bridge tool execution was aborted before it started" };
	});
	pi.on("tool_result", (event) => {
		bridgeToolExecutionAbortTracker.finish(event.toolCallId);
	});
	pi.on("session_shutdown", async (event) => {
		const reason = `Cursor pi tool bridge session shutdown: ${event.reason}`;
		bridgeToolExecutionAbortTracker.abortAll(reason);
		await bridge.disposeAll(reason);
	});
	return bridge;
}

export function getRegisteredCursorPiToolBridge(): CursorPiToolBridge | undefined {
	return registeredCursorPiToolBridge;
}

export const __testUtils = {
	CURSOR_PI_TOOL_BRIDGE_ENV,
	CURSOR_PI_TOOL_BRIDGE_BUILTINS_ENV,
	CURSOR_PI_TOOL_BRIDGE_DEBUG_ENV,
	CURSOR_PI_TOOL_BRIDGE_DIAGNOSTIC_PREFIX,
	LOOPBACK_HOST,
	MCP_SERVER_NAME,
	createRegistry(
		pi: CursorPiToolBridgeSnapshotApi,
		env: Record<string, string | undefined> = process.env,
	) {
		return new CursorPiToolBridgeRegistry(pi, env);
	},
	getRegisteredBridgeForTests() {
		return registeredCursorPiToolBridge;
	},
	serializeDiagnosticForTests(event: CursorPiToolBridgeDiagnosticEvent) {
		return serializeCursorPiToolBridgeDiagnostic(event);
	},
	getActiveBridgeToolExecutionAbortCount() {
		return bridgeToolExecutionAbortTracker.getActiveCount();
	},
	emitBridgeToolExecutionProcessAbortSignalForTests(signal: NodeJS.Signals) {
		bridgeToolExecutionAbortTracker.emitProcessAbortSignalForTests(signal);
	},
	resetRegisteredBridgeForTests() {
		bridgeToolExecutionAbortTracker.abortAll("Cursor pi tool bridge test reset");
		const bridge = registeredCursorPiToolBridge;
		registeredCursorPiToolBridge = undefined;
		return bridge?.disposeAll("Cursor pi tool bridge test reset") ?? Promise.resolve();
	},
};
