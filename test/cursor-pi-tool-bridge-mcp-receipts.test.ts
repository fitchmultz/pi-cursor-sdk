import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { __testUtils } from "../src/cursor-pi-tool-bridge.js";
import { createBridgePiHarness, createTestToolInfo, getCursorPiBridgeMcpUrl } from "./helpers/pi-harness.js";

describe("installed MCP server initialization and catalog diagnostic receipts", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-bridge-receipts-"));
	const file = join(directory, "diagnostics.jsonl");
	const records = () => readFileSync(file, "utf8").trim().split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
	const receipts = (runId: string) => records().filter((record) =>
		record.runId === runId && (record.event === "mcp_initialized" || record.event === "mcp_tools_list"));
	const createRegistry = () => __testUtils.createRegistry(
		createBridgePiHarness({
			active: ["subagent"],
			tools: [createTestToolInfo("subagent", Type.Object({ task: Type.String() }), "private catalog description")],
		}),
		{ PI_CURSOR_PI_TOOL_BRIDGE_DEBUG_FILE: file },
	);

	afterEach(() => {
		rmSync(file, { force: true });
	});
	afterAll(() => {
		rmSync(directory, { recursive: true, force: true });
	});

	it("records owning-run validated initialization and catalog output without private wire data", async () => {
		const registry = createRegistry();
		const run = await registry.createRun();
		const otherRun = await registry.createRun();
		const url = getCursorPiBridgeMcpUrl(run);
		// Cursor SDK 1.0.36's bundled MCP client uses the legacy initialize/initialized handshake.
		const client = new Client(
			{ name: "private-client-name", version: "private-client-version" },
			{ versionNegotiation: { mode: "legacy" } },
		);
		const transport = new StreamableHTTPClientTransport(new URL(url), {
			requestInit: { headers: { authorization: "Bearer private-header-token" } },
		});
		try {
			expect(receipts(run.id)).toEqual([]);
			await client.connect(transport);
			await vi.waitFor(() => expect(receipts(run.id)).toEqual([
				{ event: "mcp_initialized", runId: run.id },
			]));
			expect(receipts(otherRun.id)).toEqual([]);

			const invalid = await fetch(url, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
					"mcp-session-id": transport.sessionId!,
					"mcp-protocol-version": "2025-11-25",
				},
				body: JSON.stringify({
					jsonrpc: "2.0", id: "private-protocol-id", method: "tools/list",
					params: { cursor: 42 },
				}),
			});
			const invalidBody = await invalid.text();
			expect(invalidBody).toContain('"error"');
			expect(invalidBody).toContain("cursor");
			expect(receipts(run.id)).toHaveLength(1);

			const listed = await client.listTools();
			expect(listed.tools.map((tool) => tool.name)).toEqual(["pi__subagent"]);
			expect(receipts(run.id)).toEqual([
				{ event: "mcp_initialized", runId: run.id },
				{ event: "mcp_tools_list", runId: run.id, toolCount: 1 },
			]);
			expect(receipts(otherRun.id)).toEqual([]);

			const cancelledCall = client.callTool({
				name: "pi__subagent", arguments: { task: "private-request-argument" },
			}).catch((error: unknown) => error);
			await vi.waitFor(() => expect(records()).toContainEqual(expect.objectContaining({
				event: "request_queued", runId: run.id,
			})));
			run.cancel("private-cancellation-reason");
			expect(await cancelledCall).toBeInstanceOf(Error);
			expect(records()).toContainEqual(expect.objectContaining({
				event: "request_rejected", runId: run.id, rejectionKind: "cancelled",
			}));
			expect(run.hasPendingToolCalls()).toBe(false);

			const wire = readFileSync(file, "utf8");
			for (const privateValue of [
				url, new URL(url).pathname, transport.sessionId!, "private-header-token",
				"private-protocol-id", "private-client-name", "private-client-version",
				"private catalog description", "inputSchema", "private-request-argument",
				"private-cancellation-reason",
			]) {
				expect(wire).not.toContain(privateValue);
			}

			await run.dispose();
			const before = records();
			const afterDispose = await fetch(url, { method: "POST" });
			expect(afterDispose.status).toBe(404);
			expect(records()).toEqual(before);
			expect(registry.getEndpointCount()).toBe(1);
		} finally {
			await client.close().catch(() => undefined);
			await transport.close().catch(() => undefined);
			await registry.disposeAll();
		}
	});

	it("does not mistake initialize admission or invalid requests for completed initialization/catalog receipts", async () => {
		const registry = createRegistry();
		const run = await registry.createRun();
		const url = getCursorPiBridgeMcpUrl(run);
		const headers: Record<string, string> = {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
		};
		const post = (body: unknown, extraHeaders: Record<string, string> = {}) => fetch(url, {
			method: "POST", headers: { ...headers, ...extraHeaders }, body: JSON.stringify(body),
		});
		try {
			const unattached = await post({ jsonrpc: "2.0", id: "private-list-id", method: "tools/list" });
			expect(unattached.status).toBe(400);
			await unattached.text();
			const rejectedOrigin = await post(
				{ jsonrpc: "2.0", id: "private-init-id", method: "initialize", params: {} },
				{ origin: "https://attacker.example" },
			);
			expect(rejectedOrigin.status).toBe(403);
			await rejectedOrigin.text();
			expect(receipts(run.id)).toEqual([]);

			const initialize = await post({
				jsonrpc: "2.0", id: "private-init-id", method: "initialize",
				params: {
					protocolVersion: "2025-11-25", capabilities: {},
					clientInfo: { name: "private-client", version: "1" },
				},
			});
			expect(initialize.status).toBe(200);
			expect(await initialize.text()).toContain('"protocolVersion":"2025-11-25"');
			headers["mcp-session-id"] = initialize.headers.get("mcp-session-id")!;
			headers["mcp-protocol-version"] = "2025-11-25";
			expect(receipts(run.id)).toEqual([]);

			const invalidNotification = await post({ jsonrpc: "2.0", method: "notifications/initialized", params: [] });
			expect(invalidNotification.status).toBe(400);
			await invalidNotification.text();
			expect(receipts(run.id)).toEqual([]);

			// Disposing an uncompleted handshake must not manufacture a completion receipt.
			await run.dispose();
			expect(receipts(run.id)).toEqual([]);
			expect(registry.getEndpointCount()).toBe(0);
			expect(registry.getHttpServerAddress()).toBeUndefined();
		} finally {
			await registry.disposeAll();
		}
	});
});
