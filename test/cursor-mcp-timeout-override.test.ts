import { captureProviderTestOwnership } from "./helpers/cursor-provider-ownership.js";
import { makeModel, makeContext } from "./helpers/pi-harness.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installedCursorModules } from "./helpers/cursor-sdk-installed-modules.js";
import {
	installCursorMcpToolTimeoutOverride,
	restoreCursorMcpToolTimeoutOverride,
} from "../src/cursor-mcp-timeout-override.js";

afterEach(() => {
	restoreCursorMcpToolTimeoutOverride();
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

describe("Cursor MCP timeout override", () => {
	it("applies scoped defaults to actual installed SDK MCP requests without minifier coupling", async () => {
		const modules = await installedCursorModules();
		const exports = modules("/@modelcontextprotocol/sdk/dist/esm/client/index.js");
		const Client = Object.values(exports).find((value: any) => typeof value === "function" && typeof value.prototype?.callTool === "function") as any;
		expect(Client).toBeTypeOf("function");
		const client = new Client({ name: "offline-contract", version: "1" });
		const pending: Promise<unknown>[] = [];
		const timers: number[] = [];
		const original = globalThis.setTimeout;
		vi.stubGlobal("setTimeout", ((callback: any, delay: number, ...args: any[]) => {
			timers.push(delay);
			return original(callback, delay, ...args);
		}) as typeof setTimeout);
		installCursorMcpToolTimeoutOverride();
		const transport = {
			start: async () => {}, close: async () => { transport.onclose?.(); },
			send: async (message: any) => {
				if (message.method === "initialize") {
					transport.onmessage?.({ jsonrpc: "2.0", id: message.id, result: {
						protocolVersion: "2025-11-25", capabilities: { tools: {}, prompts: {} },
						serverInfo: { name: "offline", version: "1" },
					} });
				}
			},
			onmessage: undefined as ((message: any) => void) | undefined,
			onclose: undefined as (() => void) | undefined,
		};
		try {
			await client.connect(transport);
			expect(timers).toContain(10_000);
			timers.length = 0;
			pending.push(client.listTools().catch(() => {}));
			expect(timers).toContain(10_000);
			timers.length = 0;
			pending.push(client.callTool({ name: "offline", arguments: {} }).catch(() => {}));
			expect(timers).toContain(3_600_000);
			timers.length = 0;
			pending.push(client.listPrompts().catch(() => {}));
			expect(timers).toContain(60_000);
			timers.length = 0;
			pending.push(client.callTool({ name: "offline" }, undefined, { timeout: 1234 }).catch(() => {}));
			expect(timers).toContain(1234);
			timers.length = 0;
			vi.stubEnv("PI_CURSOR_MCP_TOOL_TIMEOUT_SECONDS", "120");
			installCursorMcpToolTimeoutOverride();
			pending.push(client.callTool({ name: "offline", arguments: {} }).catch(() => {}));
			expect(timers).toContain(120_000);
		} finally {
			await client.close();
			await Promise.all(pending);
			restoreCursorMcpToolTimeoutOverride();
			vi.unstubAllGlobals();
		}
	});

	it("installs the override before Cursor session agent acquisition", async () => {
		vi.resetModules();
		const calls: string[] = [];
		vi.doMock("../src/cursor-mcp-timeout-override.js", () => ({
			installCursorMcpToolTimeoutOverride: () => calls.push("install"),
		}));
		vi.doMock("../src/cursor-session-agent.js", () => ({
			acquireSessionCursorAgent: async () => {
				calls.push("acquire");
				throw new Error("stop before Cursor agent creation");
			},
			buildCursorSessionSendPrompt: vi.fn(),
			planCursorSessionSend: vi.fn(),
			resetSessionCursorAgent: vi.fn(),
		}));
		const { prepareCursorProviderTurn, resolveCursorProviderTurnConfig } = await import("../src/cursor-provider-turn-prepare.js");

		await expect(
			prepareCursorProviderTurn({
				params: {
					...captureProviderTestOwnership(makeModel(), makeContext()),
					model: { id: "cursor/composer-2.5", provider: "cursor", api: "assistant" } as never,
					context: {} as never,
					stream: { push: vi.fn() } as never,
					partial: { content: [] } as never,
					sdkEventDebugRef: {},
				},
				cwd: process.cwd(),
				resolvedApiKey: "key",
				sdkEventDebug: undefined,
				throwIfAborted: vi.fn(),
				resolvedConfig: resolveCursorProviderTurnConfig(process.cwd()),
			}),
		).rejects.toThrow("stop before Cursor agent creation");

		expect(calls).toEqual(["install", "acquire"]);
		vi.doUnmock("../src/cursor-mcp-timeout-override.js");
		vi.doUnmock("../src/cursor-session-agent.js");
		vi.resetModules();
	}, 15_000);

	it("uses a 10s connect default and supports explicit connect overrides", () => {
		for (const [ms, seconds, expected] of [
			[undefined, undefined, 10_000],
			[undefined, "5", 5_000],
			["500", undefined, 1_000],
			["120000", undefined, 60_000],
		] as const) {
			vi.stubEnv("PI_CURSOR_MCP_CONNECT_TIMEOUT_MS", ms);
			vi.stubEnv("PI_CURSOR_MCP_CONNECT_TIMEOUT_SECONDS", seconds);
			expect(installCursorMcpToolTimeoutOverride().connectTimeoutMs).toBe(expected);
		}
	});

	it("does not extend unrelated 60s timers", () => {
		vi.useFakeTimers();
		installCursorMcpToolTimeoutOverride();
		const callback = vi.fn();

		setTimeout(callback, 60_000);

		vi.advanceTimersByTime(60_000);
		expect(callback).toHaveBeenCalledTimes(1);
	});

	it("keeps non-default timer calls on the cheap no-stack fast path", () => {
		vi.useFakeTimers();
		installCursorMcpToolTimeoutOverride();
		const OriginalError = globalThis.Error;
		let stackCaptures = 0;
		const CountingError = class extends OriginalError {
			constructor(message?: string) {
				super(message);
				stackCaptures += 1;
			}
		} as ErrorConstructor;
		globalThis.Error = CountingError;
		try {
			setTimeout(vi.fn(), 1);
			expect(stackCaptures).toBe(0);

			setTimeout(vi.fn(), 60_000);
			expect(stackCaptures).toBe(1);
		} finally {
			globalThis.Error = OriginalError;
		}
	});

	it("uses a 3600s default and supports explicit second or millisecond overrides", () => {
		for (const [ms, seconds, expected] of [
			[undefined, undefined, 3_600_000],
			[undefined, "120", 120_000],
			["250000", "120", 250_000],
			["500", undefined, 60_000],
			["999999999999", undefined, 2_147_483_647],
		] as const) {
			vi.stubEnv("PI_CURSOR_MCP_TOOL_TIMEOUT_MS", ms);
			vi.stubEnv("PI_CURSOR_MCP_TOOL_TIMEOUT_SECONDS", seconds);
			expect(installCursorMcpToolTimeoutOverride().timeoutMs).toBe(expected);
		}
	});
});
