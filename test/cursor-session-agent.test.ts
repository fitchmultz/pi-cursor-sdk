import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Context } from "@earendil-works/pi-ai";
import { shouldBootstrapCursorSend, computeCursorContextFingerprint } from "../src/context.js";
import { __testUtils as cursorSessionScopeTestUtils, registerCursorSessionScope } from "../src/cursor-session-scope.js";
import {
	acquireSessionCursorAgent,
	commitSessionAgentSend,
	registerCursorSessionAgent,
	__testUtils as sessionAgentTestUtils,
} from "../src/cursor-session-agent.js";

function makeContext(messages: Context["messages"]): Context {
	return {
		systemPrompt: "Be helpful.",
		messages,
	};
}

describe("cursor-session-agent", () => {
	beforeEach(async () => {
		cursorSessionScopeTestUtils.reset();
		await sessionAgentTestUtils.disposeAllSessionCursorAgents();
		vi.clearAllMocks();
	});

	it("reuses the same SDK agent for the same pi session scope", async () => {
		const mockDispose = vi.fn().mockResolvedValue(undefined);
		const createAgent = vi.fn().mockResolvedValue({
			agentId: "agent-1",
			[Symbol.asyncDispose]: mockDispose,
		});

		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/test.jsonl");
		const params = {
			apiKey: "test-key",
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			createAgent,
		};

		const first = await acquireSessionCursorAgent(params);
		const second = await acquireSessionCursorAgent(params);

		expect(first.created).toBe(true);
		expect(second.created).toBe(false);
		expect(first.agent).toBe(second.agent);
		expect(createAgent).toHaveBeenCalledTimes(1);
		expect(mockDispose).not.toHaveBeenCalled();
	});

	it("tracks incremental send count and resets it after bootstrap commits", async () => {
		const createAgent = vi.fn().mockResolvedValue({
			agentId: "agent-1",
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/test.jsonl");
		const scopeKey = "/tmp/sessions/test.jsonl";
		const params = {
			apiKey: "test-key",
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			createAgent,
		};

		const lease = await acquireSessionCursorAgent(params);
		const context = makeContext([{ role: "user", content: "Hello", timestamp: 1 }]);

		commitSessionAgentSend(scopeKey, context, true);
		expect(lease.sendState.incrementalSendCount).toBe(0);

		commitSessionAgentSend(scopeKey, context, false);
		commitSessionAgentSend(scopeKey, context, false);
		expect(lease.sendState.incrementalSendCount).toBe(2);

		commitSessionAgentSend(scopeKey, context, true);
		expect(lease.sendState.incrementalSendCount).toBe(0);
	});

	it("invalidates and recreates the session agent after compaction", async () => {
		const mockDispose = vi.fn().mockResolvedValue(undefined);
		const createAgent = vi.fn().mockImplementation(async () => ({
			agentId: `agent-${createAgent.mock.calls.length + 1}`,
			[Symbol.asyncDispose]: mockDispose,
		}));

		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/test.jsonl");
		const params = {
			apiKey: "test-key",
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			createAgent,
		};

		const first = await acquireSessionCursorAgent(params);
		sessionAgentTestUtils.invalidateSessionAgent("/tmp/sessions/test.jsonl");
		const second = await acquireSessionCursorAgent(params);

		expect(first.agent).not.toBe(second.agent);
		expect(createAgent).toHaveBeenCalledTimes(2);
		expect(mockDispose).toHaveBeenCalledTimes(1);
	});

	it("disposes in-flight Agent.create results after session disposal without recreating", async () => {
		const mockDisposeLate = vi.fn().mockResolvedValue(undefined);
		let resolveLateCreate: (agent: unknown) => void = () => {};
		const createAgent = vi.fn().mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveLateCreate = resolve;
				}),
		);

		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/test.jsonl");
		const params = {
			apiKey: "test-key",
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			createAgent,
		};

		const acquirePromise = acquireSessionCursorAgent(params);
		await vi.waitFor(() => expect(createAgent).toHaveBeenCalledTimes(1));
		await sessionAgentTestUtils.disposeSessionCursorAgent("/tmp/sessions/test.jsonl");
		resolveLateCreate({
			agentId: "agent-late",
			[Symbol.asyncDispose]: mockDisposeLate,
		});

		await expect(acquirePromise).rejects.toBeInstanceOf(sessionAgentTestUtils.SessionCursorAgentScopeClosedError);
		expect(mockDisposeLate).toHaveBeenCalledTimes(1);
		expect(createAgent).toHaveBeenCalledTimes(1);
		expect(sessionAgentTestUtils.sessionAgentsByScope.has("/tmp/sessions/test.jsonl")).toBe(false);
		await expect(acquireSessionCursorAgent(params)).rejects.toBeInstanceOf(sessionAgentTestUtils.SessionCursorAgentScopeClosedError);
	});

	it("does not retry a superseded in-flight acquire when replaced by a different pool key", async () => {
		const mockDisposeLate = vi.fn().mockResolvedValue(undefined);
		const mockDisposeReplacement = vi.fn().mockResolvedValue(undefined);
		let resolveLateCreate: (agent: unknown) => void = () => {};
		let createCount = 0;
		const createAgent = vi.fn().mockImplementation(async () => {
			createCount += 1;
			if (createCount === 1) {
				return new Promise((resolve) => {
					resolveLateCreate = resolve;
				});
			}
			return {
				agentId: "agent-replacement",
				[Symbol.asyncDispose]: mockDisposeReplacement,
			};
		});

		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/test.jsonl");
		const baseParams = {
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			createAgent,
		};

		const firstAcquirePromise = acquireSessionCursorAgent({ ...baseParams, apiKey: "key-a" });
		await vi.waitFor(() => expect(createAgent).toHaveBeenCalledTimes(1));
		const secondAcquirePromise = acquireSessionCursorAgent({ ...baseParams, apiKey: "key-b" });
		await vi.waitFor(() => expect(createAgent).toHaveBeenCalledTimes(2));
		resolveLateCreate({
			agentId: "agent-late",
			[Symbol.asyncDispose]: mockDisposeLate,
		});

		await expect(firstAcquirePromise).rejects.toBeInstanceOf(sessionAgentTestUtils.SessionCursorAgentCreationSupersededError);
		const secondLease = await secondAcquirePromise;

		expect(mockDisposeLate).toHaveBeenCalledTimes(1);
		expect(mockDisposeReplacement).not.toHaveBeenCalled();
		expect(secondLease.agent).toMatchObject({ agentId: "agent-replacement" });
		expect(createAgent).toHaveBeenCalledTimes(2);
	});

	it("clears invalidation before the first agent is created", async () => {
		const mockDispose = vi.fn().mockResolvedValue(undefined);
		const createAgent = vi.fn().mockResolvedValue({
			agentId: "agent-1",
			[Symbol.asyncDispose]: mockDispose,
		});

		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/test.jsonl");
		sessionAgentTestUtils.invalidateSessionAgent("/tmp/sessions/test.jsonl");
		const params = {
			apiKey: "test-key",
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			createAgent,
		};

		const first = await acquireSessionCursorAgent(params);
		const second = await acquireSessionCursorAgent(params);

		expect(first.created).toBe(true);
		expect(second.created).toBe(false);
		expect(first.agent).toBe(second.agent);
		expect(createAgent).toHaveBeenCalledTimes(1);
		expect(mockDispose).not.toHaveBeenCalled();
	});

	it("does not leave ConnectError from orphaned Agent.create as an unhandled rejection", async () => {
		const rejections: unknown[] = [];
		const onUnhandledRejection = (reason: unknown) => {
			rejections.push(reason);
		};
		process.on("unhandledRejection", onUnhandledRejection);

		let rejectCreate: (error: Error) => void = () => {};
		const mockDisposeLate = vi.fn().mockResolvedValue(undefined);
		const createAgent = vi.fn().mockImplementation(
			() =>
				new Promise((_resolve, reject) => {
					rejectCreate = reject;
				}),
		);

		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/test.jsonl");
		const params = {
			apiKey: "test-key",
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			createAgent,
		};

		const acquirePromise = acquireSessionCursorAgent(params);
		await vi.waitFor(() => expect(createAgent).toHaveBeenCalledTimes(1));
		await sessionAgentTestUtils.disposeSessionCursorAgent("/tmp/sessions/test.jsonl");
		rejectCreate(new Error("ConnectError: [unavailable] read ETIMEDOUT"));

		await expect(acquirePromise).rejects.toThrow("ConnectError: [unavailable] read ETIMEDOUT");
		await Promise.resolve();
		expect(rejections).toEqual([]);
		process.off("unhandledRejection", onUnhandledRejection);
	});

	it("detects when a follow-up send should bootstrap after branch shrink", () => {
		const sendState = {
			bootstrapped: true,
			contextFingerprint: computeCursorContextFingerprint({
				messages: [
					{ role: "user", content: "Hello", timestamp: 1 },
					{ role: "assistant", content: [{ type: "text", text: "Hi" }], api: "cursor-sdk", provider: "cursor", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 },
					{ role: "user", content: "More", timestamp: 3 },
					{ role: "assistant", content: [{ type: "text", text: "Ok" }], api: "cursor-sdk", provider: "cursor", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 4 },
				],
			}),
			incrementalSendCount: 0,
		};
		const context = makeContext([
			{ role: "user", content: "Hello", timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "Hi" }], api: "cursor-sdk", provider: "cursor", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 },
		]);

		expect(shouldBootstrapCursorSend(sendState, context)).toBe(true);
	});

	it("recreates the session agent when the API key identity changes", async () => {
		const mockDispose = vi.fn().mockResolvedValue(undefined);
		const createAgent = vi.fn().mockImplementation(async () => ({
			agentId: `agent-${createAgent.mock.calls.length + 1}`,
			[Symbol.asyncDispose]: mockDispose,
		}));

		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/test.jsonl");
		const baseParams = {
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			createAgent,
		};

		await acquireSessionCursorAgent({ ...baseParams, apiKey: "key-a" });
		await acquireSessionCursorAgent({ ...baseParams, apiKey: "key-b" });

		expect(createAgent).toHaveBeenCalledTimes(2);
		expect(mockDispose).toHaveBeenCalledTimes(1);
	});

	it("disposes the scoped session agent on terminal session_shutdown", async () => {
		const mockDispose = vi.fn().mockResolvedValue(undefined);
		const createAgent = vi.fn().mockResolvedValue({
			agentId: "agent-1",
			[Symbol.asyncDispose]: mockDispose,
		});
		const sessionShutdownHandlers: Array<(event: { reason: "quit" | "reload" }) => Promise<void> | void> = [];
		const pi = {
			on: vi.fn((event: string, handler: (event: { reason: "quit" | "reload" }) => Promise<void> | void) => {
				if (event === "session_shutdown") sessionShutdownHandlers.push(handler);
			}),
		};

		registerCursorSessionAgent(pi);
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/test.jsonl");
		await acquireSessionCursorAgent({
			apiKey: "test-key",
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			createAgent,
		});

		expect(sessionAgentTestUtils.sessionAgentsByScope.has("/tmp/sessions/test.jsonl")).toBe(true);
		await sessionShutdownHandlers[0]?.({ reason: "quit" });
		expect(sessionAgentTestUtils.sessionAgentsByScope.has("/tmp/sessions/test.jsonl")).toBe(false);
		expect(mockDispose).toHaveBeenCalledTimes(1);
	});

	it("allows reacquiring a session agent after reload session_shutdown", async () => {
		const mockDispose = vi.fn().mockResolvedValue(undefined);
		const createAgent = vi.fn().mockImplementation(async () => ({
			agentId: `agent-${createAgent.mock.calls.length + 1}`,
			[Symbol.asyncDispose]: mockDispose,
		}));
		const sessionShutdownHandlers: Array<(event: { reason: "quit" | "reload" }) => Promise<void> | void> = [];
		const pi = {
			on: vi.fn((event: string, handler: (event: { reason: "quit" | "reload" }) => Promise<void> | void) => {
				if (event === "session_shutdown") sessionShutdownHandlers.push(handler);
			}),
		};

		registerCursorSessionAgent(pi);
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/test.jsonl");
		const params = {
			apiKey: "test-key",
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			createAgent,
		};
		const first = await acquireSessionCursorAgent(params);

		await sessionShutdownHandlers[0]?.({ reason: "reload" });
		const second = await acquireSessionCursorAgent(params);

		expect(first.agent).not.toBe(second.agent);
		expect(createAgent).toHaveBeenCalledTimes(2);
		expect(mockDispose).toHaveBeenCalledTimes(1);
	});

	it("disposes the previous scope agent when the session file changes", async () => {
		const mockDispose = vi.fn().mockResolvedValue(undefined);
		const createAgent = vi.fn().mockResolvedValue({
			agentId: "agent-1",
			[Symbol.asyncDispose]: mockDispose,
		});
		const sessionStartHandlers: Array<(event: unknown, ctx: { cwd: string; sessionManager?: { getSessionFile?: () => string } }) => Promise<void> | void> = [];
		const pi = {
			on: vi.fn((event: string, handler: (event: unknown, ctx: { cwd: string; sessionManager?: { getSessionFile?: () => string } }) => Promise<void> | void) => {
				if (event === "session_start") sessionStartHandlers.push(handler);
			}),
		};

		registerCursorSessionScope(pi);
		registerCursorSessionAgent(pi);
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/session-a.jsonl");
		await acquireSessionCursorAgent({
			apiKey: "test-key",
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			createAgent,
		});

		for (const handler of sessionStartHandlers) {
			await handler({}, { cwd: "/tmp/project", sessionManager: { getSessionFile: () => "/tmp/sessions/session-b.jsonl" } });
		}

		expect(sessionAgentTestUtils.sessionAgentsByScope.has("/tmp/sessions/session-a.jsonl")).toBe(false);
		expect(mockDispose).toHaveBeenCalledTimes(1);
	});

	it("invalidates and recreates the session agent after session_tree-style invalidation", async () => {
		const mockDispose = vi.fn().mockResolvedValue(undefined);
		const createAgent = vi.fn().mockImplementation(async () => ({
			agentId: `agent-${createAgent.mock.calls.length + 1}`,
			[Symbol.asyncDispose]: mockDispose,
		}));

		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/test.jsonl");
		const params = {
			apiKey: "test-key",
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			createAgent,
		};

		const first = await acquireSessionCursorAgent(params);
		sessionAgentTestUtils.invalidateSessionAgent("/tmp/sessions/test.jsonl");
		const second = await acquireSessionCursorAgent(params);

		expect(first.agent).not.toBe(second.agent);
		expect(createAgent).toHaveBeenCalledTimes(2);
		expect(mockDispose).toHaveBeenCalledTimes(1);
	});

	it("resets the scoped session agent when session_tree fires", async () => {
		const mockDispose = vi.fn().mockResolvedValue(undefined);
		const createAgent = vi.fn().mockResolvedValue({
			agentId: "agent-1",
			[Symbol.asyncDispose]: mockDispose,
		});
		const sessionTreeHandlers: Array<() => Promise<void> | void> = [];
		const pi = {
			on: vi.fn((event: string, handler: () => Promise<void> | void) => {
				if (event === "session_tree") sessionTreeHandlers.push(handler);
			}),
		};

		registerCursorSessionAgent(pi);
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/test.jsonl");
		await acquireSessionCursorAgent({
			apiKey: "test-key",
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			createAgent,
		});

		expect(sessionAgentTestUtils.sessionAgentsByScope.has("/tmp/sessions/test.jsonl")).toBe(true);
		await sessionTreeHandlers[0]?.();
		expect(sessionAgentTestUtils.sessionAgentsByScope.has("/tmp/sessions/test.jsonl")).toBe(false);
		expect(mockDispose).toHaveBeenCalledTimes(1);
	});

	it("invalidates before branch summary when session_before_tree fires", async () => {
		const mockDispose = vi.fn().mockResolvedValue(undefined);
		const createAgent = vi.fn().mockImplementation(async () => ({
			agentId: `agent-${createAgent.mock.calls.length + 1}`,
			[Symbol.asyncDispose]: mockDispose,
		}));
		const sessionBeforeTreeHandlers: Array<() => void> = [];
		const pi = {
			on: vi.fn((event: string, handler: () => void) => {
				if (event === "session_before_tree") sessionBeforeTreeHandlers.push(handler);
			}),
		};

		registerCursorSessionAgent(pi);
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/test.jsonl");
		const params = {
			apiKey: "test-key",
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			createAgent,
		};

		const first = await acquireSessionCursorAgent(params);
		sessionBeforeTreeHandlers[0]?.();
		const second = await acquireSessionCursorAgent(params);

		expect(first.agent).not.toBe(second.agent);
		expect(createAgent).toHaveBeenCalledTimes(2);
		expect(mockDispose).toHaveBeenCalledTimes(1);
	});
});
