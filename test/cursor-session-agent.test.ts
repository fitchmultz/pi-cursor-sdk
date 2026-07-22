import { toNamespacedPath } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { computeCursorContextFingerprint, shouldBootstrapCursorContext } from "../src/context.js";
import { createEventHarness, createExtensionTestContext, makeContext } from "./helpers/pi-harness.js";
import { __testUtils as cursorSessionScopeTestUtils, registerCursorSessionScope } from "../src/cursor-session-scope.js";
import { __testUtils as resumeTestUtils } from "../src/cursor-session-agent-resume.js";
import {
	acquireSessionCursorAgent,
	__testUtils as sessionAgentTestUtils,
} from "../src/cursor-session-agent.js";
import { registerCursorSessionAgentLifecycle } from "../src/cursor-session-agent-lifecycle.js";
import { installCursorSessionStoreMock } from "./helpers/cursor-session-store.js";
import { buildCursorSessionStateRoot } from "../src/cursor-session-store.js";

describe("cursor-session-agent", () => {
	beforeEach(async () => {
		installCursorSessionStoreMock();
		cursorSessionScopeTestUtils.reset();
		resumeTestUtils.reset();
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
			agentMode: "agent" as const,
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
		expect(createAgent).toHaveBeenCalledWith(expect.objectContaining({ mode: "agent" }));
		expect(mockDispose).not.toHaveBeenCalled();
	});

	it("passes one session-scoped store through Agent.create and disposes it with the pooled agent", async () => {
		const storeMock = installCursorSessionStoreMock();
		const scopeKey = "/tmp/sessions/store-session.jsonl";
		const createAgent = vi.fn().mockResolvedValue({
			agentId: "agent-store",
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});
		cursorSessionScopeTestUtils.set("/tmp/project", scopeKey);

		const lease = await acquireSessionCursorAgent({
			apiKey: "test-key",
			agentMode: "agent",
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			createAgent,
		});

		expect(storeMock.openSqliteStore).toHaveBeenCalledWith({
			workspaceRef: "/tmp/project",
			stateRoot: toNamespacedPath(buildCursorSessionStateRoot("/tmp/cursor-sdk-state", scopeKey, true)),
		});
		expect(createAgent.mock.calls[0][0].local?.store).toBe(storeMock.stores[0]);
		expect(lease.store).toBe(storeMock.stores[0]);

		await sessionAgentTestUtils.resetSessionCursorAgent(scopeKey);
		expect(storeMock.stores[0].dispose).toHaveBeenCalledTimes(1);
	});

	it("passes the desired Cursor SDK mode to Agent.create", async () => {
		const createAgent = vi.fn().mockResolvedValue({
			agentId: "agent-plan",
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/test.jsonl");

		await acquireSessionCursorAgent({
			apiKey: "test-key",
			agentMode: "plan",
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			createAgent,
		});

		expect(createAgent).toHaveBeenCalledWith(expect.objectContaining({ mode: "plan" }));
	});

	it("keeps Cursor SDK mode out of the session agent pool key", async () => {
		const mockDispose = vi.fn().mockResolvedValue(undefined);
		const createAgent = vi.fn().mockResolvedValue({
			agentId: "agent-1",
			[Symbol.asyncDispose]: mockDispose,
		});
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/test.jsonl");
		const params = {
			apiKey: "test-key",
			agentMode: "agent" as const,
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			createAgent,
		};

		const first = await acquireSessionCursorAgent(params);
		const second = await acquireSessionCursorAgent({ ...params, agentMode: "plan" });

		expect(second.created).toBe(false);
		expect(second.agent).toBe(first.agent);
		expect(createAgent).toHaveBeenCalledTimes(1);
		expect(mockDispose).not.toHaveBeenCalled();
	});

	it("awaits lease-tracked background sdk run completion for the same pool instance", async () => {
		const createAgent = vi.fn().mockResolvedValue({
			agentId: "agent-1",
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/test.jsonl");
		const scopeKey = "/tmp/sessions/test.jsonl";
		const params = {
			apiKey: "test-key",
			agentMode: "agent" as const,
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			createAgent,
		};
		let resolveCompletion: (() => void) | undefined;
		const completion = new Promise<void>((resolve) => {
			resolveCompletion = resolve;
		});

		const first = await acquireSessionCursorAgent(params);
		first.trackRunCompletion(completion);
		expect(sessionAgentTestUtils.getSessionCursorAgentPoolState(scopeKey).status).toBe("busy");

		const secondAcquirePromise = acquireSessionCursorAgent(params);
		let reacquireResolved = false;
		void secondAcquirePromise.then(() => {
			reacquireResolved = true;
		});

		await Promise.resolve();
		expect(reacquireResolved).toBe(false);

		resolveCompletion?.();
		const second = await secondAcquirePromise;
		expect(reacquireResolved).toBe(true);
		expect(second.agent).toBe(first.agent);
		expect(second.created).toBe(false);
		expect(sessionAgentTestUtils.getSessionCursorAgentPoolState(scopeKey).status).toBe("ready");
	});

	it("does not await stale sdk run completion after pool replacement", async () => {
		const createAgent = vi.fn().mockImplementation(async () => ({
			agentId: `agent-${createAgent.mock.calls.length + 1}`,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		}));
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/test.jsonl");
		const scopeKey = "/tmp/sessions/test.jsonl";
		const params = {
			apiKey: "test-key",
			agentMode: "agent" as const,
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			createAgent,
		};
		const completion = new Promise<void>(() => {
			// never resolves
		});

		const first = await acquireSessionCursorAgent(params);
		first.trackRunCompletion(completion);
		await sessionAgentTestUtils.resetSessionCursorAgent(scopeKey);
		const replacement = await acquireSessionCursorAgent(params);

		expect(replacement.agent).not.toBe(first.agent);
		expect(createAgent).toHaveBeenCalledTimes(2);
	});

	it("does not serialize pool-key replacement behind an unrelated busy run", async () => {
		const mockDispose1 = vi.fn().mockResolvedValue(undefined);
		const mockDispose2 = vi.fn().mockResolvedValue(undefined);
		const createAgent = vi.fn().mockImplementation(async () => {
			if (createAgent.mock.calls.length === 1) {
				return { agentId: "agent-1", [Symbol.asyncDispose]: mockDispose1 };
			}
			return { agentId: "agent-2", [Symbol.asyncDispose]: mockDispose2 };
		});
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/test.jsonl");
		const baseParams = {
			agentMode: "agent" as const,
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			createAgent,
		};
		const completion = new Promise<void>(() => {
			// never resolves
		});

		const first = await acquireSessionCursorAgent({ ...baseParams, apiKey: "key-a" });
		first.trackRunCompletion(completion);
		const replacementPromise = acquireSessionCursorAgent({ ...baseParams, apiKey: "key-b" });

		await vi.waitFor(() => expect(createAgent).toHaveBeenCalledTimes(2));
		const replacement = await replacementPromise;

		expect(replacement.agent).not.toBe(first.agent);
		expect(replacement.agent.agentId).toBe("agent-2");
		expect(mockDispose1).toHaveBeenCalledTimes(1);
		expect(mockDispose2).not.toHaveBeenCalled();
	});

	it("ignores stale send commits after pool replacement", async () => {
		const createAgent = vi.fn().mockResolvedValue({
			agentId: "agent-1",
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/test.jsonl");
		const scopeKey = "/tmp/sessions/test.jsonl";
		const params = {
			apiKey: "test-key",
			agentMode: "agent" as const,
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			createAgent,
		};
		const context = makeContext([{ role: "user", content: "Hello", timestamp: 1 }]);

		const lease = await acquireSessionCursorAgent(params);
		await sessionAgentTestUtils.resetSessionCursorAgent(scopeKey);
		const replacement = await acquireSessionCursorAgent(params);

		lease.commitSend(context, true);
		expect(replacement.sendState.bootstrapped).toBe(false);

		replacement.commitSend(context, true);
		expect(replacement.sendState.bootstrapped).toBe(true);
	});

	it("reacquires instead of returning stale lease after scope reset during idle wait", async () => {
		const mockDispose1 = vi.fn().mockResolvedValue(undefined);
		const mockDispose2 = vi.fn().mockResolvedValue(undefined);
		const createAgent = vi.fn().mockImplementation(async () => {
			if (createAgent.mock.calls.length === 1) {
				return { agentId: "agent-1", [Symbol.asyncDispose]: mockDispose1 };
			}
			return { agentId: "agent-2", [Symbol.asyncDispose]: mockDispose2 };
		});

		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/test.jsonl");
		const scopeKey = "/tmp/sessions/test.jsonl";
		const params = {
			apiKey: "test-key",
			agentMode: "agent" as const,
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			createAgent,
		};

		const first = await acquireSessionCursorAgent(params);
		expect(first.agent.agentId).toBe("agent-1");

		const completion = new Promise<void>(() => {
			// never resolves
		});
		first.trackRunCompletion(completion);

		const secondAcquirePromise = acquireSessionCursorAgent(params);
		await Promise.resolve();
		await sessionAgentTestUtils.resetSessionCursorAgent(scopeKey);

		const second = await secondAcquirePromise;
		expect(second.agent.agentId).toBe("agent-2");
		expect(second.instanceId).not.toBe(first.instanceId);
		expect(createAgent).toHaveBeenCalledTimes(2);
	});

	it("rejects a blocked busy acquire when terminal disposal happens before sdk completion", async () => {
		const mockDispose = vi.fn().mockResolvedValue(undefined);
		const createAgent = vi.fn().mockResolvedValue({
			agentId: "agent-1",
			[Symbol.asyncDispose]: mockDispose,
		});
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/test.jsonl");
		const scopeKey = "/tmp/sessions/test.jsonl";
		const params = {
			apiKey: "test-key",
			agentMode: "agent" as const,
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			createAgent,
		};
		const completion = new Promise<void>(() => {
			// never resolves
		});

		const first = await acquireSessionCursorAgent(params);
		first.trackRunCompletion(completion);
		const blockedAcquirePromise = acquireSessionCursorAgent(params);
		await Promise.resolve();
		await sessionAgentTestUtils.disposeSessionCursorAgent(scopeKey);

		await expect(blockedAcquirePromise).rejects.toBeInstanceOf(sessionAgentTestUtils.SessionCursorAgentScopeClosedError);
		expect(mockDispose).toHaveBeenCalledTimes(1);
	});

	it("reuses replacement agent when idle wait stale after concurrent acquire", async () => {
		const mockDispose1 = vi.fn().mockResolvedValue(undefined);
		const mockDispose2 = vi.fn().mockResolvedValue(undefined);
		let resolveCompletion: (() => void) | undefined;
		const createAgent = vi.fn().mockImplementation(async () => {
			if (createAgent.mock.calls.length === 1) {
				return { agentId: "agent-1", [Symbol.asyncDispose]: mockDispose1 };
			}
			return { agentId: "agent-2", [Symbol.asyncDispose]: mockDispose2 };
		});

		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/test.jsonl");
		const scopeKey = "/tmp/sessions/test.jsonl";
		const params = {
			apiKey: "test-key",
			agentMode: "agent" as const,
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			createAgent,
		};

		const first = await acquireSessionCursorAgent(params);
		expect(first.agent.agentId).toBe("agent-1");

		const completion = new Promise<void>((resolve) => {
			resolveCompletion = resolve;
		});
		first.trackRunCompletion(completion);

		const blockedAcquirePromise = acquireSessionCursorAgent(params);
		await Promise.resolve();
		await sessionAgentTestUtils.resetSessionCursorAgent(scopeKey);
		const replacement = await acquireSessionCursorAgent(params);
		expect(replacement.agent.agentId).toBe("agent-2");
		expect(createAgent).toHaveBeenCalledTimes(2);

		resolveCompletion?.();
		const blocked = await blockedAcquirePromise;
		expect(blocked.agent.agentId).toBe("agent-2");
		expect(blocked.instanceId).toBe(replacement.instanceId);
		expect(createAgent).toHaveBeenCalledTimes(2);
		expect(mockDispose2).not.toHaveBeenCalled();
	});

	it("tracks incremental send count and resets it after bootstrap commits", async () => {
		const createAgent = vi.fn().mockResolvedValue({
			agentId: "agent-1",
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/test.jsonl");
		const params = {
			apiKey: "test-key",
			agentMode: "agent" as const,
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			createAgent,
		};

		const lease = await acquireSessionCursorAgent(params);
		const context = makeContext([{ role: "user", content: "Hello", timestamp: 1 }]);

		lease.commitSend(context, true);
		expect(lease.sendState.incrementalSendCount).toBe(0);

		lease.commitSend(context, false);
		lease.commitSend(context, false);
		expect(lease.sendState.incrementalSendCount).toBe(2);

		lease.commitSend(context, true);
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
			agentMode: "agent" as const,
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
			agentMode: "agent" as const,
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

	it("does not retry a superseded fileless acquire or remove its replacement store", async () => {
		const storeMock = installCursorSessionStoreMock();
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

		cursorSessionScopeTestUtils.set("/tmp/project", undefined, "ephemeral");
		const baseParams = {
			agentMode: "agent" as const,
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
		expect(storeMock.openedOptions[0].stateRoot).not.toBe(storeMock.openedOptions[1].stateRoot);
		expect(storeMock.stores[0].dispose).toHaveBeenCalledTimes(1);
		expect(storeMock.stores[1].dispose).not.toHaveBeenCalled();
	});

	it("keeps a delayed fileless acquisition temporary after session scope becomes persisted", async () => {
		let resolveDefaultStateRoot: (stateRoot: string) => void = () => {};
		const getDefaultStateRoot = vi.fn(() => new Promise<string>((resolve) => {
			resolveDefaultStateRoot = resolve;
		}));
		const storeMock = installCursorSessionStoreMock(getDefaultStateRoot);
		const createAgent = vi.fn().mockResolvedValue({
			agentId: "agent-fileless",
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});
		cursorSessionScopeTestUtils.set("/tmp/project", undefined, "ephemeral");

		const acquire = acquireSessionCursorAgent({
			apiKey: "test-key",
			agentMode: "agent",
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			createAgent,
		});
		await vi.waitFor(() => expect(getDefaultStateRoot).toHaveBeenCalledTimes(1));
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/persisted.jsonl", "persisted");
		resolveDefaultStateRoot("/tmp/cursor-sdk-state");

		await acquire;
		expect(storeMock.openedOptions[0].stateRoot).toContain("pi-cursor-sdk");
		expect(storeMock.openedOptions[0].stateRoot).not.toContain("cursor-sdk-state");
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
			agentMode: "agent" as const,
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
			agentMode: "agent" as const,
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

		expect(shouldBootstrapCursorContext(sendState, context)).toBe(true);
	});

	it("recreates the session agent when the API key identity changes", async () => {
		const mockDispose = vi.fn().mockResolvedValue(undefined);
		const createAgent = vi.fn().mockImplementation(async () => ({
			agentId: `agent-${createAgent.mock.calls.length + 1}`,
			[Symbol.asyncDispose]: mockDispose,
		}));

		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/test.jsonl");
		const baseParams = {
			agentMode: "agent" as const,
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
		const pi = createEventHarness();

		registerCursorSessionAgentLifecycle(pi);
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/test.jsonl");
		await acquireSessionCursorAgent({
			apiKey: "test-key",
			agentMode: "agent" as const,
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			createAgent,
		});

		expect(sessionAgentTestUtils.sessionAgentsByScope.has("/tmp/sessions/test.jsonl")).toBe(true);
		await pi.runSessionShutdown({ reason: "quit" });
		expect(sessionAgentTestUtils.sessionAgentsByScope.has("/tmp/sessions/test.jsonl")).toBe(false);
		expect(mockDispose).toHaveBeenCalledTimes(1);
	});

	it("allows reacquiring a session agent after reload session_shutdown", async () => {
		const mockDispose = vi.fn().mockResolvedValue(undefined);
		const createAgent = vi.fn().mockImplementation(async () => ({
			agentId: `agent-${createAgent.mock.calls.length + 1}`,
			[Symbol.asyncDispose]: mockDispose,
		}));
		const pi = createEventHarness();

		registerCursorSessionAgentLifecycle(pi);
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/test.jsonl");
		const params = {
			apiKey: "test-key",
			agentMode: "agent" as const,
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			createAgent,
		};
		const first = await acquireSessionCursorAgent(params);

		await pi.runSessionShutdown({ reason: "reload" });
		const second = await acquireSessionCursorAgent(params);

		expect(first.agent).not.toBe(second.agent);
		expect(createAgent).toHaveBeenCalledTimes(2);
		expect(mockDispose).toHaveBeenCalledTimes(1);
	});

	it("allows reacquiring after terminal shutdown when fileless session id changes", async () => {
		const mockDispose = vi.fn().mockResolvedValue(undefined);
		const createAgent = vi.fn().mockImplementation(async () => ({
			agentId: `agent-${createAgent.mock.calls.length + 1}`,
			[Symbol.asyncDispose]: mockDispose,
		}));
		const pi = createEventHarness();

		registerCursorSessionScope(pi);
		registerCursorSessionAgentLifecycle(pi);
		const params = {
			apiKey: "test-key",
			agentMode: "agent" as const,
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			createAgent,
		};

		await pi.runSessionStart({
			cwd: "/tmp/project",
			sessionManager: {
				getSessionFile: () => undefined,
				getSessionId: () => "ephemeral-a",
			},
		});
		const first = await acquireSessionCursorAgent(params);
		expect(first.scopeKey).toBe(`${cursorSessionScopeTestUtils.EPHEMERAL_SESSION_SCOPE_PREFIX}ephemeral-a`);

		await pi.runSessionShutdown({ reason: "new" });
		await pi.runSessionStart({
			cwd: "/tmp/project",
			sessionManager: {
				getSessionFile: () => undefined,
				getSessionId: () => "ephemeral-b",
			},
		});
		const second = await acquireSessionCursorAgent(params);

		expect(second.scopeKey).toBe(`${cursorSessionScopeTestUtils.EPHEMERAL_SESSION_SCOPE_PREFIX}ephemeral-b`);
		expect(first.agent).not.toBe(second.agent);
		expect(createAgent).toHaveBeenCalledTimes(2);
		expect(mockDispose).toHaveBeenCalledTimes(1);
	});

	it("allows reacquiring after terminal shutdown when a session file is resumed", async () => {
		const mockDispose = vi.fn().mockResolvedValue(undefined);
		const createAgent = vi.fn().mockImplementation(async () => ({
			agentId: `agent-${createAgent.mock.calls.length + 1}`,
			[Symbol.asyncDispose]: mockDispose,
		}));
		const pi = createEventHarness();

		registerCursorSessionScope(pi);
		registerCursorSessionAgentLifecycle(pi);
		const params = {
			apiKey: "test-key",
			agentMode: "agent" as const,
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			createAgent,
		};

		await pi.runSessionStart({
			cwd: "/tmp/project",
			sessionManager: {
				getSessionFile: () => "/tmp/sessions/session-a.jsonl",
			},
		});
		const first = await acquireSessionCursorAgent(params);

		await pi.runSessionShutdown({ reason: "resume" });
		await pi.runSessionStart({
			cwd: "/tmp/project",
			sessionManager: {
				getSessionFile: () => "/tmp/sessions/session-b.jsonl",
			},
		});
		const second = await acquireSessionCursorAgent(params);

		await pi.runSessionShutdown({ reason: "resume" });
		await pi.runSessionStart({
			cwd: "/tmp/project",
			sessionManager: {
				getSessionFile: () => "/tmp/sessions/session-a.jsonl",
			},
		});
		const resumed = await acquireSessionCursorAgent(params);

		expect(first.scopeKey).toBe("/tmp/sessions/session-a.jsonl");
		expect(second.scopeKey).toBe("/tmp/sessions/session-b.jsonl");
		expect(resumed.scopeKey).toBe("/tmp/sessions/session-a.jsonl");
		expect(resumed.agent).not.toBe(first.agent);
		expect(createAgent).toHaveBeenCalledTimes(3);
		expect(mockDispose).toHaveBeenCalledTimes(2);
	});

	it("disposes the previous scope agent when the session file changes", async () => {
		const mockDispose = vi.fn().mockResolvedValue(undefined);
		const createAgent = vi.fn().mockResolvedValue({
			agentId: "agent-1",
			[Symbol.asyncDispose]: mockDispose,
		});
		const pi = createEventHarness();

		registerCursorSessionScope(pi);
		registerCursorSessionAgentLifecycle(pi);
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/session-a.jsonl");
		await acquireSessionCursorAgent({
			apiKey: "test-key",
			agentMode: "agent" as const,
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			createAgent,
		});

		await pi.invokeEventWithContext(
			"session_start",
			{ type: "session_start", reason: "startup" },
			createExtensionTestContext({
				cwd: "/tmp/project",
				sessionManager: {
					getSessionFile: () => "/tmp/sessions/session-b.jsonl",
				},
			}),
		);

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
			agentMode: "agent" as const,
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
		const pi = createEventHarness();

		registerCursorSessionAgentLifecycle(pi);
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/test.jsonl");
		await acquireSessionCursorAgent({
			apiKey: "test-key",
			agentMode: "agent" as const,
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			createAgent,
		});

		expect(sessionAgentTestUtils.sessionAgentsByScope.has("/tmp/sessions/test.jsonl")).toBe(true);
		await pi.runSessionTree();
		expect(sessionAgentTestUtils.sessionAgentsByScope.has("/tmp/sessions/test.jsonl")).toBe(false);
		expect(mockDispose).toHaveBeenCalledTimes(1);
	});

	it("invalidates before branch summary when session_before_tree fires", async () => {
		const mockDispose = vi.fn().mockResolvedValue(undefined);
		const createAgent = vi.fn().mockImplementation(async () => ({
			agentId: `agent-${createAgent.mock.calls.length + 1}`,
			[Symbol.asyncDispose]: mockDispose,
		}));
		const pi = createEventHarness();

		registerCursorSessionAgentLifecycle(pi);
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/test.jsonl");
		const params = {
			apiKey: "test-key",
			agentMode: "agent" as const,
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			createAgent,
		};

		const first = await acquireSessionCursorAgent(params);
		await pi.runSessionBeforeTree();
		const second = await acquireSessionCursorAgent(params);

		expect(first.agent).not.toBe(second.agent);
		expect(createAgent).toHaveBeenCalledTimes(2);
		expect(mockDispose).toHaveBeenCalledTimes(1);
	});

	it("passes only enabled local safety options to Agent.create", async () => {
		const createAgent = vi.fn().mockResolvedValue({
			agentId: "agent-safe",
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/test.jsonl");

		await acquireSessionCursorAgent({
			apiKey: "test-key",
			agentMode: "agent",
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			settingSources: ["all"],
			localSafety: { autoReview: true, sandboxEnabled: true },
			createAgent,
		});

		expect(createAgent).toHaveBeenCalledWith(expect.objectContaining({
			local: expect.objectContaining({
				cwd: "/tmp/project",
				settingSources: ["all"],
				autoReview: true,
				sandboxOptions: { enabled: true },
				store: expect.any(Object),
			}),
		}));
	});

	it("omits disabled local safety options from Agent.create", async () => {
		const createAgent = vi.fn().mockResolvedValue({
			agentId: "agent-default-safe",
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/test.jsonl");

		await acquireSessionCursorAgent({
			apiKey: "test-key",
			agentMode: "agent",
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			localSafety: { autoReview: false, sandboxEnabled: false },
			createAgent,
		});

		expect(createAgent).toHaveBeenCalledWith(expect.objectContaining({
			local: expect.objectContaining({ cwd: "/tmp/project", store: expect.any(Object) }),
		}));
		expect(createAgent.mock.calls[0][0].local).not.toHaveProperty("autoReview");
		expect(createAgent.mock.calls[0][0].local).not.toHaveProperty("sandboxOptions");
	});

	it("reloads the current ready SDK agent without recreating it", async () => {
		const reload = vi.fn().mockResolvedValue(undefined);
		const createAgent = vi.fn().mockResolvedValue({
			agentId: "agent-reload",
			reload,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/test.jsonl");

		await acquireSessionCursorAgent({
			apiKey: "test-key",
			agentMode: "agent",
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			createAgent,
		});

		await expect(sessionAgentTestUtils.refreshSessionCursorAgentConfig("/tmp/sessions/test.jsonl")).resolves.toBe("reloaded");
		expect(reload).toHaveBeenCalledTimes(1);
		expect(createAgent).toHaveBeenCalledTimes(1);
	});

	it("reports no agent or busy instead of creating during config refresh", async () => {
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/test.jsonl");
		await expect(sessionAgentTestUtils.refreshSessionCursorAgentConfig("/tmp/sessions/test.jsonl")).resolves.toBe("no-agent");

		const createAgent = vi.fn().mockResolvedValue({
			agentId: "agent-busy-refresh",
			reload: vi.fn().mockResolvedValue(undefined),
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});
		const lease = await acquireSessionCursorAgent({
			apiKey: "test-key",
			agentMode: "agent",
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			createAgent,
		});
		lease.trackRunCompletion(new Promise(() => {}));

		await expect(sessionAgentTestUtils.refreshSessionCursorAgentConfig("/tmp/sessions/test.jsonl")).resolves.toBe("busy");
		expect(createAgent).toHaveBeenCalledTimes(1);
	});
});
