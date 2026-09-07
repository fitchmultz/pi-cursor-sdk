import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import {
	resetCursorProviderTestState, mockedCreate, mockCreatedAgent, makeModel, makeContext,
	collectEvents, getCreatedAgentOptions, registerBridgeForProviderTest, createBuiltinToolInfo,
	createTestToolInfo, connectMcpClient, getPiToolsMcpUrlFromAgentCreateOptions, getErrorEvent,
} from "./helpers/cursor-provider-harness.js";
import { streamCursor } from "../src/cursor-provider.js";

const mockSend = vi.fn();
beforeEach(async () => {
	await resetCursorProviderTestState();
	vi.stubEnv("PI_CURSOR_LEAN", undefined);
	mockCreatedAgent({
		agentId: "agent-lean",
		send: mockSend.mockResolvedValue({
			id: "run-lean", agentId: "agent-lean", status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-lean", status: "finished", result: "Hello" }),
			cancel: vi.fn(), supports: () => true, unsupportedReason: () => undefined,
		}),
		[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
	});
});
afterEach(() => vi.unstubAllEnvs());

describe("lean provider", () => {
	it("restricts the SDK to MCP and exposes only active Pi tools including builtins", async () => {
		vi.stubEnv("PI_CURSOR_EXPOSE_BUILTIN_TOOLS", "0");
		vi.stubEnv("PI_CURSOR_PI_TOOL_BRIDGE", "0");
		vi.stubEnv("PI_CURSOR_SETTING_SOURCES", "all");
		const schema = Type.Object({});
		registerBridgeForProviderTest({
			active: ["read", "web_search", "mcp"],
			tools: [createBuiltinToolInfo("read", schema), createBuiltinToolInfo("bash", schema),
				createTestToolInfo("web_search", schema), createTestToolInfo("mcp", schema)],
		});
		let listedNames: string[] = [];
		const defaultSend = mockSend.getMockImplementation()!;
		mockSend.mockImplementation(async () => {
			const options = getCreatedAgentOptions();
			const { client, transport } = await connectMcpClient(getPiToolsMcpUrlFromAgentCreateOptions(options));
			try {
				listedNames = (await client.listTools()).tools.map((tool) => tool.name).sort();
			} finally {
				await client.close();
				await transport.close();
			}
			return defaultSend();
		});
		const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		expect(events.filter((event) => event.type === "error")).toEqual([]);
		const options = getCreatedAgentOptions();
		expect(options.tools).toEqual(["mcp"]);
		expect(options.local?.settingSources).toEqual([]);
		expect(Object.keys(options.mcpServers ?? {})).toHaveLength(1);
		expect(listedNames).toEqual(["pi__mcp", "pi__read", "pi__web_search"]);
	});

	it("offers no SDK tools when the Pi bridge has no active tools", async () => {
		registerBridgeForProviderTest({ active: [], tools: [] });
		await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		expect(getCreatedAgentOptions().tools).toEqual([]);
		expect(getCreatedAgentOptions().local?.settingSources).toEqual([]);
	});

	it("rejects cloud before creating an agent", async () => {
		vi.stubEnv("PI_CURSOR_RUNTIME", "cloud");
		const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		expect(getErrorEvent(events).error.errorMessage).toContain("PI_CURSOR_LEAN requires local runtime");
		expect(mockedCreate).not.toHaveBeenCalled();
	});
});
