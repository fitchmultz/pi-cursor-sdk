import { afterEach, describe, expect, it, vi } from "vitest";
import { createCursorLiveRunCoordinator } from "../src/cursor-live-run-coordinator.js";
import type { SDKAgent } from "@cursor/sdk";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Type } from "typebox";
import {
	__testUtils,
	registerCursorPiToolBridge,
	resolveCursorPiToolBridgeCallTimeoutMs,
	type CursorPiToolBridgeRun,
} from "../src/cursor-pi-tool-bridge.js";
import {
	createBridgePiHarness,
	createBuiltinToolInfo,
	getCursorPiBridgeMcpUrl,
} from "./helpers/pi-harness.js";

async function waitForQueuedRequest(run: CursorPiToolBridgeRun) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const [request] = run.takeQueuedToolRequests();
		if (request) return request;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Timed out waiting for queued bridge request");
}

describe("cursor pi tool bridge CallTool deadline", () => {
	afterEach(async () => {
		delete process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS;
		delete process.env.PI_CURSOR_PI_BRIDGE_CALL_TIMEOUT_MS;
		await __testUtils.resetRegisteredBridgeForTests();
	});

	it("defaults to the effective MCP tool timeout and allows only a lower bridge deadline", () => {
		expect(resolveCursorPiToolBridgeCallTimeoutMs({})).toBe(3_600_000);
		expect(resolveCursorPiToolBridgeCallTimeoutMs({ PI_CURSOR_PI_BRIDGE_CALL_TIMEOUT_MS: "120000" })).toBe(120_000);
		expect(resolveCursorPiToolBridgeCallTimeoutMs({ PI_CURSOR_PI_BRIDGE_CALL_TIMEOUT_MS: "7200000" })).toBe(3_600_000);
		expect(resolveCursorPiToolBridgeCallTimeoutMs({ PI_CURSOR_PI_BRIDGE_CALL_TIMEOUT_MS: "invalid" })).toBe(3_600_000);
		expect(resolveCursorPiToolBridgeCallTimeoutMs({
			PI_CURSOR_MCP_TOOL_TIMEOUT_MS: "60000",
			PI_CURSOR_PI_BRIDGE_CALL_TIMEOUT_MS: "120000",
		})).toBe(60_000);
	});

	it("protects a real pending MCP call from idle cleanup and re-arms cleanup after its result", async () => {
		process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS = "1";
		const pi = createBridgePiHarness({ active: ["bash"], tools: [createBuiltinToolInfo("bash", Type.Object({ command: Type.String() }))] });
		const bridge = await registerCursorPiToolBridge(pi).createRun();
		bridge.onPendingToolCallsChanged(() => { throw new Error("observer failed"); });
		const transitions: boolean[] = [];
		const unsubscribe = bridge.onPendingToolCallsChanged(() => transitions.push(bridge.hasPendingToolCalls()));
		const coordinator = createCursorLiveRunCoordinator({ getScopeKey: () => "owner", getIdleDisposeMs: () => 25,
			deleteNativeToolDisplay: () => {}, abandonSessionAgent: async () => {} });
		const run = coordinator.start({ id: "question-run", agent: { agentId: "agent" } as SDKAgent, sessionBridgeRun: bridge, promptInputTokens: 0 });
		const cancel = vi.fn().mockResolvedValue(undefined);
		coordinator.attachSdkRun(run, { cancel });
		const client = new Client({ name: "idle-contract", version: "1.0.0" });
		const transport = new StreamableHTTPClientTransport(new URL(getCursorPiBridgeMcpUrl(bridge)));
		await client.connect(transport);
		try {
			const call = client.callTool({ name: "pi__bash", arguments: { command: "held by human" } });
			const request = await waitForQueuedRequest(bridge);
			coordinator.requestIdleDispose(run);
			await new Promise((resolve) => setTimeout(resolve, 75));
			expect(run.disposed).toBe(false);
			expect(cancel).not.toHaveBeenCalled();
			await bridge.resolveToolResults([{ role: "toolResult", toolCallId: request.piToolCallId, toolName: "bash",
				content: [{ type: "text", text: "answer" }], isError: false, timestamp: Date.now() }]);
			expect(await call).toMatchObject({ content: [{ type: "text", text: "answer" }] });
			expect(transitions).toEqual([true, false]);
			await vi.waitFor(() => expect(run.disposed).toBe(true));
			expect(cancel).toHaveBeenCalledOnce();
		} finally {
			unsubscribe();
			await coordinator.release(run);
			await client.close().catch(() => undefined);
			await bridge.dispose();
		}
	});

	it("rejects a stranded call, clears pending state, and aborts active pi execution", async () => {
		process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS = "1";
		process.env.PI_CURSOR_PI_BRIDGE_CALL_TIMEOUT_MS = "500";
		const pi = createBridgePiHarness({
			active: ["bash"],
			tools: [createBuiltinToolInfo("bash", Type.Object({ command: Type.String() }), "Run shell commands")],
		});
		const run = await registerCursorPiToolBridge(pi).createRun();
		const oldOwner = vi.fn();
		const currentOwner = vi.fn();
		const detachOldOwner = run.onPendingToolCallsChanged(oldOwner);
		const detachCurrentOwner = run.onPendingToolCallsChanged(currentOwner);
		detachOldOwner();
		const client = new Client({ name: "pi-cursor-sdk-test", version: "1.0.0" });
		const transport = new StreamableHTTPClientTransport(new URL(getCursorPiBridgeMcpUrl(run)));
		await client.connect(transport);
		try {
			const callResult = client.callTool({ name: "pi__bash", arguments: { command: "sleep 30" } }).catch((error: unknown) => error);
			const request = await waitForQueuedRequest(run);
			const abort = vi.fn();
			await pi.runToolCall(
				{ type: "tool_call", toolCallId: request.piToolCallId, toolName: "bash", input: request.args },
				{ signal: new AbortController().signal, abort },
			);

			const result = await Promise.race([
				callResult,
				new Promise((resolve) => setTimeout(() => resolve("still pending"), 2_000)),
			]);
			expect(result).toBeInstanceOf(Error);
			expect((result as Error).message).toMatch(/timed out.*500 ?ms|MCP error/i);
			expect(abort).toHaveBeenCalledOnce();
			expect(__testUtils.getActiveBridgeToolExecutionAbortCount()).toBe(0);
			expect(run.hasPendingPiToolCallId(request.piToolCallId)).toBe(false);
			expect(run.hasPendingToolCalls()).toBe(false);
			expect(oldOwner).not.toHaveBeenCalled();
			expect(currentOwner).toHaveBeenCalledTimes(2);
			detachCurrentOwner();
		} finally {
			await client.close().catch(() => undefined);
			await transport.close().catch(() => undefined);
			await run.dispose();
		}
	});

	it("aborts active pi execution when the MCP client cancels CallTool", async () => {
		process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS = "1";
		const pi = createBridgePiHarness({
			active: ["bash"],
			tools: [createBuiltinToolInfo("bash", Type.Object({ command: Type.String() }), "Run shell commands")],
		});
		const run = await registerCursorPiToolBridge(pi).createRun();
		const client = new Client({ name: "pi-cursor-sdk-test", version: "1.0.0" });
		const transport = new StreamableHTTPClientTransport(new URL(getCursorPiBridgeMcpUrl(run)));
		await client.connect(transport);
		try {
			const clientAbort = new AbortController();
			const callResult = client.callTool(
				{ name: "pi__bash", arguments: { command: "sleep 30" } },
				{ signal: clientAbort.signal },
			).catch((error: unknown) => error);
			const request = await waitForQueuedRequest(run);
			const abort = vi.fn();
			await pi.runToolCall(
				{ type: "tool_call", toolCallId: request.piToolCallId, toolName: "bash", input: request.args },
				{ signal: new AbortController().signal, abort },
			);

			clientAbort.abort();

			expect(await callResult).toBeInstanceOf(Error);
			await vi.waitFor(() => expect(abort).toHaveBeenCalledOnce());
			expect(__testUtils.getActiveBridgeToolExecutionAbortCount()).toBe(0);
			expect(run.hasPendingPiToolCallId(request.piToolCallId)).toBe(false);
		} finally {
			await client.close().catch(() => undefined);
			await transport.close().catch(() => undefined);
			await run.dispose();
		}
	});

	it("blocks a bridge tool event that reaches pi after its call expired", async () => {
		process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS = "1";
		process.env.PI_CURSOR_PI_BRIDGE_CALL_TIMEOUT_MS = "500";
		const pi = createBridgePiHarness({
			active: ["bash"],
			tools: [createBuiltinToolInfo("bash", Type.Object({ command: Type.String() }), "Run shell commands")],
		});
		const run = await registerCursorPiToolBridge(pi).createRun();
		const client = new Client({ name: "pi-cursor-sdk-test", version: "1.0.0" });
		const transport = new StreamableHTTPClientTransport(new URL(getCursorPiBridgeMcpUrl(run)));
		await client.connect(transport);
		try {
			const callResult = client.callTool({ name: "pi__bash", arguments: { command: "sleep 30" } }).catch((error: unknown) => error);
			const request = await waitForQueuedRequest(run);
			expect(await callResult).toBeInstanceOf(Error);

			const hookResult = await pi.runToolCall({
				type: "tool_call",
				toolCallId: request.piToolCallId,
				toolName: "bash",
				input: request.args,
			});

			expect(hookResult).toEqual({ block: true, reason: "Cursor pi bridge tool call is no longer pending" });
		} finally {
			await client.close().catch(() => undefined);
			await transport.close().catch(() => undefined);
			await run.dispose();
		}
	});

	it("does not let a superseded tool_call handler block the replacement bridge", async () => {
		process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS = "1";
		const pi = createBridgePiHarness({
			active: ["bash"],
			tools: [createBuiltinToolInfo("bash", Type.Object({ command: Type.String() }), "Run shell commands")],
		});
		registerCursorPiToolBridge(pi);
		const run = await registerCursorPiToolBridge(pi).createRun();
		const client = new Client({ name: "pi-cursor-sdk-test", version: "1.0.0" });
		const transport = new StreamableHTTPClientTransport(new URL(getCursorPiBridgeMcpUrl(run)));
		await client.connect(transport);
		try {
			const callPromise = client.callTool({ name: "pi__bash", arguments: { command: "echo ok" } });
			const request = await waitForQueuedRequest(run);

			const hookResult = await pi.runToolCall(
				{
					type: "tool_call",
					toolCallId: request.piToolCallId,
					toolName: "bash",
					input: request.args,
				},
				{
					signal: new AbortController().signal,
					abort: vi.fn(),
				},
			);

			expect(hookResult).toBeUndefined();
			expect(run.hasPendingPiToolCallId(request.piToolCallId)).toBe(true);

			await run.resolveToolResultsFromContext({
				systemPrompt: "",
				messages: [
					{
						role: "toolResult",
						toolCallId: request.piToolCallId,
						toolName: "bash",
						content: [{ type: "text", text: "ok" }],
						isError: false,
						timestamp: 1,
					},
				],
			});
			await expect(callPromise).resolves.toMatchObject({
				content: [{ type: "text", text: "ok" }],
			});
		} finally {
			await client.close().catch(() => undefined);
			await transport.close().catch(() => undefined);
			await run.dispose();
		}
	});

	it("aborts active pi execution when its bridge run is cancelled", async () => {
		process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS = "1";
		const pi = createBridgePiHarness({
			active: ["bash"],
			tools: [createBuiltinToolInfo("bash", Type.Object({ command: Type.String() }), "Run shell commands")],
		});
		const run = await registerCursorPiToolBridge(pi).createRun();
		const client = new Client({ name: "pi-cursor-sdk-test", version: "1.0.0" });
		const transport = new StreamableHTTPClientTransport(new URL(getCursorPiBridgeMcpUrl(run)));
		await client.connect(transport);
		try {
			const callResult = client.callTool({ name: "pi__bash", arguments: { command: "sleep 30" } }).catch((error: unknown) => error);
			const request = await waitForQueuedRequest(run);
			const abort = vi.fn();
			await pi.runToolCall(
				{ type: "tool_call", toolCallId: request.piToolCallId, toolName: "bash", input: request.args },
				{ signal: new AbortController().signal, abort },
			);

			run.cancel("cancelled by test");

			expect(await callResult).toBeInstanceOf(Error);
			expect(abort).toHaveBeenCalledOnce();
			expect(__testUtils.getActiveBridgeToolExecutionAbortCount()).toBe(0);
		} finally {
			await client.close().catch(() => undefined);
			await transport.close().catch(() => undefined);
			await run.dispose();
		}
	});
});
