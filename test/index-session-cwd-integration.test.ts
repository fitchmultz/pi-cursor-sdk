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
import extensionFactory from "../src/index.js";
import { discoverModels } from "../src/model-discovery.js";
import { __testUtils as cursorProviderTestUtils } from "../src/cursor-provider.js";
import { streamCursorLazy } from "../src/cursor-provider-lazy.js";
import { __testUtils as cursorSessionScopeTestUtils } from "../src/cursor-session-scope.js";
import { __testUtils as cursorPiToolBridgeTestUtils } from "../src/cursor-pi-tool-bridge.js";
import { __testUtils as cursorHttp1TestUtils } from "../src/cursor-http1.js";
import { installCursorSessionStoreMock } from "./helpers/cursor-session-store.js";
import {
	collectEvents,
	createExtensionRegistrationPi,
	makeContext,
	makeModel,
	makeProviderModelConfig,
} from "./helpers/pi-harness.js";

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
			const pi = createExtensionRegistrationPi();
			await extensionFactory(pi);
			await pi.runSessionStart({ cwd: sessionDir, hasUI: false });

			expect(pi.registerProvider).toHaveBeenCalledOnce();
			const streamSimple = pi._registered[0]?.config.streamSimple;
			expect(streamSimple).toBe(streamCursorLazy);

			await collectEvents(streamSimple!(makeModel("composer-2.5"), makeContext(), { apiKey: "test-key" }));

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
		} finally {
			rmSync(sessionDir, { recursive: true, force: true });
		}
	});
});
