import { describe, expect, it, vi } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Type } from "typebox";
import type { CursorSdkEventDebugRecorder } from "../src/cursor-sdk-event-debug.js";
import {
	__testUtils,
	type CursorPiToolBridgeRun,
} from "../src/cursor-pi-tool-bridge.js";
import { createBridgePiHarness, createTestToolInfo, getCursorPiBridgeMcpUrl } from "./helpers/pi-harness.js";

async function waitForQueuedRequest(run: CursorPiToolBridgeRun) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const [request] = run.takeQueuedToolRequests();
		if (request) return request;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Timed out waiting for queued bridge request");
}

describe("cursor pi tool bridge debug safety", () => {
	it("completes initialization, catalog fetch, and bridge calls when diagnostic and raw recording throw", async () => {
		const registry = __testUtils.createRegistry(
			createBridgePiHarness({ active: ["read"], tools: [createTestToolInfo("read", Type.Object({}))] }),
			{ PI_CURSOR_EXPOSE_BUILTIN_TOOLS: "1" },
		);
		const recordBridgeRaw = vi.fn(() => { throw new Error("debug failed"); });
		const debugRecorder: CursorSdkEventDebugRecorder = {
			recordLiveRunEvent: vi.fn(),
			recordBridgeDiagnostic: vi.fn(() => { throw new Error("diagnostic failed"); }),
			recordBridgeRaw,
			recordDisplayDecision: vi.fn(),
			recordCoordinatorEvent: vi.fn(),
			recordDrainEvent: vi.fn(),
			recordFinalPartial: vi.fn(),
			finalize: vi.fn(),
		};
		const run = await registry.createRun({ debugRecorder });
		const client = new Client(
			{ name: "pi-cursor-sdk-test", version: "1.0.0" },
			{ versionNegotiation: { mode: "legacy" } },
		);
		const transport = new StreamableHTTPClientTransport(new URL(getCursorPiBridgeMcpUrl(run)));
		await client.connect(transport);
		try {
			expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["pi__read"]);
			const callPromise = client.callTool({ name: "pi__read", arguments: { path: "README.md" } });
			const request = await waitForQueuedRequest(run);
			await run.resolveToolResultsFromContext({
				systemPrompt: "",
				messages: [{
					role: "toolResult",
					toolCallId: request.piToolCallId,
					toolName: "read",
					content: [{ type: "text", text: "current result" }],
					isError: false,
					timestamp: 1,
				}],
			});

			await expect(callPromise).resolves.toMatchObject({ content: [{ type: "text", text: "current result" }] });
			expect(recordBridgeRaw).toHaveBeenCalledWith(expect.objectContaining({ kind: "queued" }));
			expect(recordBridgeRaw).toHaveBeenCalledWith(expect.objectContaining({ kind: "resolved" }));
		} finally {
			await client.close().catch(() => undefined);
			await transport.close().catch(() => undefined);
			await run.dispose();
		}
	});
});
