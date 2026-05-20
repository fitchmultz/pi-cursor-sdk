import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtensionAPI, ExtensionContext, ProviderConfig, RegisteredCommand, ToolDefinition, ToolInfo } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";

vi.mock("../src/model-discovery.js", () => ({
	discoverModels: vi.fn(),
}));

vi.mock("../src/cursor-provider.js", () => ({
	streamCursor: vi.fn(),
}));

import extensionFactory from "../src/index.js";
import { discoverModels } from "../src/model-discovery.js";
import { streamCursor } from "../src/cursor-provider.js";
import {
	__testUtils as nativeToolDisplayTestUtils,
	canRenderCursorToolNatively,
	recordCursorNativeToolDisplay,
} from "../src/cursor-native-tool-display.js";

const mockedDiscover = vi.mocked(discoverModels);
const mockedStreamCursor = vi.mocked(streamCursor);

type DiscoverOptions = Parameters<typeof discoverModels>[0];
type RegisteredTool = ToolDefinition<TSchema, unknown, unknown>;
type TestExtensionContext = Pick<ExtensionContext, "cwd" | "hasUI"> & {
	ui: Pick<ExtensionContext["ui"], "notify" | "setStatus">;
	sessionManager: Pick<ExtensionContext["sessionManager"], "getBranch">;
};
type TestEventHandler = (event: unknown, ctx: TestExtensionContext) => Promise<void> | void;

function createBuiltinToolInfo(name: string): ToolInfo {
	return {
		name,
		description: "",
		parameters: Type.Object({}),
		sourceInfo: { source: "builtin", path: `<builtin:${name}>`, scope: "temporary", origin: "top-level" },
	};
}

async function runSessionStartHandlers(pi: ReturnType<typeof createMockPi>, ctxOverrides: Partial<TestExtensionContext> = {}): Promise<void> {
	const notify = vi.fn();
	const ctx: TestExtensionContext = {
		cwd: process.cwd(),
		hasUI: true,
		ui: { notify, setStatus: vi.fn() },
		sessionManager: { getBranch: vi.fn(() => []) },
		...ctxOverrides,
	};
	for (const handler of pi._handlers.get("session_start") ?? []) {
		await handler({ reason: "startup" }, ctx);
	}
}

function createMockPi(existingTools?: ToolInfo[]) {
	const registered: Array<{ name: string; config: ProviderConfig }> = [];
	const commands = new Map<string, RegisteredCommand>();
	const tools: RegisteredTool[] = [];
	const handlers = new Map<string, TestEventHandler[]>();
	const initialTools = existingTools ?? ["read", "bash", "ls"].map(createBuiltinToolInfo);
	return {
		registerProvider: vi.fn((name: string, config: ProviderConfig) => {
			registered.push({ name, config });
		}),
		registerFlag: vi.fn(),
		registerCommand: vi.fn((name: string, command: RegisteredCommand) => {
			commands.set(name, command);
		}),
		registerTool: vi.fn((tool: RegisteredTool) => {
			tools.push(tool);
		}),
		getAllTools: vi.fn(() => {
			const toolsByName = new Map<string, ToolInfo>();
			for (const tool of initialTools) toolsByName.set(tool.name, tool);
			for (const tool of tools) {
				toolsByName.set(tool.name, {
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters,
					sourceInfo: { source: "test", path: "pi-cursor-sdk-test", scope: "temporary", origin: "top-level" },
				});
			}
			return [...toolsByName.values()];
		}),
		sendMessage: vi.fn(),
		on: vi.fn((event: string, handler: TestEventHandler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		}),
		getFlag: vi.fn().mockReturnValue(false),
		appendEntry: vi.fn(),
		_registered: registered,
		_commands: commands,
		_tools: tools,
		_handlers: handlers,
	};
}

