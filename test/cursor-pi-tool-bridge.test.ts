import { describe, it, expect, vi, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerConfig } from "@cursor/sdk";
import type { Context } from "@earendil-works/pi-ai";
import type { ExtensionHandler, SessionShutdownEvent, ToolInfo } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import {
	createBridgePiHarness,
	createBuiltinToolInfo,
	createTestToolInfo,
	getCursorPiBridgeMcpUrl,
} from "./helpers/pi-harness.js";
import { __testUtils as nativeToolDisplayTestUtils } from "../src/cursor-native-tool-display-state.js";
import {
	CURSOR_PI_BRIDGE_TOOL_CALL_ID_MAX_LENGTH,
	buildCursorPiBridgeToolCallId,
	isCursorPiBridgeToolCallId,
} from "../src/cursor-pi-tool-bridge-constants.js";
import {
	__testUtils,
	buildCursorPiToolBridgeSnapshot,
	buildCursorPiToolBridgeSurfaceSignature,
	registerCursorPiToolBridge,
	resolveCursorPiToolBridgeBuiltinsEnabled,
	resolveCursorPiToolBridgeDebugEnabled,
	resolveCursorPiToolBridgeEnabled,
	type CursorPiToolBridgeRun,
} from "../src/cursor-pi-tool-bridge.js";

function createToolInfo(name: string, description = `${name} description`, parameters: TSchema = Type.Object({})): ToolInfo {
	return createTestToolInfo(name, parameters, description);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForQueuedRequests(run: CursorPiToolBridgeRun) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const requests = run.takeQueuedToolRequests();
		if (requests.length > 0) return requests;
		await sleep(10);
	}
	throw new Error("Timed out waiting for queued bridge request");
}

async function connectClient(url: string) {
	const client = new Client({ name: "pi-cursor-sdk-test", version: "1.0.0" });
	const transport = new StreamableHTTPClientTransport(new URL(url));
	await client.connect(transport);
	return { client, transport };
}

function getBridgeEndpointMaterial(run: CursorPiToolBridgeRun) {
	const bridgeUrl = getCursorPiBridgeMcpUrl(run);
	const url = new URL(bridgeUrl);
	const segments = url.pathname.split("/").filter(Boolean);
	expect(segments).toHaveLength(3);
	expect(segments[0]).toBe("cursor-pi-tool-bridge");
	expect(segments[2]).toBe("mcp");
	return {
		url,
		endpointPath: url.pathname,
		endpointToken: segments[1]!,
	};
}

function collectBridgeDiagnosticOutput() {
	const chunks: string[] = [];
	const originalWrite = process.stderr.write;
	process.stderr.write = ((
		chunk: string | Uint8Array,
		encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
		callback?: (error?: Error | null) => void,
	): boolean => {
		chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
		const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
		done?.();
		return true;
	}) as typeof process.stderr.write;

	return {
		records(): Array<Record<string, unknown>> {
			const prefix = `${__testUtils.CURSOR_PI_TOOL_BRIDGE_DIAGNOSTIC_PREFIX} `;
			return chunks
				.join("")
				.split("\n")
				.filter((line) => line.startsWith(prefix))
				.map((line) => JSON.parse(line.slice(prefix.length)) as Record<string, unknown>);
		},
		restore(): void {
			process.stderr.write = originalWrite;
		},
	};
}

