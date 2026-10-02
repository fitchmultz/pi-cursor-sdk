import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/model-discovery.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/model-discovery.js")>();
	return {
		...actual,
		discoverModels: vi.fn(),
	};
});

function createMockAgentRun() {
	return {
		id: "run-1",
		agentId: "agent-1",
		status: "finished",
		wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
		cancel: vi.fn(),
		supports: () => true,
		unsupportedReason: () => undefined,
	};
}

function createMockAgent(): SDKAgent {
	const mockSend = vi.fn().mockResolvedValue(createMockAgentRun());
	return {
		agentId: "agent-1",
		model: undefined,
		send: mockSend,
		close: vi.fn(),
		reload: vi.fn().mockResolvedValue(undefined),
		listArtifacts: vi.fn().mockResolvedValue([]),
		downloadArtifact: vi.fn().mockResolvedValue(Buffer.from("")),
		getUsage: vi.fn().mockResolvedValue({ usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 }, runs: [] }),
		[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
	};
}

vi.mock("@cursor/sdk", () => ({
	Cursor: {
		configure: vi.fn(),
	},
	Agent: {
		create: vi.fn().mockResolvedValue(createMockAgent()),
	},
	createAgentPlatform: vi.fn().mockResolvedValue({
		checkpointStore: { loadLatest: vi.fn().mockResolvedValue(undefined) },
	}),
}));

import { Agent, Cursor, type SDKAgent } from "@cursor/sdk";
import { normalizeContext } from "@earendil-works/pi-ai";
import extensionFactory from "../src/index.js";
import { discoverModels } from "../src/model-discovery.js";
import { __testUtils as cursorProviderTestUtils } from "../src/cursor-provider.js";
import { __testUtils as cursorSessionScopeTestUtils } from "../src/cursor-session-scope.js";
import { __testUtils as cursorPiToolBridgeTestUtils } from "../src/cursor-pi-tool-bridge.js";
import { __testUtils as cursorHttp1TestUtils } from "../src/cursor-http1.js";
import { installCursorSessionStoreMock } from "./helpers/cursor-session-store.js";
import {
	collectEvents,
	makeContext,
	makeModel,
	makeProviderModelConfig,
} from "./helpers/pi-harness.js";

import { createExtensionPi } from "./helpers/index-extension-test-kit.js";

const mockedDiscover = vi.mocked(discoverModels);
const mockedAgentCreate = vi.mocked(Agent.create);
const mockedCursorConfigure = vi.mocked(Cursor.configure);

describe("extension session cwd integration", () => {
	beforeEach(async () => {
		installCursorSessionStoreMock();
		await cursorPiToolBridgeTestUtils.resetRegisteredBridgeForTests();
		vi.clearAllMocks();
		delete process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY;
		delete process.env.PI_CURSOR_REGISTER_NATIVE_TOOLS;
		delete process.env.PI_CURSOR_SETTING_SOURCES;
		delete process.env.PI_CURSOR_HTTP_1_1;
		cursorHttp1TestUtils.reset();
		expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(0);
		cursorSessionScopeTestUtils.reset();
		mockedAgentCreate.mockResolvedValue(createMockAgent());
		mockedDiscover.mockResolvedValue([
			makeProviderModelConfig("composer-2.5", { name: "Cursor Composer 2.5", input: ["text"] }),
		]);
	});

	afterEach(async () => {
		cursorSessionScopeTestUtils.reset();
		await cursorPiToolBridgeTestUtils.resetRegisteredBridgeForTests();
	});

	it("passes pi session cwd from extension registration through streamSimple to Agent.create", async () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "pi-cursor-index-agent-cwd-"));
		try {
			const pi = createExtensionPi();
			await extensionFactory(pi);
			await pi.runSessionStart({ cwd: sessionDir, hasUI: false });

			expect(pi.registerProvider).toHaveBeenCalledOnce();
			const streamSimple = pi._registered[0]?.config.streamSimple;
			expect(streamSimple).toEqual(expect.any(Function));

			const headers = {};
			await pi.invokeEvent("before_provider_headers", { type: "before_provider_headers", headers });
			await collectEvents(streamSimple!(makeModel("composer-2.5"), normalizeContext(makeContext()), { apiKey: "test-key", headers }));

			expect(mockedAgentCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					local: expect.objectContaining({
						cwd: sessionDir,
						settingSources: ["all"],
						store: expect.any(Object),
					}),
				}),
			);
			expect(mockedCursorConfigure).not.toHaveBeenCalled();
			await pi.runSessionShutdown({ reason: "quit" });
		} finally {
			rmSync(sessionDir, { recursive: true, force: true });
		}
	});
});