describe("extension factory", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		delete process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY;
		delete process.env.PI_CURSOR_REGISTER_NATIVE_TOOLS;
		nativeToolDisplayTestUtils.reset();
	});

	it("registers Cursor fast controls and one provider with correct fields", async () => {
		const mockModels = [
			{
				id: "composer-2",
				name: "Cursor Composer 2",
				reasoning: false,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 16384,
			},
		];
		mockedDiscover.mockResolvedValueOnce(mockModels);

		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const pi = createMockPi();
		await extensionFactory(pi as unknown as ExtensionAPI);
		await runSessionStartHandlers(pi);

		expect(pi.registerFlag).toHaveBeenCalledWith(
			"cursor-fast",
			expect.objectContaining({ type: "boolean", default: false }),
		);
		expect(pi.registerFlag).toHaveBeenCalledWith(
			"cursor-no-fast",
			expect.objectContaining({ type: "boolean", default: false }),
		);
		expect(pi.registerCommand).toHaveBeenCalledWith(
			"cursor-fast",
			expect.objectContaining({ description: expect.stringContaining("Toggle Cursor fast") }),
		);
		expect(pi.registerCommand).toHaveBeenCalledWith(
			"cursor-refresh-models",
			expect.objectContaining({ description: expect.stringContaining("Refresh the live Cursor model catalog") }),
		);
		expect(pi.registerTool).toHaveBeenCalledTimes(11);
		expect(pi._tools.map((tool) => tool.name)).toEqual([
			"read",
			"bash",
			"ls",
			"grep",
			"find",
			"cursor_edit",
			"cursor_write",
			"cursor_delete",
			"cursor_read_lints",
			"cursor_mcp",
			"cursor_tool",
		]);
		expect(pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
		expect(pi.on).toHaveBeenCalledWith("model_select", expect.any(Function));
		expect(mockedDiscover).toHaveBeenCalledOnce();
		expect(pi.registerProvider).toHaveBeenCalledOnce();

		const [call] = pi._registered;
		expect(call.name).toBe("cursor");
		expect(call.config.name).toBe("Cursor");
		expect(call.config.apiKey).toBe("CURSOR_API_KEY");
		expect(call.config.api).toBe("cursor-sdk");
		expect(call.config.models).toBe(mockModels);
		expect(call.config.streamSimple).toBe(mockedStreamCursor);
	});

	it("registers provider even with fallback models", async () => {
		mockedDiscover.mockResolvedValueOnce([
			{
				id: "composer-2",
				name: "Cursor Composer 2",
				reasoning: false,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 16384,
			},
			{
				id: "gpt-5.5@1m",
				name: "GPT-5.5 @ 1m",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1000000,
				maxTokens: 16384,
			},
		]);

		const pi = createMockPi();
		await extensionFactory(pi as unknown as ExtensionAPI);

		expect(pi.registerProvider).toHaveBeenCalledOnce();
		const [call] = pi._registered;
		expect(call.config.models).toHaveLength(2);
	});

	it("refreshes Cursor models through a live command without reload", async () => {
		const startupModels = [
			{
				id: "composer-2",
				name: "Cursor Composer 2",
				reasoning: false,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 16384,
			},
		];
		const refreshedModels = [
			{
				id: "gpt-5.5@1m",
				name: "GPT-5.5 @ 1m",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1000000,
				maxTokens: 16384,
			},
		];
		mockedDiscover.mockResolvedValueOnce(startupModels).mockResolvedValueOnce(refreshedModels);
		const pi = createMockPi();
		await extensionFactory(pi as unknown as ExtensionAPI);
		const notify = vi.fn();

		await pi._commands.get("cursor-refresh-models")!.handler("", {
			cwd: process.cwd(),
			hasUI: true,
			ui: { notify, setStatus: vi.fn() },
			sessionManager: { getBranch: vi.fn(() => []) },
		} as unknown as ExtensionContext);

		expect(mockedDiscover).toHaveBeenCalledTimes(2);
		expect(pi.registerProvider).toHaveBeenCalledTimes(2);
		expect(pi._registered[0].config.models).toBe(startupModels);
		expect(pi._registered[1].config.models).toBe(refreshedModels);
		expect(pi._registered[1].config.streamSimple).toBe(mockedStreamCursor);
		expect(notify).toHaveBeenCalledWith("Cursor model catalog refreshed with 1 model.", "info");
	});

	it("warns when live Cursor model refresh still uses fallback models", async () => {
		mockedDiscover
			.mockResolvedValueOnce([])
			.mockImplementationOnce(async (options: DiscoverOptions) => {
				options.onFallback({ reason: "missing-api-key", message: "missing key; using fallback models" });
				return [];
			});
		const pi = createMockPi();
		await extensionFactory(pi as unknown as ExtensionAPI);
		const notify = vi.fn();

		await pi._commands.get("cursor-refresh-models")!.handler("", {
			cwd: process.cwd(),
			hasUI: true,
			ui: { notify, setStatus: vi.fn() },
			sessionManager: { getBranch: vi.fn(() => []) },
		} as unknown as ExtensionContext);

		expect(pi.registerProvider).toHaveBeenCalledTimes(2);
		expect(notify).toHaveBeenCalledWith(
			"Cursor model catalog refresh still using fallback models: missing key; using fallback models",
			"warning",
		);
	});

	it("notifies interactive users when fallback models are registered", async () => {
		mockedDiscover.mockImplementationOnce(async (options: DiscoverOptions) => {
			options.onFallback({
				reason: "missing-api-key",
				message:
					"Cursor model discovery needs an API key from /login (Use an API key -> Cursor), CURSOR_API_KEY, or --api-key. Using fallback Cursor models so /login and model selection still work; fallback models can run once auth exists. After adding auth to an already-started pi session, run /cursor-refresh-models to refresh the full live Cursor model catalog without restarting pi.",
			});
			return [
				{
					id: "composer-2",
					name: "Cursor Composer 2",
					reasoning: false,
					input: ["text", "image"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 16384,
				},
			];
		});

		const pi = createMockPi();
		await extensionFactory(pi as unknown as ExtensionAPI);

		const notify = vi.fn();
		const ctx = {
			cwd: process.cwd(),
			hasUI: true,
			ui: { notify, setStatus: vi.fn() },
			sessionManager: { getBranch: vi.fn(() => []) },
		};
		const sessionHandlers = pi._handlers.get("session_start") ?? [];
		await sessionHandlers.at(-1)!({}, ctx);

		expect(notify).toHaveBeenCalledWith(
			"Cursor model discovery needs an API key from /login (Use an API key -> Cursor), CURSOR_API_KEY, or --api-key. Using fallback Cursor models so /login and model selection still work; fallback models can run once auth exists. After adding auth to an already-started pi session, run /cursor-refresh-models to refresh the full live Cursor model catalog without restarting pi.",
			"warning",
		);
	});

	it("does not notify fallback discovery issues without UI", async () => {
		mockedDiscover.mockImplementationOnce(async (options: DiscoverOptions) => {
			options.onFallback({ reason: "empty-model-list", message: "Cursor model discovery returned no models; using fallback Cursor model list." });
			return [];
		});

		const pi = createMockPi();
		await extensionFactory(pi as unknown as ExtensionAPI);

		const notify = vi.fn();
		const ctx = { cwd: process.cwd(), hasUI: false, ui: { notify, setStatus: vi.fn() }, sessionManager: { getBranch: vi.fn(() => []) } };
		const sessionHandlers = pi._handlers.get("session_start") ?? [];
		await sessionHandlers.at(-1)!({}, ctx);

		expect(notify).not.toHaveBeenCalled();
	});

	it("registers native Cursor tool wrappers with the pi session cwd", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		mockedDiscover.mockResolvedValueOnce([]);
		const dir = mkdtempSync(join(tmpdir(), "pi-cursor-native-cwd-"));
		try {
			writeFileSync(join(dir, "session-file.txt"), "from session cwd\n");
			const pi = createMockPi();
			await extensionFactory(pi as unknown as ExtensionAPI);
			await runSessionStartHandlers(pi, { cwd: dir });

			const readTool = pi._tools.find((tool) => tool.name === "read");
			const result = await readTool.execute("ordinary-read", { path: "session-file.txt" }, undefined, undefined, {});

			expect(result.content).toEqual([{ type: "text", text: "from session cwd\n" }]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("updates registered native Cursor tool wrappers to the latest pi session cwd", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		mockedDiscover.mockResolvedValueOnce([]);
		const firstDir = mkdtempSync(join(tmpdir(), "pi-cursor-native-cwd-first-"));
		const secondDir = mkdtempSync(join(tmpdir(), "pi-cursor-native-cwd-second-"));
		try {
			writeFileSync(join(firstDir, "session-file.txt"), "from first cwd\n");
			writeFileSync(join(secondDir, "session-file.txt"), "from second cwd\n");
			const pi = createMockPi();
			await extensionFactory(pi as unknown as ExtensionAPI);
			await runSessionStartHandlers(pi, { cwd: firstDir });
			await runSessionStartHandlers(pi, { cwd: secondDir });

			const readTool = pi._tools.find((tool) => tool.name === "read");
			const result = await readTool.execute("ordinary-read", { path: "session-file.txt" }, undefined, undefined, {});

			expect(pi.registerTool).toHaveBeenCalledTimes(11);
			expect(result.content).toEqual([{ type: "text", text: "from second cwd\n" }]);
		} finally {
			rmSync(firstDir, { recursive: true, force: true });
			rmSync(secondDir, { recursive: true, force: true });
		}
	});

	it("registered native Cursor tool wrappers return recorded Cursor results without executing built-ins", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		mockedDiscover.mockResolvedValueOnce([]);
		const pi = createMockPi();
		await extensionFactory(pi as unknown as ExtensionAPI);
		await runSessionStartHandlers(pi);

		recordCursorNativeToolDisplay({
			id: "cursor-tool-1",
			toolName: "read",
			args: { path: "README.md" },
			result: { content: [{ type: "text", text: "# pi-cursor-sdk" }] },
			isError: false,
		});

		const readTool = pi._tools.find((tool) => tool.name === "read");
		const result = await readTool.execute("cursor-tool-1", { path: "README.md" }, undefined, undefined, {});

		expect(result).toEqual({
			content: [{ type: "text", text: "# pi-cursor-sdk" }],
			details: undefined,
			terminate: true,
		});
	});

	it("does not register native Cursor tool wrappers when native display is disabled", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "0";
		mockedDiscover.mockResolvedValueOnce([]);
		const pi = createMockPi();
		await extensionFactory(pi as unknown as ExtensionAPI);
		await runSessionStartHandlers(pi);

		expect(pi.registerTool).not.toHaveBeenCalled();
		expect(canRenderCursorToolNatively("read")).toBe(false);
	});

	it("does not register native Cursor tool wrappers when native tool registration is disabled", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		process.env.PI_CURSOR_REGISTER_NATIVE_TOOLS = "0";
		mockedDiscover.mockResolvedValueOnce([]);
		const pi = createMockPi();
		await extensionFactory(pi as unknown as ExtensionAPI);
		await runSessionStartHandlers(pi);

		expect(pi.registerTool).not.toHaveBeenCalled();
		expect(canRenderCursorToolNatively("read")).toBe(false);
	});

	it("skips only native Cursor tool wrappers owned by another extension", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		mockedDiscover.mockResolvedValueOnce([]);
		const pi = createMockPi([
			{
				name: "read",
				description: "hashline read",
				parameters: Type.Object({}),
				sourceInfo: {
					source: "package",
					path: "/opt/homebrew/lib/node_modules/pi-hashline-edit/index.ts",
					scope: "user",
					origin: "package",
				},
			},
			createBuiltinToolInfo("bash"),
			createBuiltinToolInfo("ls"),
		]);
		await extensionFactory(pi as unknown as ExtensionAPI);
		await runSessionStartHandlers(pi);

		expect(pi._tools.map((tool) => tool.name)).toEqual([
			"bash",
			"ls",
			"grep",
			"find",
			"cursor_edit",
			"cursor_write",
			"cursor_delete",
			"cursor_read_lints",
			"cursor_mcp",
			"cursor_tool",
		]);
		expect(canRenderCursorToolNatively("read")).toBe(false);
		expect(canRenderCursorToolNatively("bash")).toBe(true);
		expect(canRenderCursorToolNatively("cursor_edit")).toBe(true);
		expect(canRenderCursorToolNatively("ls")).toBe(true);
	});
});
