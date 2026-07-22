import { describe, it, expect, vi, beforeEach } from "vitest";
import { Type } from "typebox";
import {
	resetCursorProviderTestState,
	mockedCreate,
	mockedResume,
	createPiHarness,
	mockedCreateAgentPlatform,
	makeModel,
	makeContext,
	makeAssistantMessage,
	collectEvents,
	getErrorEvent,
	getTextEndEvent,
	mockCreatedAgent,
	mockedMessagesList,
	asMockSdkAgent,
	createMockAgentPlatform,
	registerBridgeForProviderTest,
	createTestToolInfo,
} from "./helpers/cursor-provider-harness.js";
import { streamCursor } from "../src/cursor-provider.js";
import { cursorLiveRuns } from "../src/cursor-provider-live-run-drain.js";
import { CLOUD_LIFECYCLE_ENTRY_TYPE, registerCursorCloudLifecycleLedger } from "../src/cursor-cloud-lifecycle.js";
import { registerCursorRuntimeControls } from "../src/cursor-state.js";
import { __testUtils as contextWindowCacheTestUtils } from "../src/context-window-cache.js";
import { __testUtils as modelDiscoveryTestUtils } from "../src/model-discovery.js";
import { __testUtils as cursorSessionScopeTestUtils } from "../src/cursor-session-scope.js";
import type { Context } from "@earendil-works/pi-ai/compat";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

async function setCursorModeForProviderTest(mode: "agent" | "plan"): Promise<void> {
	const pi = createPiHarness({ flagValues: { "cursor-mode": mode } });
	registerCursorRuntimeControls(pi);
	await pi.runSessionStart({ model: makeModel("gpt-5.5@1m") });
}

