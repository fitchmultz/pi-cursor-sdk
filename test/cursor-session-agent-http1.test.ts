import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CursorConfigureOptions } from "@cursor/sdk";
import {
	acquireSessionCursorAgent,
	__testUtils as sessionAgentTestUtils,
} from "../src/cursor-session-agent.js";
import { __testUtils as cursorSessionScopeTestUtils } from "../src/cursor-session-scope.js";
import { __testUtils as resumeTestUtils } from "../src/cursor-session-agent-resume.js";
import {
	__testUtils as cursorHttp1TestUtils,
	configureCursorSdkHttp1,
} from "../src/cursor-http1.js";
import { registerCursorSessionAgentLifecycle } from "../src/cursor-session-agent-lifecycle.js";
import { createEventHarness } from "./helpers/pi-harness.js";
import { installCursorSessionStoreMock } from "./helpers/cursor-session-store.js";

describe("Cursor session agent HTTP/1.1 pooling", () => {
	beforeEach(async () => {
		installCursorSessionStoreMock();
		cursorSessionScopeTestUtils.reset();
		resumeTestUtils.reset();
		await sessionAgentTestUtils.disposeAllSessionCursorAgents();
		cursorHttp1TestUtils.reset();
		vi.clearAllMocks();
	});

	it("clears extension-owned SDK transport after agent disposal on reload", async () => {
		const configure = vi.fn<(options: CursorConfigureOptions) => void>();
		let finishDispose: (() => void) | undefined;
		const dispose = vi.fn(() => new Promise<void>((resolve) => {
			finishDispose = resolve;
		}));
		const createAgent = vi.fn().mockResolvedValue({
			agentId: "agent-http1-reload",
			[Symbol.asyncDispose]: dispose,
		});
		const pi = createEventHarness();
		registerCursorSessionAgentLifecycle(pi);
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/test.jsonl");
		configureCursorSdkHttp1(
			{ Cursor: { configure } },
			{ value: true, source: "environment", trustLevel: "environment" },
		);
		await acquireSessionCursorAgent({
			apiKey: "test-key",
			agentMode: "agent",
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			useHttp1ForAgent: true,
			createAgent,
		});

		const shutdown = pi.runSessionShutdown({ reason: "reload" });
		await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
		expect(configure).toHaveBeenCalledTimes(1);
		finishDispose?.();
		await shutdown;

		expect(configure).toHaveBeenNthCalledWith(1, {
			local: { useHttp1ForAgent: true },
		});
		expect(configure).toHaveBeenNthCalledWith(2, {
			local: { useHttp1ForAgent: null },
		});
		expect(dispose.mock.invocationCallOrder[0]).toBeLessThan(
			configure.mock.invocationCallOrder[1] ?? Number.POSITIVE_INFINITY,
		);
	});

	it("splits default, HTTP/2, and HTTP/1.1 pool keys", () => {
		const baseParams = {
			apiKey: "test-key",
			agentMode: "agent" as const,
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
		};
		const poolKeys = [
			sessionAgentTestUtils.buildSessionAgentPoolKey("scope", baseParams),
			sessionAgentTestUtils.buildSessionAgentPoolKey("scope", {
				...baseParams,
				useHttp1ForAgent: false,
			}),
			sessionAgentTestUtils.buildSessionAgentPoolKey("scope", {
				...baseParams,
				useHttp1ForAgent: true,
			}),
		];

		expect(new Set(poolKeys).size).toBe(3);
	});

	it("disposes the previous transport pool before creating its replacement", async () => {
		let finishDispose: (() => void) | undefined;
		const firstDispose = vi.fn(() => new Promise<void>((resolve) => {
			finishDispose = resolve;
		}));
		const createAgent = vi.fn().mockImplementation(async () => ({
			agentId: `agent-${createAgent.mock.calls.length}`,
			[Symbol.asyncDispose]: createAgent.mock.calls.length === 1
				? firstDispose
				: vi.fn().mockResolvedValue(undefined),
		}));
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/test.jsonl");
		const params = {
			apiKey: "test-key",
			agentMode: "agent" as const,
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			createAgent,
		};
		await acquireSessionCursorAgent({ ...params, useHttp1ForAgent: true });

		const replacement = acquireSessionCursorAgent({ ...params, useHttp1ForAgent: false });
		await vi.waitFor(() => expect(firstDispose).toHaveBeenCalledTimes(1));
		expect(createAgent).toHaveBeenCalledTimes(1);

		finishDispose?.();
		await replacement;
		expect(createAgent).toHaveBeenCalledTimes(2);
	});
});
