import { parseEnvBoolean } from "./cursor-env-boolean.js";
import { resolveCursorMcpToolTimeoutMs } from "./cursor-mcp-timeout-override.js";

export const CURSOR_PI_TOOL_BRIDGE_ENV = "PI_CURSOR_PI_TOOL_BRIDGE";
export const CURSOR_PI_TOOL_BRIDGE_BUILTINS_ENV = "PI_CURSOR_EXPOSE_BUILTIN_TOOLS";
export const CURSOR_PI_TOOL_BRIDGE_CALL_TIMEOUT_MS_ENV = "PI_CURSOR_PI_BRIDGE_CALL_TIMEOUT_MS";

export function resolveCursorPiToolBridgeEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return parseEnvBoolean(env[CURSOR_PI_TOOL_BRIDGE_ENV], true);
}

export function resolveCursorPiToolBridgeBuiltinsEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return parseEnvBoolean(env[CURSOR_PI_TOOL_BRIDGE_BUILTINS_ENV], false);
}

export function resolveCursorPiToolBridgeCallTimeoutMs(env: Record<string, string | undefined> = process.env): number {
	const mcpToolTimeoutMs = resolveCursorMcpToolTimeoutMs(env);
	const parsed = Number(env[CURSOR_PI_TOOL_BRIDGE_CALL_TIMEOUT_MS_ENV]?.trim());
	if (!Number.isFinite(parsed) || parsed <= 0) return mcpToolTimeoutMs;
	return Math.min(Math.max(Math.trunc(parsed), 1), mcpToolTimeoutMs);
}
