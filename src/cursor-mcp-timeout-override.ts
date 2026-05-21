const CURSOR_SDK_MCP_DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_CURSOR_MCP_TOOL_TIMEOUT_MS = 3_600_000;
const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647;
const CURSOR_MCP_TOOL_TIMEOUT_MS_ENV = "PI_CURSOR_MCP_TOOL_TIMEOUT_MS";
const CURSOR_MCP_TOOL_TIMEOUT_SECONDS_ENV = "PI_CURSOR_MCP_TOOL_TIMEOUT_SECONDS";

interface CursorMcpToolTimeoutOverrideOptions {
	timeoutMs?: number;
	env?: Record<string, string | undefined>;
}

interface CursorMcpToolTimeoutOverrideState {
	installed: boolean;
	timeoutMs: number;
	sdkDefaultTimeoutMs: number;
}

type GlobalSetTimeout = typeof globalThis.setTimeout;
type SetTimeoutHandler = Parameters<GlobalSetTimeout>[0];
type SetTimeoutDelay = Parameters<GlobalSetTimeout>[1];

let originalSetTimeout: GlobalSetTimeout | undefined;
let installedTimeoutMs = DEFAULT_CURSOR_MCP_TOOL_TIMEOUT_MS;

function parsePositiveNumber(value: string | undefined): number | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	const parsed = Number(trimmed);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizeOverrideTimeoutMs(timeoutMs: number): number {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return DEFAULT_CURSOR_MCP_TOOL_TIMEOUT_MS;
	return Math.min(Math.max(Math.trunc(timeoutMs), CURSOR_SDK_MCP_DEFAULT_TIMEOUT_MS), MAX_NODE_TIMER_DELAY_MS);
}

export function resolveCursorMcpToolTimeoutMs(
	env: Record<string, string | undefined> = process.env,
): number {
	const explicitMs = parsePositiveNumber(env[CURSOR_MCP_TOOL_TIMEOUT_MS_ENV]);
	if (explicitMs !== undefined) return normalizeOverrideTimeoutMs(explicitMs);

	const explicitSeconds = parsePositiveNumber(env[CURSOR_MCP_TOOL_TIMEOUT_SECONDS_ENV]);
	if (explicitSeconds !== undefined) return normalizeOverrideTimeoutMs(explicitSeconds * 1000);

	return DEFAULT_CURSOR_MCP_TOOL_TIMEOUT_MS;
}

export function isCursorSdkMcpToolTimeoutStack(stack: string | undefined): boolean {
	if (!stack) return false;
	return (
		/(?:node_modules[/\\]@cursor[/\\]sdk|node_modules\/\@cursor\/sdk|@cursor\/sdk\/dist)/.test(stack) &&
		/\b_setupTimeout\b|\bProtocol\._setupTimeout\b/.test(stack) &&
		/\bcallTool\b|\bClient\.callTool\b|\bMcpSdkClient\.callTool\b/.test(stack)
	);
}

function isCursorSdkDefaultMcpTimeout(delay: SetTimeoutDelay): boolean {
	return typeof delay === "number" && delay === CURSOR_SDK_MCP_DEFAULT_TIMEOUT_MS;
}

function patchedSetTimeout(
	handler: SetTimeoutHandler,
	delay?: SetTimeoutDelay,
	...args: unknown[]
): ReturnType<GlobalSetTimeout> {
	const delegate = originalSetTimeout;
	if (!delegate) throw new Error("Cursor MCP timeout override installed without original setTimeout");

	const nextDelay =
		isCursorSdkDefaultMcpTimeout(delay) && isCursorSdkMcpToolTimeoutStack(new Error().stack)
			? installedTimeoutMs
			: delay;

	return Reflect.apply(delegate, globalThis, [handler, nextDelay, ...args]) as ReturnType<GlobalSetTimeout>;
}

export function installCursorMcpToolTimeoutOverride(
	options: CursorMcpToolTimeoutOverrideOptions = {},
): CursorMcpToolTimeoutOverrideState {
	installedTimeoutMs = normalizeOverrideTimeoutMs(
		options.timeoutMs ?? resolveCursorMcpToolTimeoutMs(options.env),
	);

	if (!originalSetTimeout) {
		originalSetTimeout = globalThis.setTimeout;
		globalThis.setTimeout = patchedSetTimeout as GlobalSetTimeout;
	}

	return {
		installed: true,
		timeoutMs: installedTimeoutMs,
		sdkDefaultTimeoutMs: CURSOR_SDK_MCP_DEFAULT_TIMEOUT_MS,
	};
}

export function restoreCursorMcpToolTimeoutOverrideForTests(): void {
	if (originalSetTimeout) {
		globalThis.setTimeout = originalSetTimeout;
		originalSetTimeout = undefined;
	}
	installedTimeoutMs = DEFAULT_CURSOR_MCP_TOOL_TIMEOUT_MS;
}

export const cursorMcpToolTimeoutOverrideDefaults = {
	cursorSdkDefaultTimeoutMs: CURSOR_SDK_MCP_DEFAULT_TIMEOUT_MS,
	defaultOverrideTimeoutMs: DEFAULT_CURSOR_MCP_TOOL_TIMEOUT_MS,
	maxNodeTimerDelayMs: MAX_NODE_TIMER_DELAY_MS,
	timeoutMsEnv: CURSOR_MCP_TOOL_TIMEOUT_MS_ENV,
	timeoutSecondsEnv: CURSOR_MCP_TOOL_TIMEOUT_SECONDS_ENV,
} as const;
