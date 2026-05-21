import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	cursorMcpToolTimeoutOverrideDefaults,
	installCursorMcpToolTimeoutOverride,
	isCursorSdkMcpToolTimeoutStack,
	resolveCursorMcpToolTimeoutMs,
	restoreCursorMcpToolTimeoutOverrideForTests,
} from "../src/cursor-mcp-timeout-override.js";

afterEach(() => {
	restoreCursorMcpToolTimeoutOverrideForTests();
	vi.useRealTimers();
});

function scheduleSyntheticCursorSdkMcpToolTimeout(callback: () => void): ReturnType<typeof setTimeout> {
	const sdkUrl = pathToFileURL(join(process.cwd(), "node_modules/@cursor/sdk/dist/esm/index.js")).href;
	const source = `
return (() => {
	class Protocol {
		_setupTimeout() {
			return setTimeout(callback, 60000);
		}

		request() {
			return this._setupTimeout();
		}
	}

	class Client extends Protocol {
		callTool() {
			return this.request();
		}
	}

	class McpSdkClient {
		constructor() {
			this.client = new Client();
		}

		callTool() {
			return this.client.callTool();
		}
	}

	return new McpSdkClient().callTool();
})();
//# sourceURL=${sdkUrl}
`;
	const run = new Function("callback", source) as (callback: () => void) => ReturnType<typeof setTimeout>;
	return run(callback);
}

describe("Cursor MCP timeout override", () => {
	it("tracks the installed Cursor SDK MCP callTool timeout seam", () => {
		const sdkBundle = readFileSync(
			join(process.cwd(), "node_modules/@cursor/sdk/dist/esm/index.js"),
			"utf8",
		);

		expect(sdkBundle).toContain("class McpSdkClient");
		expect(sdkBundle).toContain("this.client.callTool({name:t,arguments:r})");
		expect(sdkBundle).toContain(
			"const h=r?.timeout??DEFAULT_REQUEST_TIMEOUT_MSEC;this._setupTimeout",
		);
		expect(sdkBundle).toContain("timeoutId:setTimeout(n,t)");
	});

	it("recognizes the Cursor SDK MCP tool-call timeout stack shape", () => {
		const stack = `Error
    at Protocol._setupTimeout (${process.cwd()}/node_modules/@cursor/sdk/dist/esm/index.js:1:1)
    at Client.callTool (${process.cwd()}/node_modules/@cursor/sdk/dist/esm/index.js:1:1)
    at McpSdkClient.callTool (${process.cwd()}/node_modules/@cursor/sdk/dist/esm/index.js:1:1)`;

		expect(isCursorSdkMcpToolTimeoutStack(stack)).toBe(true);
		expect(isCursorSdkMcpToolTimeoutStack(stack.replace(/callTool/g, "listTools"))).toBe(false);
		expect(isCursorSdkMcpToolTimeoutStack(stack.replace(/node_modules\/\@cursor\/sdk/g, "src"))).toBe(false);
	});

	it("wires the override before Cursor provider Agent.create", () => {
		const providerSource = readFileSync(join(process.cwd(), "src/cursor-provider.ts"), "utf8");
		const installIndex = providerSource.indexOf("installCursorMcpToolTimeoutOverride();");
		const createIndex = providerSource.indexOf("Agent.create({");

		expect(providerSource).toContain(
			'import { installCursorMcpToolTimeoutOverride } from "./cursor-mcp-timeout-override.js";',
		);
		expect(installIndex).toBeGreaterThanOrEqual(0);
		expect(createIndex).toBeGreaterThanOrEqual(0);
		expect(installIndex).toBeLessThan(createIndex);
	});

	it("extends only the Cursor SDK MCP tool-call default timeout", () => {
		vi.useFakeTimers();
		installCursorMcpToolTimeoutOverride({ timeoutMs: 3_600_000 });
		const callback = vi.fn();

		scheduleSyntheticCursorSdkMcpToolTimeout(callback);

		vi.advanceTimersByTime(60_000);
		expect(callback).not.toHaveBeenCalled();

		vi.advanceTimersByTime(3_600_000 - 60_000);
		expect(callback).toHaveBeenCalledTimes(1);
	});

	it("does not extend unrelated 60s timers", () => {
		vi.useFakeTimers();
		installCursorMcpToolTimeoutOverride({ timeoutMs: 3_600_000 });
		const callback = vi.fn();

		setTimeout(callback, 60_000);

		vi.advanceTimersByTime(60_000);
		expect(callback).toHaveBeenCalledTimes(1);
	});

	it("uses a 3600s default and supports explicit second or millisecond overrides", () => {
		expect(resolveCursorMcpToolTimeoutMs({})).toBe(
			cursorMcpToolTimeoutOverrideDefaults.defaultOverrideTimeoutMs,
		);
		expect(
			resolveCursorMcpToolTimeoutMs({
				[cursorMcpToolTimeoutOverrideDefaults.timeoutSecondsEnv]: "120",
			}),
		).toBe(120_000);
		expect(
			resolveCursorMcpToolTimeoutMs({
				[cursorMcpToolTimeoutOverrideDefaults.timeoutMsEnv]: "250000",
				[cursorMcpToolTimeoutOverrideDefaults.timeoutSecondsEnv]: "120",
			}),
		).toBe(250_000);
		expect(
			resolveCursorMcpToolTimeoutMs({
				[cursorMcpToolTimeoutOverrideDefaults.timeoutMsEnv]: "999999999999",
			}),
		).toBe(cursorMcpToolTimeoutOverrideDefaults.maxNodeTimerDelayMs);
	});
});
