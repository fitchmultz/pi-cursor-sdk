import { spawnSync } from "node:child_process";
import {
	CURSOR_PI_TOOL_BRIDGE_DEBUG_ENV,
	CURSOR_PI_TOOL_BRIDGE_DIAGNOSTIC_PREFIX,
	type CursorPiToolBridgeDiagnosticEvent,
	serializeCursorPiToolBridgeDiagnostic,
} from "./cursor-pi-tool-bridge-diagnostics.js";
import {
	CURSOR_PI_TOOL_BRIDGE_BUILTINS_ENV,
	CURSOR_PI_TOOL_BRIDGE_CALL_TIMEOUT_MS_ENV,
	CURSOR_PI_TOOL_BRIDGE_ENV,
} from "./cursor-pi-tool-bridge-env.js";
import { bridgeToolExecutionAbortTracker } from "./cursor-pi-tool-bridge-abort.js";
import { isCursorPiBridgeToolCallId, MCP_SERVER_NAME } from "./cursor-pi-tool-bridge-constants.js";
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
	CURSOR_PI_TOOL_BRIDGE_BUILTINS_ENV,
	CURSOR_PI_TOOL_BRIDGE_CALL_TIMEOUT_MS_ENV,
	CURSOR_PI_TOOL_BRIDGE_ENV,
	resolveCursorPiToolBridgeBuiltinsEnabled,
	resolveCursorPiToolBridgeCallTimeoutMs,
	resolveCursorPiToolBridgeEnabled,
} from "./cursor-pi-tool-bridge-env.js";
export {
	buildCursorPiToolBridgeSnapshot,
	buildCursorPiToolBridgeSurfaceSignature,
} from "./cursor-pi-tool-bridge-snapshot.js";

let registeredCursorPiToolBridge: CursorPiToolBridgeRegistry | undefined;

const WINDOWS_BRIDGE_ABORT_ENV = "PI_CURSOR_BRIDGE_TOOL_CALL_ID";

function buildWindowsBridgeBashAbortCommand(command: string, marker: string): string {
	return `export ${WINDOWS_BRIDGE_ABORT_ENV}=${marker}; ${command}`;
}

function installWindowsBridgeBashAbortMarker(event: { toolCallId: string; toolName: string; input: unknown }): string | undefined {
	if (process.platform !== "win32" || event.toolName !== "bash") return undefined;
	if (typeof event.input !== "object" || event.input === null || !("command" in event.input)) return undefined;
	const input = event.input as { command?: unknown };
	if (typeof input.command !== "string" || input.command.length === 0) return undefined;
	const marker = event.toolCallId.replace(/[^A-Za-z0-9_.:-]/g, "_");
	input.command = buildWindowsBridgeBashAbortCommand(input.command, marker);
	return marker;
}

function killWindowsBridgeBashMarkerTree(marker: string | undefined): void {
	if (process.platform !== "win32" || !marker) return;
	const encodedMarker = Buffer.from(marker, "utf8").toString("base64");
	const script = `
$marker = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedMarker}'))
$needle = '${WINDOWS_BRIDGE_ABORT_ENV}=' + $marker
$seen = @{}
function Stop-Tree([int]$ProcessId) {
  if ($seen.ContainsKey($ProcessId)) { return }
  $seen[$ProcessId] = $true
  Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $ProcessId } | ForEach-Object { Stop-Tree $_.ProcessId }
  Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}
Get-CimInstance Win32_Process -Filter "Name = 'bash.exe' OR Name = 'sh.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($needle) } |
  ForEach-Object { Stop-Tree $_.ProcessId }
`;
	spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
		stdio: "ignore",
		timeout: 3_000,
		windowsHide: true,
	});
}

export function registerCursorPiToolBridge(pi: CursorPiToolBridgeExtensionApi): CursorPiToolBridge {
	bridgeToolExecutionAbortTracker.abortAll("Cursor pi tool bridge extension reloaded");
	void registeredCursorPiToolBridge?.disposeAll("Cursor pi tool bridge extension reloaded");
	const bridge = new CursorPiToolBridgeRegistry(pi);
	registeredCursorPiToolBridge = bridge;
	pi.on("tool_call", (event, ctx) => {
		if (registeredCursorPiToolBridge !== bridge) return undefined;
		if (!bridge.hasPendingPiToolCallId(event.toolCallId)) {
			return isCursorPiBridgeToolCallId(event.toolCallId)
				? { block: true, reason: "Cursor pi bridge tool call is no longer pending" }
				: undefined;
		}
		const windowsAbortMarker = installWindowsBridgeBashAbortMarker(event);
		const trackingStarted = bridgeToolExecutionAbortTracker.track(event.toolCallId, {
			signal: ctx.signal,
			abort: () => {
				ctx.abort();
				killWindowsBridgeBashMarkerTree(windowsAbortMarker);
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
	CURSOR_PI_TOOL_BRIDGE_CALL_TIMEOUT_MS_ENV,
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
	buildWindowsBridgeBashAbortCommandForTests: buildWindowsBridgeBashAbortCommand,
	installWindowsBridgeBashAbortMarkerForTests: installWindowsBridgeBashAbortMarker,
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
