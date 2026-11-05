import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import {
	createAgentSessionFromServices, createAgentSessionServices, createCodemodeExtension,
	createMcpExtension, createToolSearchExtension, SessionManager, SettingsManager,
	type AgentSession, type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { getCurrentTools, normalizeContext } from "@earendil-works/pi-ai";
import type { CallToolResult } from "@modelcontextprotocol/client";
import {
	asMockCursorRun, connectMcpClient, getPiToolsMcpUrlFromAgentCreateOptions,
	mockCreatedAgent, resetCursorProviderTestState, getCreatedAgentOptions, mockedCreate,
} from "./helpers/cursor-provider-harness.js";
import { makeProviderModelConfig } from "./helpers/pi-harness.js";
import { registerCursorProviderBinding } from "../src/cursor-provider-binding.js";
import { registerCursorSessionScope } from "../src/cursor-session-scope.js";
import { registerCursorSessionAgentLifecycle } from "../src/cursor-session-agent-lifecycle.js";
import { registerCursorNativeToolDisplayState } from "../src/cursor-native-tool-display-state.js";
import { registerCursorPiToolBridge } from "../src/cursor-pi-tool-bridge.js";

afterEach(() => vi.unstubAllEnvs());

it.each(["on", "only"] as const)("executes Pi's installed codemode and MCP through the real bridge (mode=%s)", async mode => {
	await resetCursorProviderTestState();
	const root = await mkdtemp(join(tmpdir(), "cursor-builtin-mcp-"));
	const agentDir = join(root, "agent");
	await mkdir(agentDir);
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("PI_CURSOR_LEAN", undefined);
	vi.stubEnv("PI_CURSOR_LOCAL_RESUME", "0");
	vi.stubEnv("PI_OFFLINE", "1");
	const settingsManager = SettingsManager.inMemory({
		defaultTools: ["read", "bash", "codemode", "tool_search"], codemode: { mode },
		compaction: { enabled: false }, retry: { enabled: false },
	});
	let pi!: ExtensionAPI;
	const errors: unknown[] = [];
	const nestedCalls: { toolName: string; parentToolCallId?: string }[] = [];
	const modelConfig = makeProviderModelConfig("grok-4.6");
	let session: AgentSession | undefined;
	let declaredNames: string[] = [];
	let initialDeclaredNames: string[] | undefined;
	let bridgeNames: string[] = [];
	let codemodeDescription = "";
	const connections = new Map<string, ReturnType<typeof connectMcpClient>>();
	const replies: CallToolResult[] = [];
	const script = [
		'const found = await searchTools("echo", { namespace: "proof" });',
		'const schema = await describeTool("mcp__proof__echo");',
		'const namespace = await describeNamespace("proof");',
		'const echo = await tools.mcp__proof__echo({ value: "CODEMODE_MCP_OK" });',
		'const failure = await tools.mcp__proof__fail({ value: "expected error" });',
		'const blocked = await Promise.allSettled([tools.mcp__proof__deferred({ value: "blocked" })]);',
		'const resource = await tools.read_mcp_resource({ server: "proof", uri: "proof://text" });',
		'const shell = await tools.bash({ command: "echo CODEMODE_SHELL_OK" });',
		'text({ found: found.map(t => t.name), schema, namespace: namespace.name, hidden: ALL_TOOLS.some(t => t.name === "mcp__proof__hidden"), echo: echo.structuredContent, failed: failure.isError, blocked: blocked[0].status, blockedReason: blocked[0].reason?.message, resource, shell: shell.output.trim() });',
		'store("proof", "CODEMODE_STORE_OK");',
	].join("\n");
	const plans = [
		[{ name: "pi__codemode", arguments: { code: script } },
			mode === "only"
				? { name: "pi__codemode", arguments: { code: 'text(await tools.mcp__proof__direct({ value: "DIRECT_MCP_OK" }));' } }
				: { name: "pi__mcp__proof__direct", arguments: { value: "DIRECT_MCP_OK" } },
			{ name: "pi__tool_search", arguments: { query: "deferred", limit: 1 } }],
		[{ name: "pi__mcp__proof__deferred", arguments: { value: "LOADED_MCP_OK" } },
			{ name: "pi__codemode", arguments: { code: 'text(load("proof"));' } }],
	];
	const send = vi.fn().mockImplementation(async () => {
		const completed = Promise.withResolvers<{ id: string; status: "finished"; result: string }>();
		const index = send.mock.calls.length;
		const id = `run-builtin-${index}`;
		// External SDK transport is substituted, not Pi's executor, codemode VM,
		// MCP client/server, bridge, permissions, or persisted session path.
		void (async () => {
			const url = getPiToolsMcpUrlFromAgentCreateOptions(getCreatedAgentOptions(mockedCreate.mock.calls.length - 1));
			if (!connections.has(url)) connections.set(url, connectMcpClient(url));
			const { client } = await connections.get(url)!;
			const catalog = await client.listTools();
			bridgeNames = catalog.tools.map(tool => tool.name);
			codemodeDescription = catalog.tools.find(tool => tool.name === "pi__codemode")?.description ?? "";
			for (const call of plans[index - 1]) replies.push(await client.callTool(call));
			completed.resolve({ id, status: "finished", result: "BUILTIN_OK" });
		})().catch(completed.reject);
		return asMockCursorRun({ id, agentId: "agent-builtin", status: "running", wait: () => completed.promise });
	});
	mockCreatedAgent({ agentId: "agent-builtin", send });
	try {
		const services = await createAgentSessionServices({
			cwd: root, agentDir, settingsManager,
			resourceLoaderOptions: {
				noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
				extensionFactories: [createCodemodeExtension({ mode }), createToolSearchExtension(), createMcpExtension(), api => {
					pi = api;
					api.registerMcpServer("proof", {
						command: process.execPath,
						args: [fileURLToPath(new URL("./fixtures/builtin-mcp-server.mjs", import.meta.url))],
						exposure: "codemode", toolExposure: { direct: "direct", deferred: "deferred", hidden: "hidden" },
					});
					api.on("tool_call", event => {
						nestedCalls.push({ toolName: event.toolName, parentToolCallId: event.parentToolCallId });
						if (event.toolName === "mcp__proof__deferred" && event.input.value === "blocked") return { block: true, reason: "verification permission gate" };
					});
					registerCursorSessionScope(api);
					registerCursorNativeToolDisplayState(api);
					registerCursorPiToolBridge(api);
					registerCursorSessionAgentLifecycle(api);
					registerCursorProviderBinding(api)([modelConfig], () => {});
				}],
			},
		});
		await services.modelRuntime.setRuntimeApiKey("cursor", "test-key");
		const manager = SessionManager.create(root, join(root, "sessions"));
		({ session } = await createAgentSessionFromServices({ services, sessionManager: manager, model: services.modelRuntime.getModel("cursor", "grok-4.6") }));
		await session.bindExtensions({ mode: "json", onError: error => errors.push(error) });
		const stream = session.agent.streamFunction;
		session.agent.streamFunction = (model, context, options) => {
			declaredNames = getCurrentTools(normalizeContext(context).messages).map(tool => tool.name);
			initialDeclaredNames ??= declaredNames;
			return stream(model, context, options);
		};
		await session.prompt("Verify codemode and local MCP.");
		expect(errors).toEqual([]);
		expect(session.getLastAssistantText(), JSON.stringify(session.messages.filter(message => message.role === "assistant"))).toBe("BUILTIN_OK");
		expect(replies[0].isError).not.toBe(true);
		const output = replies[0].content.filter(block => block.type === "text").map(block => block.text).join("\n");
		expect(output).toContain("Script completed");
		const data = JSON.parse(output.split("\n").find(line => line.startsWith('{"found"'))!);
		expect(data).toMatchObject({
			found: expect.arrayContaining(["mcp__proof__echo"]), namespace: "mcp__proof", hidden: false,
			echo: { tool: "echo", value: "CODEMODE_MCP_OK" }, failed: true, blocked: "rejected",
			blockedReason: expect.stringContaining("verification permission gate"), shell: "CODEMODE_SHELL_OK",
		});
		expect(JSON.stringify(data.schema)).toContain("value");
		expect(JSON.stringify(data.resource)).toContain("MCP_RESOURCE_OK");
		expect(replies[1].isError).not.toBe(true);
		expect(JSON.stringify(replies[1].content)).toContain("DIRECT_MCP_OK");
		expect(replies[2].isError).not.toBe(true);
		expect(JSON.stringify(replies[2].content)).toContain("mcp__proof__deferred");
		expect(nestedCalls.filter(call => call.toolName === "mcp__proof__echo")).toEqual([
			{ toolName: "mcp__proof__echo", parentToolCallId: expect.stringMatching(/^cursor-pi-bridge-/) },
		]);
		expect(pi.getAllTools().find(tool => tool.name === "codemode")?.parameters).toMatchObject({ required: ["code"], properties: { code: { type: "string" } } });
		expect(bridgeNames.sort()).toEqual(initialDeclaredNames!.map(name => `pi__${name}`).sort());
		if (mode === "only") {
			expect(bridgeNames).not.toContain("pi__bash");
			expect(codemodeDescription).toContain("Nested tools:");
			expect(codemodeDescription).toContain("tools: { bash(args:");
		}
		await session.prompt("Read the stored codemode state.");
		expect(session.getLastAssistantText(), JSON.stringify(session.messages.filter(message => message.role === "assistant"))).toBe("BUILTIN_OK");
		expect(bridgeNames).toContain("pi__mcp__proof__deferred");
		expect(replies[3].isError).not.toBe(true);
		expect(JSON.stringify(replies[3].content)).toContain("LOADED_MCP_OK");
		expect(JSON.stringify(replies.at(-1)?.content)).toContain("CODEMODE_STORE_OK");
		const persisted = await readFile(manager.getSessionFile()!, "utf8");
		expect(persisted).toContain('"customType":"codemode-store"');
		expect(persisted).toContain('"nestedCalls"');
		expect(persisted).toContain('"toolName":"codemode"');
	} finally {
		try {
			await session?.abort();
			for (const connection of connections.values()) {
				const connected = await connection.catch(() => undefined);
				if (connected) await Promise.allSettled([connected.client.close(), connected.transport.close()]);
			}
			await session?.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
		} finally {
			session?.dispose();
			await rm(root, { recursive: true, force: true });
		}
	}
}, 20_000);