describe("cursor pi tool bridge flags and snapshots", () => {
	afterEach(async () => {
		delete process.env.PI_CURSOR_PI_TOOL_BRIDGE;
		delete process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS;
		delete process.env.PI_CURSOR_PI_TOOL_BRIDGE_DEBUG;
		nativeToolDisplayTestUtils.reset();
		await __testUtils.resetRegisteredBridgeForTests();
	});

	it("defaults the bridge on and built-in overlap exposure off with explicit env controls", () => {
		expect(resolveCursorPiToolBridgeEnabled({})).toBe(true);
		expect(resolveCursorPiToolBridgeEnabled({ PI_CURSOR_PI_TOOL_BRIDGE: "0" })).toBe(false);
		expect(resolveCursorPiToolBridgeEnabled({ PI_CURSOR_PI_TOOL_BRIDGE: "false" })).toBe(false);
		expect(resolveCursorPiToolBridgeEnabled({ PI_CURSOR_PI_TOOL_BRIDGE: "off" })).toBe(false);
		expect(resolveCursorPiToolBridgeEnabled({ PI_CURSOR_PI_TOOL_BRIDGE: "none" })).toBe(false);
		expect(resolveCursorPiToolBridgeEnabled({ PI_CURSOR_PI_TOOL_BRIDGE: "1" })).toBe(true);
		expect(resolveCursorPiToolBridgeEnabled({ PI_CURSOR_PI_TOOL_BRIDGE: "true" })).toBe(true);

		expect(resolveCursorPiToolBridgeBuiltinsEnabled({})).toBe(false);
		expect(resolveCursorPiToolBridgeBuiltinsEnabled({ PI_CURSOR_EXPOSE_BUILTIN_TOOLS: "0" })).toBe(false);
		expect(resolveCursorPiToolBridgeBuiltinsEnabled({ PI_CURSOR_EXPOSE_BUILTIN_TOOLS: "off" })).toBe(false);
		expect(resolveCursorPiToolBridgeBuiltinsEnabled({ PI_CURSOR_EXPOSE_BUILTIN_TOOLS: "unexpected" })).toBe(false);
		expect(resolveCursorPiToolBridgeBuiltinsEnabled({ PI_CURSOR_EXPOSE_BUILTIN_TOOLS: "1" })).toBe(true);
		expect(resolveCursorPiToolBridgeBuiltinsEnabled({ PI_CURSOR_EXPOSE_BUILTIN_TOOLS: "true" })).toBe(true);

		expect(resolveCursorPiToolBridgeDebugEnabled({})).toBe(false);
		expect(resolveCursorPiToolBridgeDebugEnabled({ PI_CURSOR_PI_TOOL_BRIDGE_DEBUG: "false" })).toBe(false);
		expect(resolveCursorPiToolBridgeDebugEnabled({ PI_CURSOR_PI_TOOL_BRIDGE_DEBUG: "0" })).toBe(false);
		expect(resolveCursorPiToolBridgeDebugEnabled({ PI_CURSOR_PI_TOOL_BRIDGE_DEBUG: "unexpected" })).toBe(false);
		expect(resolveCursorPiToolBridgeDebugEnabled({ PI_CURSOR_PI_TOOL_BRIDGE_DEBUG: "1" })).toBe(true);
		expect(resolveCursorPiToolBridgeDebugEnabled({ PI_CURSOR_PI_TOOL_BRIDGE_DEBUG: "true" })).toBe(true);
	});

	it("maps only active pi tools, includes dynamic tools, and excludes only registered internal Cursor replay names", () => {
		const readParameters = Type.Object({ path: Type.String({ description: "Path to read" }) });
		const dynamicParameters = Type.Object({ target: Type.String() });
		const tools = [
			createToolInfo("custom_read", "Custom read files", readParameters),
			createToolInfo("bash", "Run shell commands"),
			createToolInfo("sem_reindex", "Reindex semantic cache", dynamicParameters),
			createToolInfo("cursor"),
		];
		const pi = createBridgePiHarness({
			active: ["custom_read", "sem_reindex", "inactive_missing", "cursor"],
			tools,
		});

		const externalSnapshot = buildCursorPiToolBridgeSnapshot(pi);
		expect(externalSnapshot.tools.map((tool) => tool.piToolName)).toEqual(["custom_read", "sem_reindex", "cursor"]);

		nativeToolDisplayTestUtils.registerNativeToolNameForTests("cursor");
		const snapshot = buildCursorPiToolBridgeSnapshot(pi);

		expect(snapshot.tools.map((tool) => tool.piToolName)).toEqual(["custom_read", "sem_reindex"]);
		expect(snapshot.tools.map((tool) => tool.mcpToolName)).toEqual(["pi__custom_read", "pi__sem_reindex"]);
		expect(snapshot.mcpToolNameToPiToolName.get("pi__custom_read")).toBe("custom_read");
		expect(snapshot.piToolNameToMcpToolName.get("sem_reindex")).toBe("pi__sem_reindex");
		expect(snapshot.tools[0].description).toBe("Custom read files");
		expect(snapshot.tools[0].inputSchema).toBe(readParameters);
		expect(snapshot.tools[1].inputSchema).toBe(dynamicParameters);
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});

	it("hides overlapping pi tool names by default while keeping non-overlapping tools", () => {
		const tools = [
			createToolInfo("read", "Replay-wrapped read tool"),
			createBuiltinToolInfo("bash", Type.Object({}), "Run shell commands"),
			createBuiltinToolInfo("write", Type.Object({}), "Write files"),
			createBuiltinToolInfo("edit", Type.Object({}), "Edit files"),
			createBuiltinToolInfo("grep", Type.Object({}), "Search files"),
			createBuiltinToolInfo("find", Type.Object({}), "Find files"),
			createBuiltinToolInfo("ls", Type.Object({}), "List files"),
			createBuiltinToolInfo("todo", Type.Object({}), "Non-overlapping built-in"),
			createToolInfo("sem_reindex", "Reindex semantic cache"),
		];
		const pi = createBridgePiHarness({
			active: tools.map((tool) => tool.name),
			tools,
		});

		const defaultSnapshot = buildCursorPiToolBridgeSnapshot(pi);
		expect(defaultSnapshot.tools.map((tool) => tool.piToolName)).toEqual(["todo", "sem_reindex"]);
		expect(defaultSnapshot.tools.map((tool) => tool.mcpToolName)).toEqual(["pi__todo", "pi__sem_reindex"]);

		const optInSnapshot = buildCursorPiToolBridgeSnapshot(pi, {
			exposeOverlappingBuiltins: true,
		});
		expect(optInSnapshot.tools.map((tool) => tool.piToolName)).toEqual([
			"read",
			"bash",
			"write",
			"edit",
			"grep",
			"find",
			"ls",
			"todo",
			"sem_reindex",
		]);
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});

	it("exposes native replay-registered edit and write when opt-in builtins are enabled", () => {
		nativeToolDisplayTestUtils.registerNativeToolNameForTests("edit");
		nativeToolDisplayTestUtils.registerNativeToolNameForTests("write");
		try {
			const tools = [
				createBuiltinToolInfo("edit", Type.Object({}), "Edit files"),
				createBuiltinToolInfo("write", Type.Object({}), "Write files"),
				createToolInfo("sem_reindex", "Reindex semantic cache"),
			];
			const pi = createBridgePiHarness({
				active: tools.map((tool) => tool.name),
				tools,
			});
			const snapshot = buildCursorPiToolBridgeSnapshot(pi, { exposeOverlappingBuiltins: true });
			expect(snapshot.tools.map((tool) => tool.piToolName)).toEqual(["edit", "write", "sem_reindex"]);
		} finally {
			nativeToolDisplayTestUtils.reset();
		}
	});

	it("wraps Windows bridge bash abort markers without breaking compound shell commands", () => {
		const command = __testUtils.buildWindowsBridgeBashAbortCommandForTests("if true; then echo ok; fi", "bridge_call_1");

		expect(command).toBe("export PI_CURSOR_BRIDGE_TOOL_CALL_ID=bridge_call_1; if true; then echo ok; fi");
		expect(command).toContain("PI_CURSOR_BRIDGE_TOOL_CALL_ID=bridge_call_1");
		expect(command).not.toMatch(/^PI_CURSOR_BRIDGE_TOOL_CALL_ID=bridge_call_1 if /);
	});

	it("builds bounded provider-facing bridge tool call IDs", () => {
		const runUuid = "c2417032-9686-40f2-bd3c-a763fbaa7693";
		const firstId = buildCursorPiBridgeToolCallId(runUuid, 1);
		const boundaryId = buildCursorPiBridgeToolCallId(runUuid, 9_999_999_999_999);

		expect(firstId).toBe("cursor-pi-bridge-c2417032968640f2bd3ca763fbaa7693-t1");
		expect(firstId).toHaveLength(52);
		expect(isCursorPiBridgeToolCallId(firstId)).toBe(true);
		expect(boundaryId).toHaveLength(CURSOR_PI_BRIDGE_TOOL_CALL_ID_MAX_LENGTH);
		expect(boundaryId).toMatch(/^cursor-pi-bridge-[0-9a-f]{32}-t9999999999999$/);
		expect(isCursorPiBridgeToolCallId(boundaryId)).toBe(true);
		expect(isCursorPiBridgeToolCallId(`${boundaryId}0`)).toBe(false);
		expect(isCursorPiBridgeToolCallId("cursor-pi-bridge-c2417032968640f2bd3ca763fbaa7693-t")).toBe(false);
		expect(isCursorPiBridgeToolCallId("cursor-pi-bridge-c2417032968640f2bd3ca763fbaa769-t1")).toBe(false);
		expect(isCursorPiBridgeToolCallId("cursor-pi-bridge-c2417032-9686-40f2-bd3c-a763fbaa7693-t1")).toBe(false);
		expect(isCursorPiBridgeToolCallId("ordinary-tool-call")).toBe(false);

		expect(() => buildCursorPiBridgeToolCallId(runUuid, 10_000_000_000_000)).toThrow(
			"Cursor pi bridge tool call ID limit exceeded",
		);
		for (const invalidRunUuid of ["not-a-uuid", "c2417032968640f2bd3ca763fbaa7693", "c2417032-9686-40f2-bd3c-a763fbaa7693-extra"]) {
			expect(() => buildCursorPiBridgeToolCallId(invalidRunUuid, 1)).toThrow(
				"Cursor pi bridge run UUID must be canonical",
			);
		}
		for (const counter of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
			expect(() => buildCursorPiBridgeToolCallId(runUuid, counter)).toThrow(
				"Cursor pi bridge tool call counter must be a positive safe integer",
			);
		}
	});

	it("uses stable collision-safe MCP names", () => {
		const pi = createBridgePiHarness({
			active: ["tool one", "tool_one"],
			tools: [createToolInfo("tool one"), createToolInfo("tool_one")],
		});

		const snapshot = buildCursorPiToolBridgeSnapshot(pi);

		expect(snapshot.tools).toHaveLength(2);
		expect(snapshot.tools[0].mcpToolName).toBe("pi__tool_one");
		expect(snapshot.tools[1].mcpToolName).toMatch(/^pi__tool_one__[a-f0-9]{8}$/);
		expect(new Set(snapshot.tools.map((tool) => tool.mcpToolName)).size).toBe(2);
	});
});