describe("streamCursor prompt and model config", () => {
	beforeEach(resetCursorProviderTestState);

	it("leaves local safety controls off by default", async () => {
		mockCreatedAgent({
			send: vi.fn().mockResolvedValue({
				id: "run-1",
				agentId: "agent-1",
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
				cancel: vi.fn(),
				supports: () => true,
				unsupportedReason: () => undefined,
			}),
		});

		await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), { apiKey: "test-key" }));

		expect(mockedCreate.mock.calls[0][0].local).toMatchObject({
			cwd: process.cwd(),
			settingSources: ["all"],
			store: expect.any(Object),
		});
	});

	it("sets absolute CURSOR_RIPGREP_PATH before local Agent.create", async () => {
		delete process.env.CURSOR_RIPGREP_PATH;
		let pathAtCreate: string | undefined;
		mockedCreate.mockImplementation(async () => {
			pathAtCreate = process.env.CURSOR_RIPGREP_PATH;
			return asMockSdkAgent({
				send: vi.fn().mockResolvedValue({
					id: "run-1",
					agentId: "agent-1",
					status: "finished",
					wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
					cancel: vi.fn(),
					supports: () => true,
					unsupportedReason: () => undefined,
				}),
			});
		});

		await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), { apiKey: "test-key" }));

		expect(mockedCreate).toHaveBeenCalledTimes(1);
		expect(pathAtCreate).toBeTruthy();
		expect(isAbsolute(pathAtCreate!)).toBe(true);
		expect(pathAtCreate!.replaceAll("\\", "/")).toContain(`@cursor/sdk-${process.platform}-${process.arch}`);
	});

	it("passes enabled local safety controls from env into Agent.create", async () => {
		process.env.PI_CURSOR_AUTO_REVIEW = "1";
		process.env.PI_CURSOR_SANDBOX = "true";
		mockCreatedAgent({
			send: vi.fn().mockResolvedValue({
				id: "run-1",
				agentId: "agent-1",
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
				cancel: vi.fn(),
				supports: () => true,
				unsupportedReason: () => undefined,
			}),
		});

		await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), { apiKey: "test-key" }));

		expect(mockedCreate.mock.calls[0][0].local).toMatchObject({ autoReview: true, sandboxOptions: { enabled: true } });
	});

	it("passes trusted project local safety config into Agent.create", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-cursor-local-safety-"));
		const cwd = join(root, "repo");
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), "{}\n");
		writeFileSync(join(cwd, ".pi", "cursor-sdk.json"), JSON.stringify({ local: { autoReview: true, sandboxOptions: { enabled: true } } }));
		cursorSessionScopeTestUtils.set(cwd, "/tmp/session-local-safety.jsonl", "test-session", true);
		mockCreatedAgent({
			send: vi.fn().mockResolvedValue({
				id: "run-1",
				agentId: "agent-1",
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
				cancel: vi.fn(),
				supports: () => true,
				unsupportedReason: () => undefined,
			}),
		});

		try {
			await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), { apiKey: "test-key" }));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}

		expect(mockedCreate.mock.calls[0][0].local).toMatchObject({ cwd, autoReview: true, sandboxOptions: { enabled: true } });
	});

	it("lets CLI local safety flags override disabled env/config", async () => {
		process.env.PI_CURSOR_AUTO_REVIEW = "0";
		process.env.PI_CURSOR_SANDBOX = "0";
		const pi = createPiHarness({ flagValues: { "cursor-auto-review": true, "cursor-sandbox": true } });
		registerCursorRuntimeControls(pi);
		await pi.runSessionStart({ model: makeModel("gpt-5.5@1m") });
		mockCreatedAgent({
			send: vi.fn().mockResolvedValue({
				id: "run-1",
				agentId: "agent-1",
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
				cancel: vi.fn(),
				supports: () => true,
				unsupportedReason: () => undefined,
			}),
		});

		await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), { apiKey: "test-key" }));

		expect(mockedCreate.mock.calls[0][0].local).toMatchObject({ autoReview: true, sandboxOptions: { enabled: true } });
	});

	it.each([
		["cursor-runtime", "remote", 'Invalid --cursor-runtime "remote". Use "local" or "cloud".'],
		["cursor-cloud-context", "reuse", 'Invalid --cursor-cloud-context "reuse". Use "never", "fresh", or "bootstrap".'],
	])("fails before SDK agent calls for invalid --%s", async (flag, value, expectedError) => {
		const mockSend = vi.fn();
		mockCreatedAgent({ send: mockSend });
		const pi = createPiHarness({ flagValues: { [flag]: value } });
		registerCursorRuntimeControls(pi);
		await pi.runSessionStart({ model: makeModel("gpt-5.5@1m") });

		const events = await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), { apiKey: "test-key" }));

		expect(getErrorEvent(events).error.errorMessage).toContain(expectedError);
		expect(mockedCreate).not.toHaveBeenCalled();
		expect(mockedResume).not.toHaveBeenCalled();
		expect(mockSend).not.toHaveBeenCalled();
	});

	it.each([
		["PI_CURSOR_RUNTIME", "remote", 'Invalid PI_CURSOR_RUNTIME "remote". Use "local" or "cloud".'],
		["PI_CURSOR_CLOUD_CONTEXT", "reuse", 'Invalid PI_CURSOR_CLOUD_CONTEXT "reuse". Use "never", "fresh", or "bootstrap".'],
	])("fails before SDK agent calls for invalid %s", async (envName, value, expectedError) => {
		const mockSend = vi.fn();
		mockCreatedAgent({ send: mockSend });
		process.env[envName] = value;

		const events = await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), { apiKey: "test-key" }));

		expect(getErrorEvent(events).error.errorMessage).toContain(expectedError);
		expect(mockedCreate).not.toHaveBeenCalled();
		expect(mockedResume).not.toHaveBeenCalled();
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("fails closed with cloud preflight remediation before cloud agent creation", async () => {
		process.env.PI_CURSOR_RUNTIME = "cloud";
		process.env.PI_CURSOR_LOCAL_FORCE = "1";

		const events = await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), { apiKey: "test-key" }));

		expect(getErrorEvent(events).error.errorMessage).toContain("Cursor cloud runtime is not ready to start");
		expect(getErrorEvent(events).error.errorMessage).toContain("--cursor-cloud-ack");
		expect(getErrorEvent(events).error.errorMessage).not.toContain("--cursor-cloud-repo");
		expect(mockedCreate).not.toHaveBeenCalled();
	});

	it("starts explicit cloud runs without local tools or prior context by default", async () => {
		process.env.PI_CURSOR_RUNTIME = "cloud";
		process.env.PI_CURSOR_CLOUD_ALLOW_LOCAL_STATE = "1";
		process.env.PI_CURSOR_CLOUD_ACK = "1";
		process.env.PI_CURSOR_LOCAL_FORCE = "1";
		const mockSend = vi.fn().mockResolvedValue({
			id: "run-1",
			agentId: "bc-00000000-0000-0000-0000-000000000001",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "cloud done" }),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		});
		mockCreatedAgent({ agentId: "bc-00000000-0000-0000-0000-000000000001", send: mockSend });
		const context: Context = {
			systemPrompt: "Keep this Pi project instruction.",
			messages: [
				{ role: "user", content: "old local context", timestamp: 1 },
				makeAssistantMessage("old assistant context"),
				{ role: "user", content: "fresh cloud request", timestamp: 3 },
			],
		};

		const events = await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), context, { apiKey: "test-key" }));

		expect(getTextEndEvent(events).content).toBe("cloud done");
		expect(mockedCreate.mock.calls[0][0]).toMatchObject({
			apiKey: "test-key",
			cloud: {},
			mode: "agent",
		});
		expect(mockedCreate.mock.calls[0][0]).not.toHaveProperty("local");
		expect(mockedCreate.mock.calls[0][0]).not.toHaveProperty("mcpServers");
		expect(mockSend.mock.calls[0]?.[1]).toMatchObject({ mode: "agent" });
		expect(mockSend.mock.calls[0]?.[1]).not.toHaveProperty("local");
		expect(mockSend.mock.calls[0]?.[1]).not.toHaveProperty("cloud");
		expect(mockSend.mock.calls[0]?.[1]).not.toHaveProperty("mcpServers");
		expect(mockedMessagesList).not.toHaveBeenCalled();
		const sentMessage = mockSend.mock.calls[0]?.[0] as { text: string };
		expect(sentMessage.text).toContain("Keep this Pi project instruction.");
		expect(sentMessage.text).toContain("fresh cloud request");
		expect(sentMessage.text).not.toContain("old local context");
		expect(sentMessage.text).not.toContain("old assistant context");
	});

	it("passes explicit Cursor-managed cloud environment selection into Agent.create", async () => {
		process.env.PI_CURSOR_RUNTIME = "cloud";
		process.env.PI_CURSOR_CLOUD_ALLOW_LOCAL_STATE = "1";
		process.env.PI_CURSOR_CLOUD_ACK = "1";
		process.env.PI_CURSOR_CLOUD_ENV_TYPE = "machine";
		process.env.PI_CURSOR_CLOUD_ENV_NAME = "large-runner";
		process.env.PI_CURSOR_CLOUD_AUTO_CREATE_PR = "1";
		process.env.PI_CURSOR_CLOUD_SKIP_REVIEWER_REQUEST = "1";
		mockCreatedAgent({
			agentId: "bc-00000000-0000-0000-0000-000000000001",
			send: vi.fn().mockResolvedValue({
				id: "run-1",
				agentId: "bc-00000000-0000-0000-0000-000000000001",
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "cloud done" }),
				cancel: vi.fn(),
				supports: () => true,
				unsupportedReason: () => undefined,
			}),
		});

		await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), { apiKey: "test-key" }));

		expect(mockedCreate.mock.calls[0][0]).toMatchObject({
			cloud: {
				env: { type: "machine", name: "large-runner" },
				autoCreatePR: true,
				skipReviewerRequest: true,
			},
		});
	});

	it("passes CLI cloud environment selection into Agent.create", async () => {
		const pi = createPiHarness({
			flagValues: {
				"cursor-runtime": "cloud",
				"cursor-cloud-allow-local-state": true,
				"cursor-cloud-ack": true,
				"cursor-cloud-env-type": "pool",
				"cursor-cloud-env-name": "gpu-pool",
				"cursor-cloud-auto-create-pr": true,
				"cursor-cloud-skip-reviewer-request": true,
			},
		});
		registerCursorRuntimeControls(pi);
		await pi.runSessionStart({ model: makeModel("gpt-5.5@1m") });
		mockCreatedAgent({
			agentId: "bc-00000000-0000-0000-0000-000000000001",
			send: vi.fn().mockResolvedValue({
				id: "run-1",
				agentId: "bc-00000000-0000-0000-0000-000000000001",
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "cloud done" }),
				cancel: vi.fn(),
				supports: () => true,
				unsupportedReason: () => undefined,
			}),
		});

		await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), { apiKey: "test-key" }));

		expect(mockedCreate.mock.calls[0][0]).toMatchObject({
			cloud: {
				env: { type: "pool", name: "gpu-pool" },
				autoCreatePR: true,
				skipReviewerRequest: true,
			},
		});
	});

	it("names cloud agents from the normalized current pi session", async () => {
		process.env.PI_CURSOR_RUNTIME = "cloud";
		process.env.PI_CURSOR_CLOUD_ALLOW_LOCAL_STATE = "1";
		process.env.PI_CURSOR_CLOUD_ACK = "1";
		cursorSessionScopeTestUtils.set(process.cwd(), "/tmp/session-cloud-name.jsonl", "test-session", true, "  Cloud\tstatus\u001b slice\0  ");
		mockCreatedAgent({
			agentId: "bc-00000000-0000-0000-0000-000000000001",
			send: vi.fn().mockResolvedValue({
				id: "run-1",
				agentId: "bc-00000000-0000-0000-0000-000000000001",
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "cloud done" }),
				cancel: vi.fn(),
				supports: () => true,
				unsupportedReason: () => undefined,
			}),
		});

		await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), { apiKey: "test-key" }));

		expect(mockedCreate.mock.calls[0][0]).toMatchObject({ name: "Cloud status slice" });
	});

	it("does not drain a pending local live run before cloud preflight", async () => {
		process.env.PI_CURSOR_RUNTIME = "cloud";
		process.env.PI_CURSOR_CLOUD_ALLOW_LOCAL_STATE = "1";
		process.env.PI_CURSOR_CLOUD_ACK = "1";
		const resolveToolResults = vi.fn().mockResolvedValue(undefined);
		const liveRun = cursorLiveRuns.start({
			id: "cursor-replay-cloud-boundary",
			agent: asMockSdkAgent({ agentId: "local-agent", send: vi.fn() }),
			bridgeRun: {
				hasPendingPiToolCallId: () => false,
				resolveToolResults,
				cancel: vi.fn(),
			} as any,
			promptInputTokens: 0,
		});
		cursorLiveRuns.markFinished(liveRun, "local live result");

		try {
			const events = await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), { apiKey: "test-key" }));

			expect(getErrorEvent(events).error.errorMessage).toContain("local Cursor live run is pending");
			expect(resolveToolResults).not.toHaveBeenCalled();
			expect(mockedCreate).not.toHaveBeenCalled();
		} finally {
			await cursorLiveRuns.release(liveRun);
		}
	});

	it("disposes a cloud agent if the turn aborts after Agent.create but before send", async () => {
		process.env.PI_CURSOR_RUNTIME = "cloud";
		process.env.PI_CURSOR_CLOUD_ALLOW_LOCAL_STATE = "1";
		process.env.PI_CURSOR_CLOUD_ACK = "1";
		const abortController = new AbortController();
		const lifecyclePi = createPiHarness();
		registerCursorCloudLifecycleLedger(lifecyclePi);
		const mockDispose = vi.fn().mockResolvedValue(undefined);
		const mockSend = vi.fn();
		mockedCreate.mockImplementation(async () => {
			abortController.abort();
			return asMockSdkAgent({ agentId: "bc-00000000-0000-0000-0000-000000000001", send: mockSend, [Symbol.asyncDispose]: mockDispose });
		});

		await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), { apiKey: "test-key", signal: abortController.signal }));

		expect(mockSend).not.toHaveBeenCalled();
		expect(lifecyclePi.appendEntry).toHaveBeenCalledWith(CLOUD_LIFECYCLE_ENTRY_TYPE, expect.objectContaining({
			action: "record",
			agentId: "bc-00000000-0000-0000-0000-000000000001",
		}));
		expect(mockDispose).toHaveBeenCalledTimes(1);
	});

	it("budgets oversized prompt history before Cursor Agent.send", async () => {
		const mockSend = vi.fn().mockResolvedValue({
			id: "run-1",
			agentId: "agent-1",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		});
		mockCreatedAgent({
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});
		const context: Context = {
			systemPrompt: "Keep this system prompt.",
			messages: [
				{ role: "user", content: `old request ${"x".repeat(1200)}`, timestamp: 1 },
				{ role: "user", content: "latest request must remain", timestamp: 2 },
			],
		};
		const smallModel = { ...makeModel("gpt-5.5@1m"), contextWindow: 250, maxTokens: 50 };

		const stream = streamCursor(smallModel, context, { apiKey: "test-key" });
		await collectEvents(stream);

		const sentMessage = mockSend.mock.calls[0]?.[0] as { text: string };
		expect(sentMessage.text).toContain("Keep this system prompt.");
		expect(sentMessage.text).toContain("latest request must remain");
		expect(sentMessage.text).toContain("Earlier transcript omitted");
		expect(sentMessage.text).not.toContain("old request");
	});

	it("reserves image tokens when budgeting oversized prompt history", async () => {
		const mockSend = vi.fn().mockResolvedValue({
			id: "run-1",
			agentId: "agent-1",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		});
		mockCreatedAgent({
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});
		const context: Context = {
			systemPrompt: "Keep image prompt compact.",
			messages: [
				{ role: "user", content: `old request ${"x".repeat(1200)}`, timestamp: 1 },
				{
					role: "user",
					content: [
						{ type: "text", text: "latest image request" },
						{ type: "image", data: "base64-image", mimeType: "image/png" },
					],
					timestamp: 2,
				},
			],
		};
		const smallModel = { ...makeModel("gpt-5.5@1m"), contextWindow: 250, maxTokens: 50 };

		const stream = streamCursor(smallModel, context, { apiKey: "test-key" });
		await collectEvents(stream);

		const sentMessage = mockSend.mock.calls[0]?.[0] as { text: string; images?: unknown[] };
		expect(sentMessage.text).toContain("latest image request");
		expect(sentMessage.text).toContain("Earlier transcript omitted");
		expect(sentMessage.text).not.toContain("old request");
		expect(sentMessage.images).toEqual([{ data: "base64-image", mimeType: "image/png" }]);
	});

	it("does not advertise pi bridge calls in Agent.send prompt when context tools are empty", async () => {
		const mockSend = vi.fn().mockResolvedValue({
			id: "run-1",
			agentId: "agent-1",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		});
		mockCreatedAgent({
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});
		const previousManifest = process.env.PI_CURSOR_TOOL_MANIFEST;
		delete process.env.PI_CURSOR_TOOL_MANIFEST;
		const context = makeContext([{ role: "user", content: "return code only", timestamp: 1 }]);
		context.tools = [];

		try {
			await collectEvents(streamCursor(makeModel("gpt-5.5@272k"), context, { apiKey: "test-key", reasoning: "medium" }));
		} finally {
			if (previousManifest === undefined) delete process.env.PI_CURSOR_TOOL_MANIFEST;
			else process.env.PI_CURSOR_TOOL_MANIFEST = previousManifest;
		}

		const sentMessage = mockSend.mock.calls[0]?.[0] as { text: string };
		expect(sentMessage.text).toContain("Cursor SDK tool boundary:");
		expect(sentMessage.text).toContain("Call only Cursor SDK/MCP tools exposed in this run");
		expect(sentMessage.text).toContain("Callable tool surfaces this run:");
		expect(sentMessage.text).toContain("Cursor host/MCP");
		expect(sentMessage.text).not.toContain("Bridged pi tools:");
		expect(sentMessage.text).not.toContain("Pi bridge");
		expect(sentMessage.text).not.toContain("Use pi__cursor_ask_question");
		expect(sentMessage.text).not.toContain("prefer pi__mcp");
	});

	it("keeps pi bridge prompt guidance when the actual bridge exposes tools even if context tools are empty", async () => {
		const previousManifest = process.env.PI_CURSOR_TOOL_MANIFEST;
		delete process.env.PI_CURSOR_TOOL_MANIFEST;
		registerBridgeForProviderTest({
			active: ["sem_reindex"],
			tools: [createTestToolInfo("sem_reindex", Type.Object({ target: Type.String() }), "Reindex semantic cache")],
		});
		const mockSend = vi.fn().mockResolvedValue({
			id: "run-1",
			agentId: "agent-1",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		});
		mockCreatedAgent({
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});
		const context = makeContext([{ role: "user", content: "use bridge if needed", timestamp: 1 }]);
		context.tools = [];

		try {
			await collectEvents(streamCursor(makeModel("gpt-5.5@272k"), context, { apiKey: "test-key", reasoning: "medium" }));
		} finally {
			if (previousManifest === undefined) delete process.env.PI_CURSOR_TOOL_MANIFEST;
			else process.env.PI_CURSOR_TOOL_MANIFEST = previousManifest;
		}

		const sentMessage = mockSend.mock.calls[0]?.[0] as { text: string };
		expect(sentMessage.text).toContain("For exposed pi bridge tools");
		expect(sentMessage.text).not.toContain("Use pi__cursor_ask_question");
		expect(sentMessage.text).toContain("Pi bridge: call exposed pi__* MCP names");
		expect(sentMessage.text).toContain("prefer pi__mcp for MCP work and pi__subagent for delegation");
		expect(sentMessage.text).toContain("pi__sem_reindex");
	});

	it("forwards latest user images to Cursor Agent.send", async () => {
		const mockSend = vi.fn().mockResolvedValue({
			id: "run-1",
			agentId: "agent-1",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		});
		mockCreatedAgent({
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});
		const context: Context = {
			systemPrompt: "Be helpful.",
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "Describe this image" },
						{ type: "image", data: "base64-image", mimeType: "image/png" },
					],
					timestamp: 1,
				},
			],
		};

		const stream = streamCursor(makeModel("gpt-5.5@1m"), context, { apiKey: "test-key" });
		await collectEvents(stream);

		expect(mockSend).toHaveBeenCalledWith(
			expect.objectContaining({
				images: [{ data: "base64-image", mimeType: "image/png" }],
			}),
			expect.any(Object),
		);
	});

	it("caches SDK checkpoint context windows after successful runs", async () => {
		const tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-cursor-provider-context-window-"));
		const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
		try {
			const loadLatest = vi.fn().mockResolvedValue({ tokenDetails: { usedTokens: 8435, maxTokens: 201000 } });
			mockedCreateAgentPlatform.mockResolvedValue(createMockAgentPlatform(loadLatest));
			const mockSend = vi.fn().mockResolvedValue({
				id: "run-1",
				agentId: "agent-1",
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "ok" }),
				cancel: vi.fn(),
				supports: () => true,
				unsupportedReason: () => undefined,
			});
			mockCreatedAgent({
				agentId: "agent-ctx",
				send: mockSend,
				[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
			});

			const stream = streamCursor(makeModel("composer-2"), makeContext(), { apiKey: "test-key" });
			await collectEvents(stream);

			expect(loadLatest).toHaveBeenCalledWith("agent-ctx");
			const cache = JSON.parse(readFileSync(contextWindowCacheTestUtils.getCachePath(), "utf-8"));
			expect(cache.contextWindows).toEqual({ "composer-2": 201000 });
		} finally {
			if (originalAgentDir === undefined) {
				delete process.env.PI_CODING_AGENT_DIR;
			} else {
				process.env.PI_CODING_AGENT_DIR = originalAgentDir;
			}
			rmSync(tmpAgentDir, { recursive: true, force: true });
		}
	});

	it("passes Cursor SDK plan mode through Agent.create and every Agent.send", async () => {
		await setCursorModeForProviderTest("plan");
		const mockSend = vi.fn().mockResolvedValue({
			id: "run-1",
			agentId: "agent-1",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		});
		mockCreatedAgent({
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), { apiKey: "test-key" }));

		expect(mockedCreate).toHaveBeenCalledWith(expect.objectContaining({ mode: "plan" }));
		expect(mockSend.mock.calls[0]?.[1]).toMatchObject({
			mode: "plan",
			model: {
				id: "gpt-5.5",
				params: [
					{ id: "context", value: "1m" },
					{ id: "fast", value: "false" },
					{ id: "reasoning", value: "none" },
				],
			},
		});
		expect((mockSend.mock.calls[0]?.[0] as { text: string }).text).toContain("Cursor SDK mode is plan for this run");
	});

	it("passes the effective Cursor SDK mode on every send while reusing the agent", async () => {
		const mockSend = vi.fn().mockResolvedValue({
			id: "run-1",
			agentId: "agent-1",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		});
		mockCreatedAgent({
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		await setCursorModeForProviderTest("agent");
		await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), { apiKey: "test-key" }));
		expect(mockedCreate).toHaveBeenCalledWith(expect.objectContaining({ mode: "agent" }));
		expect(mockSend.mock.calls[0]?.[1]).toMatchObject({ mode: "agent" });

		await setCursorModeForProviderTest("plan");
		await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), { apiKey: "test-key" }));
		expect(mockedCreate).toHaveBeenCalledTimes(1);
		expect(mockSend.mock.calls[1]?.[1]).toMatchObject({ mode: "plan" });

		await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), { apiKey: "test-key" }));
		expect(mockSend.mock.calls[2]?.[1]).toMatchObject({ mode: "plan" });

		await setCursorModeForProviderTest("agent");
		await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), { apiKey: "test-key" }));
		expect(mockSend.mock.calls[3]?.[1]).toMatchObject({ mode: "agent" });
	});

	it("passes Cursor alias model selection back to the SDK", async () => {
		modelDiscoveryTestUtils.registerModelItems([
			{
				id: "gpt-5.5",
				displayName: "GPT-5.5",
				aliases: ["gpt-latest"],
				parameters: [
					{ id: "context", displayName: "Context", values: [{ value: "1m" }, { value: "272k" }] },
					{ id: "reasoning", displayName: "Reasoning", values: [{ value: "none" }, { value: "medium" }] },
				],
				variants: [
					{
						params: [
							{ id: "context", value: "1m" },
							{ id: "reasoning", value: "medium" },
						],
						displayName: "GPT-5.5",
						isDefault: true,
					},
				],
			},
		]);
		const mockSend = vi.fn().mockResolvedValue({
			id: "run-1",
			agentId: "agent-1",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		});
		mockCreatedAgent({
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(makeModel("gpt-latest@272k"), makeContext(), { apiKey: "test-key", reasoning: "medium" });
		await collectEvents(stream);

		expect(mockedCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				model: {
					id: "gpt-latest",
					params: [
						{ id: "context", value: "272k" },
						{ id: "reasoning", value: "medium" },
					],
				},
			}),
		);
	});

	it("passes Cursor model selection with context and pi thinking off to Agent.create", async () => {
		const modelWithParams = makeModel("gpt-5.5@1m");
		const mockSend = vi.fn().mockResolvedValue({
			id: "run-1",
			agentId: "agent-1",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		});
		mockCreatedAgent({
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(modelWithParams, makeContext(), { apiKey: "test-key" });
		await collectEvents(stream);

		expect(mockedCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				model: {
					id: "gpt-5.5",
					params: [
						{ id: "context", value: "1m" },
						{ id: "fast", value: "false" },
						{ id: "reasoning", value: "none" },
					],
				},
			}),
		);
	});

	it("applies pi medium thinking level to Cursor reasoning parameter", async () => {
		const modelWithParams = {
			...makeModel("gpt-5.5@1m"),
			reasoning: true,
			thinkingLevelMap: { low: "low", medium: "medium", high: "high", xhigh: "extra-high", off: null, minimal: null },
		};
		const mockSend = vi.fn().mockResolvedValue({
			id: "run-1",
			agentId: "agent-1",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		});
		mockCreatedAgent({
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(modelWithParams, makeContext(), { apiKey: "test-key", reasoning: "medium" });
		await collectEvents(stream);

		expect(mockedCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				model: {
					id: "gpt-5.5",
					params: [
						{ id: "context", value: "1m" },
						{ id: "fast", value: "false" },
						{ id: "reasoning", value: "medium" },
					],
				},
			}),
		);
	});

	it("maps pi xhigh thinking to Cursor extra-high reasoning for a sibling context", async () => {
		const modelWithParams = {
			...makeModel("gpt-5.5@272k"),
			reasoning: true,
			thinkingLevelMap: { low: "low", medium: "medium", high: "high", xhigh: "extra-high", off: null, minimal: null },
		};
		const mockSend = vi.fn().mockResolvedValue({
			id: "run-1",
			agentId: "agent-1",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		});
		mockCreatedAgent({
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(modelWithParams, makeContext(), { apiKey: "test-key", reasoning: "xhigh" });
		await collectEvents(stream);

		expect(mockedCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				model: {
					id: "gpt-5.5",
					params: [
						{ id: "context", value: "272k" },
						{ id: "fast", value: "false" },
						{ id: "reasoning", value: "extra-high" },
					],
				},
			}),
		);
	});

	it("applies pi thinking level to Cursor Claude effort and thinking parameters", async () => {
		const modelWithParams = {
			...makeModel("claude-opus-4-7@1m"),
			reasoning: true,
			thinkingLevelMap: {
				off: "false",
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
			},
		};
		const mockSend = vi.fn().mockResolvedValue({
			id: "run-1",
			agentId: "agent-1",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		});
		mockCreatedAgent({
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(modelWithParams, makeContext(), { apiKey: "test-key", reasoning: "xhigh" });
		await collectEvents(stream);

		expect(mockedCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				model: {
					id: "claude-opus-4-7",
					params: [
						{ id: "context", value: "1m" },
						{ id: "effort", value: "xhigh" },
						{ id: "thinking", value: "true" },
					],
				},
			}),
		);
	});

	it("turns Cursor thinking off when pi thinking is off", async () => {
		const modelWithParams = {
			...makeModel("claude-sonnet-4-6@1m"),
			reasoning: true,
			thinkingLevelMap: { off: "false", low: "low", medium: "medium", high: "high", xhigh: "xhigh" },
		};
		const mockSend = vi.fn().mockResolvedValue({
			id: "run-1",
			agentId: "agent-1",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		});
		mockCreatedAgent({
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(modelWithParams, makeContext(), { apiKey: "test-key" });
		await collectEvents(stream);

		expect(mockedCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				model: {
					id: "claude-sonnet-4-6",
					params: [
						{ id: "context", value: "1m" },
						{ id: "thinking", value: "false" },
					],
				},
			}),
		);
	});

	it("passes plain model id without params to Agent.create", async () => {
		const plainModel = makeModel("gemini-3.1-pro");
		const mockSend = vi.fn().mockResolvedValue({
			id: "run-1",
			agentId: "agent-1",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		});
		mockCreatedAgent({
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(plainModel, makeContext(), { apiKey: "test-key" });
		await collectEvents(stream);

		expect(mockedCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				model: { id: "gemini-3.1-pro" },
			}),
		);
	});

	it("emits result text when no deltas were received", async () => {
		const mockSend = vi.fn().mockResolvedValue({
			id: "run-1",
			agentId: "agent-1",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "fallback text" }),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		});
		mockCreatedAgent({
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
		const events = await collectEvents(stream);

		const textEnd = getTextEndEvent(events);
		expect(textEnd).toBeDefined();
		expect(textEnd.content).toBe("fallback text");
	});
});
