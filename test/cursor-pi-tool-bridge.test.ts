import { describe, it, expect, vi, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Context } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	__testUtils,
	buildCursorPiToolBridgeSnapshot,
	registerCursorPiToolBridge,
	resolveCursorPiToolBridgeBuiltinsEnabled,
	resolveCursorPiToolBridgeEnabled,
	type CursorPiToolBridgeRun,
} from "../src/cursor-pi-tool-bridge.js";

function createToolInfo(name: string, description = `${name} description`, parameters = Type.Object({})): ToolInfo {
	return {
		name,
		description,
		parameters,
		sourceInfo: { source: "test", path: `test:${name}`, scope: "temporary", origin: "top-level" },
	};
}

function createBuiltinToolInfo(name: string, description = `${name} description`, parameters = Type.Object({})): ToolInfo {
	return {
		name,
		description,
		parameters,
		sourceInfo: { source: "builtin", path: `<builtin:${name}>`, scope: "temporary", origin: "top-level" },
	};
}

function createMockPi(options: { active: string[]; tools: ToolInfo[] }) {
	return {
		getActiveTools: vi.fn(() => [...options.active]),
		getAllTools: vi.fn(() => [...options.tools]),
		setActiveTools: vi.fn(),
	};
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

describe("cursor pi tool bridge flags and snapshots", () => {
	afterEach(async () => {
		delete process.env.PI_CURSOR_PI_TOOL_BRIDGE;
		delete process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS;
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
	});

	it("maps only active pi tools, includes dynamic tools, and excludes internal Cursor replay names", () => {
		const readParameters = Type.Object({ path: Type.String({ description: "Path to read" }) });
		const dynamicParameters = Type.Object({ target: Type.String() });
		const tools = [
			createToolInfo("custom_read", "Custom read files", readParameters),
			createToolInfo("bash", "Run shell commands"),
			createToolInfo("sem_reindex", "Reindex semantic cache", dynamicParameters),
			createToolInfo("cursor"),
			createToolInfo("cursor_edit"),
			createToolInfo("cursor_mcp"),
		];
		const pi = createMockPi({
			active: ["custom_read", "sem_reindex", "inactive_missing", "cursor", "cursor_edit", "cursor_mcp"],
			tools,
		});

		const snapshot = buildCursorPiToolBridgeSnapshot(pi as Pick<ExtensionAPI, "getActiveTools" | "getAllTools">);

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
			createBuiltinToolInfo("bash", "Run shell commands"),
			createBuiltinToolInfo("write", "Write files"),
			createBuiltinToolInfo("edit", "Edit files"),
			createBuiltinToolInfo("grep", "Search files"),
			createBuiltinToolInfo("find", "Find files"),
			createBuiltinToolInfo("ls", "List files"),
			createBuiltinToolInfo("todo", "Non-overlapping built-in"),
			createToolInfo("sem_reindex", "Reindex semantic cache"),
		];
		const pi = createMockPi({
			active: tools.map((tool) => tool.name),
			tools,
		});

		const defaultSnapshot = buildCursorPiToolBridgeSnapshot(pi as Pick<ExtensionAPI, "getActiveTools" | "getAllTools">);
		expect(defaultSnapshot.tools.map((tool) => tool.piToolName)).toEqual(["todo", "sem_reindex"]);
		expect(defaultSnapshot.tools.map((tool) => tool.mcpToolName)).toEqual(["pi__todo", "pi__sem_reindex"]);

		const optInSnapshot = buildCursorPiToolBridgeSnapshot(pi as Pick<ExtensionAPI, "getActiveTools" | "getAllTools">, {
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

	it("uses stable collision-safe MCP names", () => {
		const pi = createMockPi({
			active: ["tool one", "tool_one"],
			tools: [createToolInfo("tool one"), createToolInfo("tool_one")],
		});

		const snapshot = buildCursorPiToolBridgeSnapshot(pi as Pick<ExtensionAPI, "getActiveTools" | "getAllTools">);

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
		await __testUtils.resetRegisteredBridgeForTests();
	});

	it("skips MCP injection when disabled or when the active snapshot is empty", async () => {
		const tools = [createToolInfo("cursor"), createToolInfo("cursor_edit")];
		const disabledRegistry = __testUtils.createRegistry(
			createMockPi({ active: ["read"], tools: [createToolInfo("read")] }) as Pick<ExtensionAPI, "getActiveTools" | "getAllTools">,
			{ PI_CURSOR_PI_TOOL_BRIDGE: "0" },
		);
		const disabledRun = await disabledRegistry.createRun();
		expect(disabledRun.enabled).toBe(false);
		expect(disabledRun.mcpServers).toBeUndefined();
		expect(disabledRegistry.getEndpointCount()).toBe(0);

		const emptyRegistry = __testUtils.createRegistry(
			createMockPi({ active: ["cursor", "cursor_edit"], tools }) as Pick<ExtensionAPI, "getActiveTools" | "getAllTools">,
			{},
		);
		const emptyRun = await emptyRegistry.createRun();
		expect(emptyRun.enabled).toBe(false);
		expect(emptyRun.snapshot.tools).toEqual([]);
		expect(emptyRun.mcpServers).toBeUndefined();
		expect(emptyRegistry.getEndpointCount()).toBe(0);
	});

	it("binds a tokenized per-run MCP endpoint only on 127.0.0.1 and cleans it up", async () => {
		const registry = __testUtils.createRegistry(
			createMockPi({ active: ["read"], tools: [createToolInfo("read", "Read files")] }) as Pick<ExtensionAPI, "getActiveTools" | "getAllTools">,
			{ PI_CURSOR_EXPOSE_BUILTIN_TOOLS: "1" },
		);
		const run = await registry.createRun();

		expect(run.enabled).toBe(true);
		expect(run.mcpServers?.pi_tools?.type).toBe("http");
		const url = new URL(run.mcpServers!.pi_tools.url);
		expect(url.hostname).toBe("127.0.0.1");
		expect(url.pathname).toMatch(/^\/cursor-pi-tool-bridge\/cursor-pi-bridge-[^/]+\/[^/]+\/mcp$/);
		expect(registry.getHttpServerAddress()?.address).toBe("127.0.0.1");
		expect(registry.getEndpointCount()).toBe(1);

		const { client, transport } = await connectClient(run.mcpServers!.pi_tools.url);
		try {
			const listed = await client.listTools();
			expect(listed.tools.map((tool) => tool.name)).toEqual(["pi__read"]);
			expect(listed.tools[0].description).toBe("Read files");
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
			createMockPi({ active: ["read"], tools: [createToolInfo("read", "Read files", Type.Object({ path: Type.String() }))] }) as Pick<ExtensionAPI, "getActiveTools" | "getAllTools">,
			{ PI_CURSOR_EXPOSE_BUILTIN_TOOLS: "1" },
		);
		const run = await registry.createRun();
		const { client, transport } = await connectClient(run.mcpServers!.pi_tools.url);
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
			run.resolveToolResultsFromContext(context);

			await expect(callPromise).resolves.toMatchObject({
				content: [{ type: "text", text: "file contents" }],
			});
		} finally {
			await client.close();
			await transport.close();
			await run.dispose();
		}
	});

	it("rejects pending MCP waits on registered session shutdown cleanup", async () => {
		const sessionShutdownHandlers: Array<(event: { reason: "new" }) => Promise<void> | void> = [];
		const pi = {
			...createMockPi({ active: ["read"], tools: [createToolInfo("read")] }),
			on: vi.fn((event: string, handler: (event: { reason: "new" }) => Promise<void> | void) => {
				if (event === "session_shutdown") sessionShutdownHandlers.push(handler);
			}),
		};
		process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS = "1";
		const bridge = registerCursorPiToolBridge(pi as unknown as ExtensionAPI);
		const run = await bridge.createRun();
		const { client, transport } = await connectClient(run.mcpServers!.pi_tools.url);
		try {
			const callPromise = client.callTool({ name: "pi__read", arguments: { path: "README.md" } });
			const observedCallError = callPromise.catch((error: unknown) => error);
			await waitForQueuedRequests(run);

			await sessionShutdownHandlers[0]!({ reason: "new" });

			const error = await observedCallError;
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toMatch(/session shutdown|MCP error/i);
		} finally {
			await client.close().catch(() => undefined);
			await transport.close().catch(() => undefined);
		}
	});

	it("rejects pending MCP waits on abort/dispose", async () => {
		const registry = __testUtils.createRegistry(
			createMockPi({ active: ["read"], tools: [createToolInfo("read")] }) as Pick<ExtensionAPI, "getActiveTools" | "getAllTools">,
			{ PI_CURSOR_EXPOSE_BUILTIN_TOOLS: "1" },
		);
		const run = await registry.createRun();
		const { client, transport } = await connectClient(run.mcpServers!.pi_tools.url);
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
});
