import { parseEnvBoolean } from "./cursor-env-boolean.js";
import { resolveCursorMcpToolTimeoutMs } from "./cursor-mcp-timeout-override.js";

export const CURSOR_PI_TOOL_BRIDGE_ENV = "PI_CURSOR_PI_TOOL_BRIDGE";
const CURSOR_PI_TOOL_BRIDGE_BUILTINS_ENV = "PI_CURSOR_EXPOSE_BUILTIN_TOOLS";
const CURSOR_PI_TOOL_BRIDGE_CALL_TIMEOUT_MS_ENV = "PI_CURSOR_PI_BRIDGE_CALL_TIMEOUT_MS";

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

const CURSOR_PI_TOOL_BRIDGE_HOST_ENV = "PI_CURSOR_PI_TOOL_BRIDGE_HOST";
const CURSOR_PI_TOOL_BRIDGE_PORT_ENV = "PI_CURSOR_PI_TOOL_BRIDGE_PORT";
const DEFAULT_URL_HOST = "127.0.0.1";
const PORT_PATTERN = /^\d{1,5}$/;

export interface CursorPiToolBridgePortRange {
	readonly first: number;
	readonly last: number;
}

export function resolveCursorPiToolBridgeUrlHost(env: Record<string, string | undefined> = process.env): string {
	return env[CURSOR_PI_TOOL_BRIDGE_HOST_ENV]?.trim().toLowerCase() === "localhost" ? "localhost" : DEFAULT_URL_HOST;
}

function parsePort(text: string): number | undefined {
	if (!PORT_PATTERN.test(text)) return undefined;
	const port = Number(text);
	return port >= 1 && port <= 65535 ? port : undefined;
}

export function resolveCursorPiToolBridgePortRange(env: Record<string, string | undefined> = process.env): CursorPiToolBridgePortRange | undefined {
	const parts = env[CURSOR_PI_TOOL_BRIDGE_PORT_ENV]?.trim().split("-");
	if (!parts || parts.length > 2) return undefined;
	const first = parsePort(parts[0]!);
	const last = parts.length === 2 ? parsePort(parts[1]!) : first;
	if (first === undefined || last === undefined || first > last) return undefined;
	return { first, last };
}
