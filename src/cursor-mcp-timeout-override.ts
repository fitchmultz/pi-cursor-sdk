const CURSOR_SDK_MCP_DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_CURSOR_MCP_TOOL_TIMEOUT_MS = 3_600_000;
const DEFAULT_CURSOR_MCP_CONNECT_TIMEOUT_MS = 10_000;
const MIN_CURSOR_MCP_CONNECT_TIMEOUT_MS = 1_000;
const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647;
const CURSOR_MCP_TOOL_TIMEOUT_MS_ENV = "PI_CURSOR_MCP_TOOL_TIMEOUT_MS";
const CURSOR_MCP_TOOL_TIMEOUT_SECONDS_ENV = "PI_CURSOR_MCP_TOOL_TIMEOUT_SECONDS";
const CURSOR_MCP_CONNECT_TIMEOUT_MS_ENV = "PI_CURSOR_MCP_CONNECT_TIMEOUT_MS";
const CURSOR_MCP_CONNECT_TIMEOUT_SECONDS_ENV = "PI_CURSOR_MCP_CONNECT_TIMEOUT_SECONDS";

interface CursorMcpToolTimeoutOverrideState {
	installed: boolean;
	timeoutMs: number;
	connectTimeoutMs: number;
	sdkDefaultTimeoutMs: number;
}

type GlobalSetTimeout = typeof globalThis.setTimeout;
type SetTimeoutHandler = Parameters<GlobalSetTimeout>[0];
type SetTimeoutDelay = Parameters<GlobalSetTimeout>[1];

type CursorMcpTimeoutDelays = Pick<CursorMcpToolTimeoutOverrideState, "timeoutMs" | "connectTimeoutMs">;

interface InstalledCursorMcpTimeoutOverride {
	readonly delegate: GlobalSetTimeout;
	readonly setTimeout: GlobalSetTimeout;
	delays: CursorMcpTimeoutDelays;
}

let installedOverride: InstalledCursorMcpTimeoutOverride | undefined;

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

function normalizeConnectTimeoutMs(timeoutMs: number): number {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return DEFAULT_CURSOR_MCP_CONNECT_TIMEOUT_MS;
	return Math.min(
		Math.max(Math.trunc(timeoutMs), MIN_CURSOR_MCP_CONNECT_TIMEOUT_MS),
		CURSOR_SDK_MCP_DEFAULT_TIMEOUT_MS,
	);
}

function resolveCursorMcpConnectTimeoutMs(
	env: Record<string, string | undefined> = process.env,
): number {
	const explicitMs = parsePositiveNumber(env[CURSOR_MCP_CONNECT_TIMEOUT_MS_ENV]);
	if (explicitMs !== undefined) return normalizeConnectTimeoutMs(explicitMs);

	const explicitSeconds = parsePositiveNumber(env[CURSOR_MCP_CONNECT_TIMEOUT_SECONDS_ENV]);
	if (explicitSeconds !== undefined) return normalizeConnectTimeoutMs(explicitSeconds * 1000);

	return DEFAULT_CURSOR_MCP_CONNECT_TIMEOUT_MS;
}

function isCursorSdkMcpProtocolTimeoutStack(stack: string | undefined): boolean {
	if (!stack) return false;
	return (
		/(?:node_modules[/\\]@cursor[/\\]sdk|node_modules\/\@cursor\/sdk|@cursor\/sdk\/dist)/.test(stack) &&
		/\b_setupTimeout\b|\bProtocol\._setupTimeout\b/.test(stack)
	);
}

function isCursorSdkMcpToolTimeoutStack(stack: string | undefined): boolean {
	if (!stack) return false;
	return (
		isCursorSdkMcpProtocolTimeoutStack(stack) &&
		/\bcallTool\b|\bClient\.callTool\b|\bMcpSdkClient\.callTool\b/.test(stack)
	);
}

function isCursorSdkMcpConnectTimeoutStack(stack: string | undefined): boolean {
	if (!stack || !isCursorSdkMcpProtocolTimeoutStack(stack)) return false;
	// The SDK minifies the Client class name; the protocol method and SDK
	// frame, not that constructor's spelling, establish this timeout purpose.
	return /^\s*at (?:[\w$]+\.)?(?:connect|listTools|getTools)\s*\(.*(?:node_modules[/\\]@cursor[/\\]sdk|@cursor\/sdk\/dist)/m.test(stack);
}

function isCursorSdkDefaultMcpTimeout(delay: SetTimeoutDelay): boolean {
	return typeof delay === "number" && delay === CURSOR_SDK_MCP_DEFAULT_TIMEOUT_MS;
}

function createCursorMcpTimeoutOverride(
	delegate: GlobalSetTimeout,
	delays: CursorMcpTimeoutDelays,
): InstalledCursorMcpTimeoutOverride {
	const installation: InstalledCursorMcpTimeoutOverride = {
		delegate,
		delays,
		setTimeout: function patchedSetTimeout(
			handler: SetTimeoutHandler,
			delay?: SetTimeoutDelay,
			...args: unknown[]
		): ReturnType<GlobalSetTimeout> {
			let nextDelay = delay;
			// Once restored, a wrapper that another owner still calls forwards unchanged.
			if (installedOverride === installation && isCursorSdkDefaultMcpTimeout(delay)) {
				const stack = new Error().stack;
				if (isCursorSdkMcpToolTimeoutStack(stack)) {
					nextDelay = installation.delays.timeoutMs;
				} else if (isCursorSdkMcpConnectTimeoutStack(stack)) {
					nextDelay = installation.delays.connectTimeoutMs;
				}
			}

			return Reflect.apply(delegate, globalThis, [handler, nextDelay, ...args]) as ReturnType<GlobalSetTimeout>;
		} as GlobalSetTimeout,
	};
	return installation;
}

export function installCursorMcpToolTimeoutOverride(): CursorMcpToolTimeoutOverrideState {
	const delays: CursorMcpTimeoutDelays = {
		timeoutMs: resolveCursorMcpToolTimeoutMs(),
		connectTimeoutMs: resolveCursorMcpConnectTimeoutMs(),
	};

	if (installedOverride) {
		installedOverride.delays = delays;
	} else {
		installedOverride = createCursorMcpTimeoutOverride(globalThis.setTimeout, delays);
		globalThis.setTimeout = installedOverride.setTimeout;
	}

	return { installed: true, ...delays, sdkDefaultTimeoutMs: CURSOR_SDK_MCP_DEFAULT_TIMEOUT_MS };
}

export function restoreCursorMcpToolTimeoutOverride(): void {
	const installation = installedOverride;
	if (!installation) return;
	installedOverride = undefined;
	// A later owner may wrap this override. Keep its wrapper installed.
	if (globalThis.setTimeout === installation.setTimeout) globalThis.setTimeout = installation.delegate;
}
