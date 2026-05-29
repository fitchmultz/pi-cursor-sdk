import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	createExtensionCommandContext,
	createExtensionTestContext,
	makeHarnessModel,
	makeModel,
	makeProviderModelConfig,
} from "./helpers/pi-harness.js";
import {
	createExtensionPi,
	resetIndexExtensionTestState,
	cursorPiToolBridgeTestUtils,
} from "./helpers/index-extension-test-kit.js";

vi.mock("../src/model-discovery.js", () => ({
	discoverModels: vi.fn(),
	getCursorModelMetadata: vi.fn(),
}));

vi.mock("../src/cursor-provider.js", () => ({
	streamCursor: vi.fn(),
}));

import extensionFactory from "../src/index.js";
import { discoverModels } from "../src/model-discovery.js";
import { streamCursor } from "../src/cursor-provider.js";
import { buildCursorPiToolBridgeSnapshot } from "../src/cursor-pi-tool-bridge.js";
import { CURSOR_ASK_QUESTION_TOOL_NAME } from "../src/cursor-question-tool.js";

const mockedDiscover = vi.mocked(discoverModels);
const mockedStreamCursor = vi.mocked(streamCursor);

type DiscoverOptions = Parameters<typeof discoverModels>[0];

describe("extension registration and discovery", () => {
	beforeEach(resetIndexExtensionTestState);

	it("registers Cursor runtime controls and one provider with correct fields", async () => {
		const mockModels = [makeProviderModelConfig("composer-2", { name: "Cursor Composer 2" })];
		mockedDiscover.mockResolvedValueOnce(mockModels);

		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const pi = createExtensionPi();
		await extensionFactory(pi);
		await pi.runSessionStart();

		expect(pi.registerFlag).toHaveBeenCalledWith(
			"cursor-fast",
			expect.objectContaining({ type: "boolean", default: false }),
		);
		expect(pi.registerFlag).toHaveBeenCalledWith(
			"cursor-no-fast",
			expect.objectContaining({ type: "boolean", default: false }),
		);
		expect(pi.registerFlag).toHaveBeenCalledWith(
			"cursor-mode",
			expect.objectContaining({ type: "string", default: "" }),
		);
		expect(pi.registerCommand).toHaveBeenCalledWith(
			"cursor-fast",
			expect.objectContaining({ description: expect.stringContaining("Toggle Cursor fast") }),
		);
		expect(pi.registerCommand).toHaveBeenCalledWith(
			"cursor-mode",
			expect.objectContaining({ description: expect.stringContaining("Set Cursor SDK conversation mode") }),
		);
		expect(pi.registerCommand).toHaveBeenCalledWith(
			"cursor-tools",
			expect.objectContaining({ description: expect.stringContaining("Show live Cursor tool surfaces") }),
		);
		expect(pi.registerCommand).toHaveBeenCalledWith(
			"cursor-refresh-models",
			expect.objectContaining({ description: expect.stringContaining("Refresh the live Cursor model catalog") }),
		);
		expect(pi.registerTool).toHaveBeenCalledTimes(22);
		expect(pi._tools.map((tool) => tool.name)).toEqual([
			CURSOR_ASK_QUESTION_TOOL_NAME,
			"grep",
			"find",
			"ls",
			"cursor",
			"cursor_edit",
			"cursor_write",
			"cursor_delete",
			"cursor_read_lints",
			"cursor_update_todos",
			"cursor_create_plan",
			"cursor_task",
			"cursor_generate_image",
			"cursor_mcp",
			"cursor_sem_search",
			"cursor_record_screen",
			"cursor_web_search",
			"cursor_web_fetch",
			"read",
			"bash",
			"edit",
			"write",
		]);
		expect(pi.setActiveTools).toHaveBeenCalledWith([
			"read",
			"bash",
			"edit",
			"write",
			"grep",
			"find",
			"ls",
			"cursor",
			CURSOR_ASK_QUESTION_TOOL_NAME,
		]);
		expect(pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
		expect(pi.on).toHaveBeenCalledWith("before_agent_start", expect.any(Function));
		expect(pi.on).toHaveBeenCalledWith("turn_start", expect.any(Function));
		expect(pi.on).toHaveBeenCalledWith("model_select", expect.any(Function));
		expect(mockedDiscover).toHaveBeenCalledOnce();
		expect(pi.registerProvider).toHaveBeenCalledOnce();

		const [call] = pi._registered;
		expect(call.name).toBe("cursor");
		expect(call.config.name).toBe("Cursor");
		expect(call.config.apiKey).toBe("pi-cursor-sdk-cursor-api-key-placeholder");
		expect(call.config.api).toBe("cursor-sdk");
		expect(call.config.models).toBe(mockModels);
		expect(call.config.streamSimple).toBe(mockedStreamCursor);
	});

	it("keeps legacy Cursor replay-only tools out of active tools", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		mockedDiscover.mockResolvedValueOnce([]);
		const pi = createExtensionPi();
		await extensionFactory(pi);
		await pi.runSessionStart();

		expect(pi._activeToolNames()).toContain("cursor");
		expect(pi._activeToolNames()).toContain(CURSOR_ASK_QUESTION_TOOL_NAME);
		expect(pi._activeToolNames()).not.toContain("cursor_edit");

		await pi.runModelSelect(makeHarnessModel("openai-codex", "openai-codex-responses", "gpt-5.5"));
		expect(pi._activeToolNames()).not.toContain("cursor_edit");
		expect(pi._activeToolNames()).not.toContain("cursor_generate_image");
		expect(pi._activeToolNames()).not.toContain("cursor");
		expect(pi._activeToolNames()).not.toContain(CURSOR_ASK_QUESTION_TOOL_NAME);
		expect(pi._activeToolNames()).not.toContain("grep");
		expect(pi._activeToolNames()).not.toContain("find");
		expect(pi._activeToolNames()).toContain("read");

		await pi.runModelSelect(makeModel("composer-2.5"));
		expect(pi._activeToolNames()).toContain("cursor");
		expect(pi._activeToolNames()).toContain(CURSOR_ASK_QUESTION_TOOL_NAME);
		expect(pi._activeToolNames()).not.toContain("cursor_edit");
		expect(pi._activeToolNames()).not.toContain("cursor_generate_image");
	});

	it("registers and resyncs Cursor-only tools before a turn when session startup did not know the model", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		mockedDiscover.mockResolvedValueOnce([]);
		const pi = createExtensionPi();
		await extensionFactory(pi);
		await pi.runSessionStart({ model: undefined });

		expect(pi._tools.map((tool) => tool.name)).toEqual([CURSOR_ASK_QUESTION_TOOL_NAME]);
		expect(pi._activeToolNames()).not.toContain("cursor");
		expect(pi._activeToolNames()).not.toContain("grep");
		expect(pi._activeToolNames()).not.toContain(CURSOR_ASK_QUESTION_TOOL_NAME);

		await pi.runBeforeAgentStart({ model: makeModel("composer-2.5") });

		expect(pi._tools.map((tool) => tool.name)).toContain("cursor");
		expect(pi._tools.map((tool) => tool.name)).toContain("grep");
		expect(pi._activeToolNames()).toContain("cursor");
		expect(pi._activeToolNames()).toContain("grep");
		expect(pi._activeToolNames()).toContain(CURSOR_ASK_QUESTION_TOOL_NAME);
		expect(buildCursorPiToolBridgeSnapshot(pi).piToolNameToMcpToolName.get(CURSOR_ASK_QUESTION_TOOL_NAME)).toBe("pi__cursor_ask_question");

		pi.setActiveTools(["read", "bash", "edit", "write"]);
		expect(pi._activeToolNames()).not.toContain("cursor");
		expect(pi._activeToolNames()).not.toContain("grep");
		expect(pi._activeToolNames()).not.toContain(CURSOR_ASK_QUESTION_TOOL_NAME);

		await pi.runTurnStart({ model: makeModel("composer-2.5") });

		expect(pi._activeToolNames()).toContain("cursor");
		expect(pi._activeToolNames()).toContain("grep");
		expect(pi._activeToolNames()).toContain(CURSOR_ASK_QUESTION_TOOL_NAME);
	});

	it("asks Cursor questions through pi UI selection", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "0";
		mockedDiscover.mockResolvedValueOnce([]);
		const pi = createExtensionPi();
		await extensionFactory(pi);
		await pi.runSessionStart();

		const select = vi.fn().mockResolvedValue("Web app");
		const input = vi.fn();
		const tool = pi._tools.find((candidate) => candidate.name === CURSOR_ASK_QUESTION_TOOL_NAME);
		const result = await tool!.execute(
			"question-1",
			{
				question: "What kind of calculator should Cursor plan?",
				options: [
					{ label: "Web app", value: "web" },
					{ label: "CLI", value: "cli" },
				],
				allowCustom: false,
			},
			undefined,
			undefined,
			createExtensionTestContext({ ui: { notify: vi.fn(), setStatus: vi.fn(), select, input } }) as never,
		);

		expect(select).toHaveBeenCalledWith("What kind of calculator should Cursor plan?", ["Web app", "CLI"]);
		expect(input).not.toHaveBeenCalled();
		expect(result.content).toEqual([{ type: "text", text: "User answered: Web app" }]);
		expect(result.details).toMatchObject({
			uiAvailable: true,
			cancelled: false,
			answers: [{ id: "question_1", answer: "Web app", value: "web", cancelled: false }],
		});
	});

	it("registers Cursor pi tool bridge state and activates the Cursor question tool", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "0";
		mockedDiscover.mockResolvedValueOnce([]);
		const pi = createExtensionPi();

		await extensionFactory(pi);
		await pi.runSessionStart();

		expect(cursorPiToolBridgeTestUtils.getRegisteredBridgeForTests()?.isEnabled()).toBe(true);
		expect(pi.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
		expect(pi._activeToolNames()).toContain(CURSOR_ASK_QUESTION_TOOL_NAME);

		const snapshot = buildCursorPiToolBridgeSnapshot(pi);
		expect(snapshot.piToolNameToMcpToolName.get(CURSOR_ASK_QUESTION_TOOL_NAME)).toBe("pi__cursor_ask_question");
		expect(snapshot.tools.find((tool) => tool.piToolName === CURSOR_ASK_QUESTION_TOOL_NAME)?.description).toContain("Ask the user");
	});

	it("honors PI_CURSOR_PI_TOOL_BRIDGE=0 at the extension registration path", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "0";
		process.env.PI_CURSOR_PI_TOOL_BRIDGE = "0";
		mockedDiscover.mockResolvedValueOnce([]);
		const pi = createExtensionPi();

		await extensionFactory(pi);
		await pi.runSessionStart();

		expect(cursorPiToolBridgeTestUtils.getRegisteredBridgeForTests()?.isEnabled()).toBe(false);
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});

	it("registers provider even with fallback models", async () => {
		mockedDiscover.mockResolvedValueOnce([
			makeProviderModelConfig("composer-2", { name: "Cursor Composer 2" }),
			makeProviderModelConfig("gpt-5.5@1m", {
				name: "GPT-5.5 @ 1m",
				reasoning: true,
				contextWindow: 1_000_000,
			}),
		]);

		const pi = createExtensionPi();
		await extensionFactory(pi);

		expect(pi.registerProvider).toHaveBeenCalledOnce();
		const [call] = pi._registered;
		expect(call.config.models).toHaveLength(2);
	});

	it("refreshes Cursor models through a live command without reload", async () => {
		const startupModels = [makeProviderModelConfig("composer-2", { name: "Cursor Composer 2" })];
		const refreshedModels = [
			makeProviderModelConfig("gpt-5.5@1m", {
				name: "GPT-5.5 @ 1m",
				reasoning: true,
				contextWindow: 1_000_000,
			}),
		];
		mockedDiscover.mockResolvedValueOnce(startupModels).mockResolvedValueOnce(refreshedModels);
		const pi = createExtensionPi();
		await extensionFactory(pi);
		const notify = vi.fn();

		await pi.runCommand(
			"cursor-refresh-models",
			"",
			createExtensionCommandContext({
				hasUI: true,
				model: undefined,
				ui: { notify },
			}),
		);

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
				options?.onFallback?.({ reason: "missing-api-key", message: "missing key; using fallback models" });
				return [];
			});
		const pi = createExtensionPi();
		await extensionFactory(pi);
		const notify = vi.fn();

		await pi.runCommand(
			"cursor-refresh-models",
			"",
			createExtensionCommandContext({
				hasUI: true,
				model: undefined,
				ui: { notify },
			}),
		);

		expect(pi.registerProvider).toHaveBeenCalledTimes(2);
		expect(notify).toHaveBeenCalledWith(
			"Cursor model catalog refresh still using fallback models: missing key; using fallback models",
			"warning",
		);
	});

	it("notifies interactive users when fallback models are registered", async () => {
		mockedDiscover.mockImplementationOnce(async (options: DiscoverOptions) => {
			options?.onFallback?.({
				reason: "missing-api-key",
				message:
					"Cursor model discovery needs an API key from /login (Use an API key -> Cursor), CURSOR_API_KEY, or --api-key with a Cursor SDK API key; Cursor Agent CLI/Desktop login is not reused. Using fallback Cursor models so /login and model selection still work; fallback models can run once auth exists. After adding auth to an already-started pi session, run /cursor-refresh-models to refresh the full live Cursor model catalog without restarting pi.",
			});
			return [makeProviderModelConfig("composer-2", { name: "Cursor Composer 2" })];
		});

		const pi = createExtensionPi();
		await extensionFactory(pi);

		const notify = vi.fn();
		await pi.runSessionStart({
			hasUI: true,
			ui: { notify, setStatus: vi.fn() },
			sessionManager: { getBranch: vi.fn(() => []) },
		});

		expect(notify).toHaveBeenCalledWith(
			"Cursor model discovery needs an API key from /login (Use an API key -> Cursor), CURSOR_API_KEY, or --api-key with a Cursor SDK API key; Cursor Agent CLI/Desktop login is not reused. Using fallback Cursor models so /login and model selection still work; fallback models can run once auth exists. After adding auth to an already-started pi session, run /cursor-refresh-models to refresh the full live Cursor model catalog without restarting pi.",
			"warning",
		);
	});

	it("does not notify fallback discovery issues without UI", async () => {
		mockedDiscover.mockImplementationOnce(async (options: DiscoverOptions) => {
			options?.onFallback?.({
				reason: "empty-model-list",
				message: "Cursor model discovery returned no models; using fallback Cursor model list.",
			});
			return [];
		});

		const pi = createExtensionPi();
		await extensionFactory(pi);

		const notify = vi.fn();
		await pi.runSessionStart({
			hasUI: false,
			ui: { notify, setStatus: vi.fn() },
			sessionManager: { getBranch: vi.fn(() => []) },
		});

		expect(notify).not.toHaveBeenCalled();
	});
});
