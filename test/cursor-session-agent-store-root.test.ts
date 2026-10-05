import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireSessionCursorAgent, __testUtils as agents } from "../src/cursor-session-agent.js";
import { __testUtils as scopes } from "../src/cursor-session-scope.js";
import { __testUtils as resume } from "../src/cursor-session-agent-resume.js";
import { __testUtils as stores } from "../src/cursor-session-store.js";
import { installCursorSessionStoreMock } from "./helpers/cursor-session-store.js";
import { makeContext } from "./helpers/pi-harness.js";

describe("captured session-agent storage compatibility", () => {
	let root: string;
	let scopeKey: string;
	beforeEach(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "cursor-agent-root-")));
		scopeKey = join(root, "session.jsonl");
		scopes.reset();
		resume.reset();
		scopes.set(root, scopeKey);
		installCursorSessionStoreMock(() => join(root, "default"));
	});
	afterEach(async () => {
		await agents.disposeAllSessionCursorAgents();
		stores.setSdkOperations(undefined);
		rmSync(root, { recursive: true, force: true });
	});
	function params() {
		let number = 0;
		return {
			apiKey: "test-key", agentMode: "agent" as const, cwd: root, modelSelection: { id: "composer-2.5" },
			createAgent: vi.fn().mockImplementation(async () => ({ agentId: `agent-${++number}`, [Symbol.asyncDispose]: vi.fn(async () => {}) })),
			resumeAgent: vi.fn().mockImplementation(async () => ({ agentId: "agent-recorded", [Symbol.asyncDispose]: vi.fn(async () => {}) })),
		};
	}

	it.each([false, true])("repools default/A/B storage without changing pool-key bytes (resume enabled=%s)", async (localResume) => {
		const options = { ...params(), localResume };
		const first = await acquireSessionCursorAgent(options);
		const a = await acquireSessionCursorAgent({ ...options, storeRoot: join(root, "A") });
		const reused = await acquireSessionCursorAgent({ ...options, storeRoot: join(root, "A") });
		expect(reused.agent).toBe(a.agent);
		const b = await acquireSessionCursorAgent({ ...options, storeRoot: join(root, "B") });
		const back = await acquireSessionCursorAgent(options);
		expect([a, b, back].map(entry => entry.poolKey)).toEqual([first.poolKey, first.poolKey, first.poolKey]);
		expect(options.createAgent).toHaveBeenCalledTimes(4);
		for (const old of [first, a, b]) expect(old.agent[Symbol.asyncDispose]).toHaveBeenCalledOnce();
		expect([a, b, back].every(entry => !entry.sendState.bootstrapped)).toBe(true);
		expect(a.storeIdentity.stateRoot).not.toBe(b.storeIdentity.stateRoot);
	});

	it.each(["same", "other", "v1"] as const)("admits only recorded current custom storage on restart (%s)", async (kind) => {
		const options = { ...params(), localResume: true, storeRoot: join(root, "B") };
		const original = await acquireSessionCursorAgent(options);
		original.commitSend(makeContext(), true);
		await agents.resetSessionCursorAgent(scopeKey);
		resume.set({ scopeKey, sessionFile: scopeKey, cwd: root, branchPathHash: resume.EMPTY_BRANCH_HASH, compactionGeneration: 0,
			activeHandle: {
				version: kind === "v1" ? 1 : 2, runtime: "local", agentId: "agent-recorded", scopeKey, sessionFile: scopeKey, cwd: root,
				poolKey: original.poolKey, branchPathHash: resume.EMPTY_BRANCH_HASH, compactionGeneration: 0,
				sendState: { bootstrapped: true, contextFingerprint: "saved", incrementalSendCount: 2 }, createdAt: "2026-10-05T00:00:00Z",
				...(kind === "v1" ? {} : { storeIdentity: kind === "same" ? original.storeIdentity : { version: 1 as const, stateRoot: join(root, "A", "other") } }),
			},
		});
		const next = await acquireSessionCursorAgent(options);
		expect(next.resumed).toBe(kind === "same");
		expect(options.resumeAgent).toHaveBeenCalledTimes(kind === "same" ? 1 : 0);
		if (kind !== "same") {
			expect(next.resumeNotice).toContain("current pi transcript");
			expect(next.sendState.bootstrapped).toBe(false);
			expect((await acquireSessionCursorAgent(options)).resumeNotice).toBeUndefined();
		}
	});

	it.each(["creating", "busy"] as const)("an A %s waiter cannot lease B's same-key replacement", async (phase) => {
		const options = params();
		let finish: (value?: unknown) => void = () => {};
		const held = new Promise(resolve => { finish = resolve; });
		const lateDispose = vi.fn(async () => {});
		if (phase === "creating") options.createAgent.mockImplementationOnce(async () => {
			await held;
			return { agentId: "late-A", [Symbol.asyncDispose]: lateDispose };
		});
		const a = acquireSessionCursorAgent({ ...options, storeRoot: join(root, "A") });
		let waiting = a;
		if (phase === "busy") {
			const acquired = await a;
			acquired.trackRunCompletion(held);
			waiting = acquireSessionCursorAgent({ ...options, storeRoot: join(root, "A") });
		}
		const observed = waiting.catch(error => error);
		await vi.waitFor(() => expect(options.createAgent).toHaveBeenCalledTimes(1));
		const b = await acquireSessionCursorAgent({ ...options, storeRoot: join(root, "B") });
		finish();
		const outcome = await observed;
		if (phase === "creating") {
			expect(outcome).toBeInstanceOf(agents.SessionCursorAgentCreationSupersededError);
			expect(lateDispose).toHaveBeenCalledOnce();
		} else {
			// Competing acquisitions may supersede A again; neither result may adopt B.
			if (outcome instanceof Error) expect(outcome).toBeInstanceOf(agents.SessionCursorAgentCreationSupersededError);
			else expect(outcome.storeIdentity.stateRoot).not.toBe(b.storeIdentity.stateRoot);
		}
	});

	it("captures fileless persistence before delayed open even when config/scope become persistent", async () => {
		const mock = installCursorSessionStoreMock(() => { throw new Error("fileless must not derive persistent root"); });
		const originalOpen = mock.openSqliteStore.getMockImplementation()!;
		let release: () => void = () => {};
		mock.openSqliteStore.mockImplementationOnce(async options => {
			await new Promise<void>(resolve => { release = resolve; });
			return originalOpen(options);
		});
		scopes.set(root, undefined, "fileless");
		const options = { ...params(), storeRoot: "unusable-relative" };
		const pending = acquireSessionCursorAgent(options);
		await vi.waitFor(() => expect(mock.openSqliteStore).toHaveBeenCalledOnce());
		scopes.set(root, scopeKey);
		options.storeRoot = join(root, "now-persistent");
		release();
		const lease = await pending;
		expect(lease.storeIdentity.stateRoot).not.toContain("now-persistent");
		await agents.resetSessionCursorAgent(lease.scopeKey);
		expect(mock.stores[0].dispose).toHaveBeenCalledOnce();
	});
});