describe("cursor pi tool bridge loopback MCP lifecycle", () => {
	afterEach(async () => {
		delete process.env.PI_CURSOR_PI_TOOL_BRIDGE;
		delete process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS;
		delete process.env.PI_CURSOR_PI_TOOL_BRIDGE_DEBUG;
		nativeToolDisplayTestUtils.reset();
		await __testUtils.resetRegisteredBridgeForTests();
	});

	it("uses endpoint-independent request IDs so historical tool results cannot resolve a new run", async () => {
		const registry = __testUtils.createRegistry(
			createBridgePiHarness({ active: ["read"], tools: [createToolInfo("read", "Read files", Type.Object({ path: Type.String() }))] }),
			{ PI_CURSOR_EXPOSE_BUILTIN_TOOLS: "1" },
		);
		const run = await registry.createRun();
		const { endpointToken } = getBridgeEndpointMaterial(run);
		const { client, transport } = await connectClient(getCursorPiBridgeMcpUrl(run));
		try {
			const callPromise = client.callTool({ name: "pi__read", arguments: { path: "current.txt" } });
			const [request] = await waitForQueuedRequests(run);
			const historicalSequentialToolCallId = "cursor-pi-bridge-run-1-tool-1";

			expect(run.id).toMatch(/^cursor-pi-bridge-run-[0-9a-f-]{36}$/);
			expect(request.runId).toBe(run.id);
			expect(request.piToolCallId).not.toContain(run.id);
			expect(request.piToolCallId.length).toBeLessThanOrEqual(64);
			expect(request.piToolCallId).not.toBe(historicalSequentialToolCallId);
			expect(request.bridgeCallId).not.toContain(endpointToken);
			expect(request.piToolCallId).not.toContain(endpointToken);

			await run.resolveToolResultsFromContext({
				systemPrompt: "",
				messages: [
					{
						role: "toolResult",
						toolCallId: historicalSequentialToolCallId,
						toolName: "read",
						content: [{ type: "text", text: "stale historical secret result" }],
						isError: false,
						timestamp: 1,
					},
				],
			});
			expect(run.hasPendingPiToolCallId(request.piToolCallId)).toBe(true);

			await run.resolveToolResultsFromContext({
				systemPrompt: "",
				messages: [
					{
						role: "toolResult",
						toolCallId: request.piToolCallId,
						toolName: "read",
						content: [{ type: "text", text: "current result" }],
						isError: false,
						timestamp: 2,
					},
				],
			});
			await expect(callPromise).resolves.toMatchObject({ content: [{ type: "text", text: "current result" }] });
		} finally {
			await client.close().catch(() => undefined);
			await transport.close().catch(() => undefined);
			await run.dispose();
		}
	});

	it("keeps double-digit bridge tool call IDs within the OpenAI limit", async () => {
		expect(
			isCursorPiBridgeToolCallId("cursor-pi-bridge-run-c2417032-9686-40f2-bd3c-a763fbaa7693-tool-10"),
		).toBe(true);
		const registry = __testUtils.createRegistry(
			createBridgePiHarness({ active: ["read"], tools: [createToolInfo("read")] }),
			{ PI_CURSOR_EXPOSE_BUILTIN_TOOLS: "1" },
		);
		const run = await registry.createRun();
		const { client, transport } = await connectClient(getCursorPiBridgeMcpUrl(run));
		try {
			const calls = Array.from({ length: 10 }, (_, index) =>
				client.callTool({ name: "pi__read", arguments: { path: `file-${index}.txt` } }),
			);
			const requests = [];
			while (requests.length < calls.length) {
				requests.push(...(await waitForQueuedRequests(run)));
			}
			const ids = requests.map((request) => request.piToolCallId);

			expect(ids).toHaveLength(10);
			expect(ids.at(-1)).toMatch(/-t10$/);
			expect(new Set(ids).size).toBe(ids.length);
			for (const id of ids) {
				expect(id.length).toBeLessThanOrEqual(64);
				expect(isCursorPiBridgeToolCallId(id)).toBe(true);
			}

			await run.resolveToolResults(
				requests.map((request, index) => ({
					role: "toolResult",
					toolCallId: request.piToolCallId,
					toolName: request.piToolName,
					content: [{ type: "text", text: `result-${index}` }],
					isError: false,
					timestamp: index,
				})),
			);
			await expect(Promise.all(calls)).resolves.toHaveLength(10);
		} finally {
			await client.close().catch(() => undefined);
			await transport.close().catch(() => undefined);
			await run.dispose();
		}
	});

	it("skips MCP injection when disabled or when the active snapshot is empty", async () => {
		const tools = [createToolInfo("cursor")];
		const disabledRegistry = __testUtils.createRegistry(
			createBridgePiHarness({ active: ["read"], tools: [createToolInfo("read")] }),
			{ PI_CURSOR_PI_TOOL_BRIDGE: "0" },
		);
		const disabledRun = await disabledRegistry.createRun();
		expect(disabledRun.enabled).toBe(false);
		expect(disabledRun.mcpServers).toBeUndefined();
		expect(disabledRegistry.getEndpointCount()).toBe(0);

		nativeToolDisplayTestUtils.registerNativeToolNameForTests("cursor");
		const emptyRegistry = __testUtils.createRegistry(
			createBridgePiHarness({ active: ["cursor"], tools }),
			{},
		);
		const emptyRun = await emptyRegistry.createRun();
		expect(emptyRun.enabled).toBe(false);
		expect(emptyRun.snapshot.tools).toEqual([]);
		expect(emptyRun.mcpServers).toBeUndefined();
		expect(emptyRegistry.getEndpointCount()).toBe(0);
	});

	it("does not emit bridge diagnostics unless explicitly enabled", async () => {
		const diagnostics = collectBridgeDiagnosticOutput();
		try {
			const registry = __testUtils.createRegistry(
				createBridgePiHarness({ active: ["read"], tools: [createToolInfo("read")] }),
				{ PI_CURSOR_EXPOSE_BUILTIN_TOOLS: "1" },
			);
			const run = await registry.createRun();
			await run.dispose();

			expect(diagnostics.records()).toEqual([]);
		} finally {
			diagnostics.restore();
		}
	});

	it("serializes only allowlisted diagnostic fields", () => {
		type DiagnosticEventForTests = Parameters<typeof __testUtils.serializeDiagnosticForTests>[0];
		const rawCursorMcpCallId = "http://127.0.0.1/secret-cursor-mcp-call-id?token=secret-token";
		const record = __testUtils.serializeDiagnosticForTests({
			event: "request_queued",
			runId: "safe-run",
			bridgeCallId: "safe-bridge",
			cursorMcpCallId: rawCursorMcpCallId,
			piToolCallId: "safe-tool",
			mcpToolName: "pi__read",
			piToolName: "read",
			pendingCount: 1,
			endpointUrl: "http://127.0.0.1:1234/cursor-pi-tool-bridge/secret-endpoint-token/mcp",
			endpointPath: "/cursor-pi-tool-bridge/secret-endpoint-token/mcp",
			args: { path: "/secret/path.txt", apiKey: "secret-api-key" },
			result: { content: "raw result with bearer token" },
		} as DiagnosticEventForTests & {
			endpointUrl: string;
			endpointPath: string;
			args: Record<string, unknown>;
			result: Record<string, unknown>;
		});

		expect(record).toMatchObject({
			event: "request_queued",
			runId: "safe-run",
			bridgeCallId: "safe-bridge",
			piToolCallId: "safe-tool",
			mcpToolName: "pi__read",
			piToolName: "read",
			pendingCount: 1,
		});
		expect(record.cursorMcpCallId).toMatch(/^cursor-mcp-call-[0-9a-f]{8}$/);
		expect(record.cursorMcpCallId).not.toBe(rawCursorMcpCallId);
		const serialized = JSON.stringify(record);
		expect(serialized).not.toContain("secret-endpoint-token");
		expect(serialized).not.toContain("secret-cursor-mcp-call-id");
		expect(serialized).not.toContain("secret-token");
		expect(serialized).not.toContain("http://127.0.0.1");
		expect(serialized).not.toContain("/cursor-pi-tool-bridge/");
		expect(serialized).not.toContain("/secret/path.txt");
		expect(serialized).not.toContain("secret-api-key");
		expect(serialized).not.toContain("raw result");
		expect(serialized).not.toContain("bearer token");
	});

	it("emits scrubbed lifecycle diagnostics when explicitly enabled", async () => {
		const diagnostics = collectBridgeDiagnosticOutput();
		try {
			const disabledRegistry = __testUtils.createRegistry(
				createBridgePiHarness({ active: ["read"], tools: [createToolInfo("read")] }),
				{ PI_CURSOR_PI_TOOL_BRIDGE_DEBUG: "1", PI_CURSOR_PI_TOOL_BRIDGE: "0" },
			);
			const disabledRun = await disabledRegistry.createRun();
			await disabledRun.dispose();

			const registry = __testUtils.createRegistry(
				createBridgePiHarness({ active: ["read"], tools: [createToolInfo("read", "Read files")] }),
				{ PI_CURSOR_PI_TOOL_BRIDGE_DEBUG: "1", PI_CURSOR_EXPOSE_BUILTIN_TOOLS: "1" },
			);
			const run = await registry.createRun();
			const { endpointPath, endpointToken } = getBridgeEndpointMaterial(run);
			expect(endpointPath).not.toContain(run.id);
			await run.dispose();

			const records = diagnostics.records();
			const skipped = records.find((record) => record.event === "run_skipped");
			const created = records.find((record) => record.event === "run_created" && record.enabled === true);
			const exposed = records.find((record) => record.event === "tools_exposed");
			const disposed = records.filter((record) => record.event === "run_disposed");

			expect(skipped).toMatchObject({ enabled: false, exposedToolCount: 0, reason: "disabled" });
			expect(created).toMatchObject({ enabled: true, exposedToolCount: 1, pendingCount: 0 });
			expect(exposed).toMatchObject({
				enabled: true,
				exposedToolCount: 1,
				pairs: [{ piToolName: "read", mcpToolName: "pi__read" }],
			});
			expect(disposed).toHaveLength(2);
			expect(disposed.at(-1)).toMatchObject({ enabled: true, exposedToolCount: 1, pendingCount: 0 });
			const serialized = JSON.stringify(records);
			expect(serialized).not.toContain(endpointToken);
			expect(serialized).not.toContain(endpointPath);
			expect(serialized).not.toContain("http://");
			expect(serialized).not.toContain("127.0.0.1");
			expect(serialized).not.toContain("/cursor-pi-tool-bridge/");
			expect(serialized).not.toContain("/mcp");
		} finally {
			diagnostics.restore();
		}
	});

	it("emits scrubbed request diagnostics for queue, resolution, cancellation, and rejection", async () => {
		const diagnostics = collectBridgeDiagnosticOutput();
		const registry = __testUtils.createRegistry(
			createBridgePiHarness({ active: ["read"], tools: [createToolInfo("read", "Read files", Type.Object({ path: Type.String() }))] }),
			{ PI_CURSOR_PI_TOOL_BRIDGE_DEBUG: "1", PI_CURSOR_EXPOSE_BUILTIN_TOOLS: "1" },
		);
		const run = await registry.createRun();
		const { endpointPath, endpointToken } = getBridgeEndpointMaterial(run);
		const { client, transport } = await connectClient(getCursorPiBridgeMcpUrl(run));
		try {
			const resolvedCallPromise = client.callTool({
				name: "pi__read",
				arguments: {
					path: "/secret/path.txt",
					apiKey: "secret-api-key",
					cookie: "session-cookie",
					content: "raw file contents",
				},
			});
			const [resolvedRequest] = await waitForQueuedRequests(run);
			expect(resolvedRequest.runId).toBe(run.id);
			expect(resolvedRequest.bridgeCallId).toContain(run.id);
			expect(resolvedRequest.piToolCallId).not.toContain(run.id);
			expect(resolvedRequest.piToolCallId).toMatch(/^cursor-pi-bridge-[0-9a-f]{32}-t\d+$/);
			expect(resolvedRequest.bridgeCallId).not.toContain(endpointToken);
			expect(resolvedRequest.piToolCallId).not.toContain(endpointToken);
			await run.resolveToolResultsFromContext({
				systemPrompt: "",
				messages: [
					{
						role: "toolResult",
						toolCallId: resolvedRequest.piToolCallId,
						toolName: "read",
						content: [{ type: "text", text: "raw result with bearer token and file contents" }],
						isError: false,
						timestamp: 1,
					},
				],
			});
			await expect(resolvedCallPromise).resolves.toMatchObject({
				content: [{ type: "text", text: "raw result with bearer token and file contents" }],
			});

			const rejectedCallPromise = client.callTool({
				name: "pi__read",
				arguments: { path: "/cancelled/secret.txt", token: "secret-token" },
			}).catch((error: unknown) => error);
			await waitForQueuedRequests(run);
			run.cancel("secret cancellation reason with Bearer secret-token");
			const rejectedError = await rejectedCallPromise;
			expect(rejectedError).toBeInstanceOf(Error);

			const records = diagnostics.records();
			const queued = records.filter((record) => record.event === "request_queued");
			const resolved = records.find((record) => record.event === "request_resolved");
			const cancelled = records.find((record) => record.event === "run_cancelled");
			const rejected = records.find((record) => record.event === "request_rejected");

			expect(queued).toHaveLength(2);
			expect(queued[0]).toMatchObject({
				bridgeCallId: resolvedRequest.bridgeCallId,
				piToolCallId: resolvedRequest.piToolCallId,
				mcpToolName: "pi__read",
				piToolName: "read",
				pendingCount: 1,
			});
			expect(queued[0].cursorMcpCallId).toMatch(/^cursor-mcp-call-[0-9a-f]{8}$/);
			expect(queued[0].cursorMcpCallId).not.toBe(resolvedRequest.cursorMcpCallId);
			expect(resolved).toMatchObject({
				bridgeCallId: resolvedRequest.bridgeCallId,
				mcpToolName: "pi__read",
				piToolName: "read",
				pendingCount: 0,
				isError: false,
			});
			expect(cancelled).toMatchObject({ pendingCount: 1, queuedCount: 0, cancelledRequestCount: 1 });
			expect(rejected).toMatchObject({
				mcpToolName: "pi__read",
				piToolName: "read",
				pendingCount: 0,
				rejectionKind: "cancelled",
			});

			const serialized = JSON.stringify(records);
			expect(serialized).not.toContain("/secret/path.txt");
			expect(serialized).not.toContain("/cancelled/secret.txt");
			expect(serialized).not.toContain("secret-api-key");
			expect(serialized).not.toContain("secret-token");
			expect(serialized).not.toContain("session-cookie");
			expect(serialized).not.toContain("raw file contents");
			expect(serialized).not.toContain("raw result");
			expect(serialized).not.toContain("Bearer");
			expect(serialized).not.toContain(endpointToken);
			expect(serialized).not.toContain(endpointPath);
			expect(serialized).not.toContain("http://");
			expect(serialized).not.toContain("127.0.0.1");
			expect(serialized).not.toContain("/cursor-pi-tool-bridge/");
		} finally {
			await client.close().catch(() => undefined);
			await transport.close().catch(() => undefined);
			await run.dispose();
			diagnostics.restore();
		}
	});

	it("binds a tokenized per-run MCP endpoint only on 127.0.0.1 and cleans it up", async () => {
		const registry = __testUtils.createRegistry(
			createBridgePiHarness({
				active: ["read"],
				tools: [
					createTestToolInfo("read", Type.Object({}), "Read files", [
						"Use read when exact file contents are required.",
						"Do not use read for directory listings.",
					]),
				],
			}),
			{ PI_CURSOR_EXPOSE_BUILTIN_TOOLS: "1" },
		);
		const run = await registry.createRun();

		expect(run.enabled).toBe(true);
		expect(run.mcpServers?.pi_tools?.type).toBe("http");
		const { url, endpointPath, endpointToken } = getBridgeEndpointMaterial(run);
		expect(url.hostname).toBe("127.0.0.1");
		expect(endpointPath).toMatch(/^\/cursor-pi-tool-bridge\/[^/]+\/mcp$/);
		expect(endpointPath).not.toContain(run.id);
		expect(endpointToken).not.toBe(run.id);
		expect(run.id).toMatch(/^cursor-pi-bridge-run-[0-9a-f-]{36}$/);
		expect(run.id).not.toMatch(/^cursor-pi-bridge-run-\d+$/);
		expect(registry.getHttpServerAddress()?.address).toBe("127.0.0.1");
		expect(registry.getEndpointCount()).toBe(1);

		const { client, transport } = await connectClient(getCursorPiBridgeMcpUrl(run));
		try {
			const listed = await client.listTools();
			expect(listed.tools.map((tool) => tool.name)).toEqual(["pi__read"]);
			expect(listed.tools[0].description).toContain("Read files");
			expect(listed.tools[0].description).toContain("Pi tool prompt guidelines:");
			expect(listed.tools[0].description).toContain("- Use read when exact file contents are required.");
			expect(listed.tools[0].description).toContain("- Do not use read for directory listings.");
			expect(listed.tools[0].description).toContain("Call MCP name pi__read (pi tool: read)");
			expect(listed.tools[0].description).toContain("Full tool-surface rules are in the session bootstrap prompt.");
			expect(listed.tools[0].description).not.toContain("Pi bridge contract:");
		} finally {
			await client.close();
			await transport.close();
		}

		await run.dispose();
		expect(registry.getEndpointCount()).toBe(0);
		expect(registry.getHttpServerAddress()).toBeUndefined();
	});

	it("queues MCP calls, maps them back to real pi tool names, and resolves from pi tool results", async () => {
		const registry = __testUtils.createRegistry(
			createBridgePiHarness({ active: ["read"], tools: [createToolInfo("read", "Read files", Type.Object({ path: Type.String() }))] }),
			{ PI_CURSOR_EXPOSE_BUILTIN_TOOLS: "1" },
		);
		const run = await registry.createRun();
		const { client, transport } = await connectClient(getCursorPiBridgeMcpUrl(run));
		try {
			const callPromise = client.callTool({ name: "pi__read", arguments: { path: "README.md" } });
			const [request] = await waitForQueuedRequests(run);

			expect(request.piToolName).toBe("read");
			expect(request.mcpToolName).toBe("pi__read");
			expect(request.args).toEqual({ path: "README.md" });
			expect(request.cursorMcpCallId).toBeDefined();
			expect(run.isBridgeMcpToolCall({ name: "pi__read" })).toBe(true);
			expect(run.isBridgeMcpToolCall({ name: "mcp", args: { toolName: "pi__read" } })).toBe(true);
			expect(run.isBridgeMcpToolCall({ name: "mcp", args: [{ toolName: "pi__read" }] })).toBe(true);
			expect(run.isBridgeMcpToolCall({ name: "pi_tools", args: { toolName: "pi__read" } })).toBe(true);
			expect(run.isBridgeMcpToolCall({ name: "mcp", arguments: { mcpToolName: "pi__read" } })).toBe(true);
			expect(run.isBridgeMcpToolCall({ name: "mcp", args: { toolName: "other_tool" } })).toBe(false);
			expect(run.isBridgeMcpToolCall({ name: "mcp", result: { toolName: "pi__read" } })).toBe(false);
			expect(run.isBridgeMcpToolCall({ name: "mcp", value: "pi__read", details: { toolName: "pi__read" } })).toBe(false);
			expect(run.isBridgeMcpToolCall({ name: "mcp", result: { text: "mentions pi__read here" } })).toBe(false);
			expect(run.isBridgeMcpToolCall({ name: "external_search", id: request.cursorMcpCallId })).toBe(false);
			expect(run.isBridgeMcpToolCall({ name: "mcp", id: request.cursorMcpCallId })).toBe(true);

			const context: Context = {
				systemPrompt: "",
				messages: [
					{
						role: "toolResult",
						toolCallId: request.piToolCallId,
						toolName: "read",
						content: [{ type: "text", text: "file contents" }],
						isError: false,
						timestamp: 1,
					},
				],
			};
			await run.resolveToolResultsFromContext(context);

			await expect(callPromise).resolves.toMatchObject({
				content: [{ type: "text", text: "file contents" }],
			});
		} finally {
			await client.close();
			await transport.close();
			await run.dispose();
		}
	});

	it("aborts active bridged pi tool execution on process interrupt", async () => {
		const pi = createBridgePiHarness({
			active: ["bash"],
			tools: [createBuiltinToolInfo("bash", Type.Object({ command: Type.String() }), "Run shell commands")],
		});
		const sigintListenerCount = process.listenerCount("SIGINT");
		const sigtermListenerCount = process.listenerCount("SIGTERM");
		process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS = "1";
		const bridge = registerCursorPiToolBridge(pi);
		const run = await bridge.createRun();
		const { client, transport } = await connectClient(getCursorPiBridgeMcpUrl(run));
		try {
			const callPromise = client.callTool({ name: "pi__bash", arguments: { command: "sleep 30" } });
			const observedCallError = callPromise.catch((error: unknown) => error);
			const [request] = await waitForQueuedRequests(run);
			const agentAbort = vi.fn();
			const abortController = new AbortController();
			const bashInput = request.args as { command: string };

			const hookResult = await pi.runToolCall(
				{
					type: "tool_call",
					toolCallId: request.piToolCallId,
					toolName: "bash",
					input: bashInput,
				},
				{
					signal: abortController.signal,
					abort: agentAbort,
				},
			);
			expect(hookResult).toBeUndefined();
			expect(__testUtils.getActiveBridgeToolExecutionAbortCount()).toBe(1);
			expect(process.listenerCount("SIGINT")).toBe(sigintListenerCount + 1);
			expect(process.listenerCount("SIGTERM")).toBe(sigtermListenerCount + 1);

			__testUtils.emitBridgeToolExecutionProcessAbortSignalForTests("SIGINT");

			expect(agentAbort).toHaveBeenCalledOnce();
			expect(__testUtils.getActiveBridgeToolExecutionAbortCount()).toBe(0);
			expect(process.listenerCount("SIGINT")).toBe(sigintListenerCount);
			expect(process.listenerCount("SIGTERM")).toBe(sigtermListenerCount);
			const error = await observedCallError;
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toMatch(/SIGINT|MCP error/i);

			await pi.runToolResult({
				type: "tool_result",
				toolCallId: request.piToolCallId,
				toolName: "bash",
				input: bashInput,
				content: [{ type: "text", text: "" }],
				isError: false,
				details: undefined,
			});
			expect(__testUtils.getActiveBridgeToolExecutionAbortCount()).toBe(0);
		} finally {
			await client.close().catch(() => undefined);
			await transport.close().catch(() => undefined);
			await run.dispose();
		}
	});

	it("aborts active bridged pi tool execution when the tool context signal aborts", async () => {
		const pi = createBridgePiHarness({
			active: ["bash"],
			tools: [createBuiltinToolInfo("bash", Type.Object({ command: Type.String() }), "Run shell commands")],
		});
		process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS = "1";
		const bridge = registerCursorPiToolBridge(pi);
		const run = await bridge.createRun();
		const { client, transport } = await connectClient(getCursorPiBridgeMcpUrl(run));
		try {
			const callPromise = client.callTool({ name: "pi__bash", arguments: { command: "sleep 30" } });
			const observedCallError = callPromise.catch((error: unknown) => error);
			const [request] = await waitForQueuedRequests(run);
			const agentAbort = vi.fn();
			const abortController = new AbortController();
			const bashInput = request.args as { command: string };

			await pi.runToolCall(
				{
					type: "tool_call",
					toolCallId: request.piToolCallId,
					toolName: "bash",
					input: bashInput,
				},
				{
					signal: abortController.signal,
					abort: agentAbort,
				},
			);
			expect(__testUtils.getActiveBridgeToolExecutionAbortCount()).toBe(1);

			abortController.abort();

			expect(agentAbort).toHaveBeenCalledOnce();
			expect(__testUtils.getActiveBridgeToolExecutionAbortCount()).toBe(0);
			const error = await observedCallError;
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toMatch(/aborted|MCP error/i);
		} finally {
			await client.close().catch(() => undefined);
			await transport.close().catch(() => undefined);
			await run.dispose();
		}
	});

	it("cleans active bridged pi tool execution on session shutdown without a tool result", async () => {
		const pi = createBridgePiHarness({
			active: ["bash"],
			tools: [createBuiltinToolInfo("bash", Type.Object({ command: Type.String() }), "Run shell commands")],
		});
		process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS = "1";
		const bridge = registerCursorPiToolBridge(pi);
		const run = await bridge.createRun();
		const { client, transport } = await connectClient(getCursorPiBridgeMcpUrl(run));
		try {
			const callPromise = client.callTool({ name: "pi__bash", arguments: { command: "sleep 30" } });
			const observedCallError = callPromise.catch((error: unknown) => error);
			const [request] = await waitForQueuedRequests(run);
			const agentAbort = vi.fn();
			const abortController = new AbortController();
			const bashInput = request.args as { command: string };

			await pi.runToolCall(
				{
					type: "tool_call",
					toolCallId: request.piToolCallId,
					toolName: "bash",
					input: bashInput,
				},
				{
					signal: abortController.signal,
					abort: agentAbort,
				},
			);
			expect(__testUtils.getActiveBridgeToolExecutionAbortCount()).toBe(1);

			await pi.runSessionShutdown({ reason: "new" });

			expect(agentAbort).toHaveBeenCalledOnce();
			expect(__testUtils.getActiveBridgeToolExecutionAbortCount()).toBe(0);
			const error = await observedCallError;
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toMatch(/session shutdown|MCP error/i);
		} finally {
			await client.close().catch(() => undefined);
			await transport.close().catch(() => undefined);
		}
	});

	it("contains bridged pi tool abort callback failures during interrupt cleanup", async () => {
		const pi = createBridgePiHarness({
			active: ["bash"],
			tools: [createBuiltinToolInfo("bash", Type.Object({ command: Type.String() }), "Run shell commands")],
		});
		process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS = "1";
		const bridge = registerCursorPiToolBridge(pi);
		const run = await bridge.createRun();
		const { client, transport } = await connectClient(getCursorPiBridgeMcpUrl(run));
		try {
			const callPromise = client.callTool({ name: "pi__bash", arguments: { command: "sleep 30" } });
			const observedCallError = callPromise.catch((error: unknown) => error);
			const [request] = await waitForQueuedRequests(run);
			const bashInput = request.args as { command: string };

			await pi.runToolCall(
				{
					type: "tool_call",
					toolCallId: request.piToolCallId,
					toolName: "bash",
					input: bashInput,
				},
				{
					signal: new AbortController().signal,
					abort: () => {
						throw new Error("abort failed");
					},
				},
			);

			expect(() => __testUtils.emitBridgeToolExecutionProcessAbortSignalForTests("SIGINT")).not.toThrow();
			expect(__testUtils.getActiveBridgeToolExecutionAbortCount()).toBe(0);
			const error = await observedCallError;
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toMatch(/SIGINT|MCP error/i);
		} finally {
			await client.close().catch(() => undefined);
			await transport.close().catch(() => undefined);
			await run.dispose();
		}
	});


	it("rejects pending MCP waits on registered session shutdown cleanup", async () => {
		const pi = createBridgePiHarness({ active: ["read"], tools: [createToolInfo("read")] });
		process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS = "1";
		const bridge = registerCursorPiToolBridge(pi);
		const run = await bridge.createRun();
		const { client, transport } = await connectClient(getCursorPiBridgeMcpUrl(run));
		try {
			const callPromise = client.callTool({ name: "pi__read", arguments: { path: "README.md" } });
			const observedCallError = callPromise.catch((error: unknown) => error);
			await waitForQueuedRequests(run);

			await pi.runSessionShutdown({ reason: "new" });

			const error = await observedCallError;
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toMatch(/session shutdown|MCP error/i);
		} finally {
			await client.close().catch(() => undefined);
			await transport.close().catch(() => undefined);
		}
	});

	it("rejects MCP calls and clears pending state when immediate tool dispatch throws", async () => {
		const diagnostics = collectBridgeDiagnosticOutput();
		const registry = __testUtils.createRegistry(
			createBridgePiHarness({ active: ["read"], tools: [createToolInfo("read")] }),
			{ PI_CURSOR_EXPOSE_BUILTIN_TOOLS: "1", PI_CURSOR_PI_TOOL_BRIDGE_DEBUG: "1" },
		);
		const run = await registry.createRun({
			onToolRequest: () => {
				throw new Error("handler failed");
			},
		});
		const { client, transport } = await connectClient(getCursorPiBridgeMcpUrl(run));
		try {
			const error = await client.callTool({ name: "pi__read", arguments: { path: "README.md" } }).catch((callError: unknown) => callError);
			const queued = diagnostics.records().find((record) => record.event === "request_queued");
			const rejected = diagnostics.records().find((record) => record.event === "request_rejected");

			expect(error).toBeInstanceOf(Error);
			expect(queued?.piToolCallId).toEqual(expect.any(String));
			expect(rejected).toMatchObject({ piToolCallId: queued?.piToolCallId, pendingCount: 0, rejectionKind: "error" });
			expect(run.hasPendingPiToolCallId(queued?.piToolCallId as string)).toBe(false);
		} finally {
			await client.close().catch(() => undefined);
			await transport.close().catch(() => undefined);
			await run.dispose();
			diagnostics.restore();
		}
	});

	it("rejects queued MCP calls and clears pending state when replayed tool dispatch throws", async () => {
		const diagnostics = collectBridgeDiagnosticOutput();
		const registry = __testUtils.createRegistry(
			createBridgePiHarness({ active: ["read"], tools: [createToolInfo("read")] }),
			{ PI_CURSOR_EXPOSE_BUILTIN_TOOLS: "1", PI_CURSOR_PI_TOOL_BRIDGE_DEBUG: "1" },
		);
		const run = await registry.createRun();
		const { client, transport } = await connectClient(getCursorPiBridgeMcpUrl(run));
		try {
			const callPromise = client.callTool({ name: "pi__read", arguments: { path: "README.md" } }).catch((callError: unknown) => callError);
			await vi.waitFor(() => expect(diagnostics.records().some((record) => record.event === "request_queued")).toBe(true));
			const queued = diagnostics.records().find((record) => record.event === "request_queued");

			run.setOnToolRequest(() => {
				throw new Error("handler failed");
			});

			const error = await callPromise;
			const rejected = diagnostics.records().find((record) => record.event === "request_rejected");
			expect(error).toBeInstanceOf(Error);
			expect(queued?.piToolCallId).toEqual(expect.any(String));
			expect(rejected).toMatchObject({ piToolCallId: queued?.piToolCallId, pendingCount: 0, rejectionKind: "error" });
			expect(run.hasPendingPiToolCallId(queued?.piToolCallId as string)).toBe(false);
		} finally {
			await client.close().catch(() => undefined);
			await transport.close().catch(() => undefined);
			await run.dispose();
			diagnostics.restore();
		}
	});

	it("rejects MCP calls when no live run handler is bound", async () => {
		const registry = __testUtils.createRegistry(
			createBridgePiHarness({ active: ["read"], tools: [createToolInfo("read")] }),
			{ PI_CURSOR_EXPOSE_BUILTIN_TOOLS: "1" },
		);
		const run = await registry.createRun({ onToolRequest: () => {} });
		run.setOnToolRequest(undefined);
		const { client, transport } = await connectClient(getCursorPiBridgeMcpUrl(run));
		try {
			const callPromise = client.callTool({ name: "pi__read", arguments: { path: "README.md" } });
			const error = await callPromise.catch((callError: unknown) => callError);
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toMatch(/no active live run|MCP error/i);
		} finally {
			await client.close().catch(() => undefined);
			await transport.close().catch(() => undefined);
			await run.dispose();
		}
	});

	it("rejects pending MCP waits on abort/dispose", async () => {
		const registry = __testUtils.createRegistry(
			createBridgePiHarness({ active: ["read"], tools: [createToolInfo("read")] }),
			{ PI_CURSOR_EXPOSE_BUILTIN_TOOLS: "1" },
		);
		const run = await registry.createRun();
		const { client, transport } = await connectClient(getCursorPiBridgeMcpUrl(run));
		try {
			const callPromise = client.callTool({ name: "pi__read", arguments: { path: "README.md" } });
			const observedCallError = callPromise.catch((error: unknown) => error);
			await waitForQueuedRequests(run);

			run.cancel("aborted by test");

			const error = await observedCallError;
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toMatch(/aborted by test|MCP error/i);
		} finally {
			await client.close().catch(() => undefined);
			await transport.close().catch(() => undefined);
			await run.dispose();
		}
	});

	it("changes the bridge surface signature when tool schema changes but the MCP name stays the same", () => {
		const schema = Type.Object({ target: Type.String() });
		const schemaV2 = Type.Object({ target: Type.String(), force: Type.Optional(Type.Boolean()) });
		const snapshotA = buildCursorPiToolBridgeSnapshot(createBridgePiHarness({ active: ["sem_reindex"], tools: [createToolInfo("sem_reindex", "Reindex", schema)] }));
		const snapshotB = buildCursorPiToolBridgeSnapshot(createBridgePiHarness({ active: ["sem_reindex"], tools: [createToolInfo("sem_reindex", "Reindex", schemaV2)] }));

		expect(buildCursorPiToolBridgeSurfaceSignature(snapshotA)).not.toBe(buildCursorPiToolBridgeSurfaceSignature(snapshotB));
	});
});
