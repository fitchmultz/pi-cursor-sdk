import type { AgentOptions } from "@cursor/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { acquireSessionCursorAgent, __testUtils as pool } from "../src/cursor-session-agent.js";
import { __testUtils as scope } from "../src/cursor-session-scope.js";
import { __testUtils as resume } from "../src/cursor-session-agent-resume.js";
import { installCursorSessionStoreMock } from "./helpers/cursor-session-store.js";
import { makeContext } from "./helpers/pi-harness.js";

const agents = {
	reviewer: { description: "D", prompt: "private prompt", model: { id: "fixture", params: [{ id: "fast", value: "false" }, { id: "context", value: "large" }] } },
	helper: { description: "H", prompt: "help", model: "inherit" },
} satisfies NonNullable<AgentOptions["agents"]>;

describe("session custom subagent identity", () => {
	beforeEach(async () => {
		installCursorSessionStoreMock();
		scope.reset();
		resume.reset();
		await pool.disposeAllSessionCursorAgents();
		scope.set("/tmp/project", "/tmp/sessions/custom-subagents.jsonl");
	});

	function params() {
		return {
			apiKey: "test-key", cwd: "/tmp/project", agentMode: "agent" as const, modelSelection: { id: "fixture" },
			createAgent: vi.fn().mockImplementation(async () => ({ agentId: "agent-fixture", [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined) })),
		};
	}

	it("reuses reordered equivalent definitions and omits agents by default", async () => {
		const base = params();
		const plain = await acquireSessionCursorAgent(base);
		expect(base.createAgent.mock.calls[0][0]).not.toHaveProperty("agents");
		const configured = await acquireSessionCursorAgent({ ...base, agents });
		expect(base.createAgent.mock.calls[1][0].agents).toEqual(agents);
		const reordered = { helper: { prompt: "help", model: "inherit" as const, description: "H" }, reviewer: {
			model: { params: [{ value: "large", id: "context" }, { value: "false", id: "fast" }], id: "fixture" },
			prompt: "private prompt", description: "D",
		} };
		const reused = await acquireSessionCursorAgent({ ...base, agents: reordered });
		expect(reused.created).toBe(false);
		expect(reused.agent).toBe(configured.agent);
		expect(reused.poolKey).not.toContain("private prompt");
		expect(reused.poolKey).toMatch(/subagents:[a-f0-9]{64}$/);
		const removed = await acquireSessionCursorAgent({ ...base, agents: {} });
		expect(removed.poolKey).toBe(plain.poolKey);
		expect(base.createAgent.mock.calls.at(-1)![0]).not.toHaveProperty("agents");
	});

	it.each([
		["prompt", { ...agents, reviewer: { ...agents.reviewer, prompt: "changed" } }],
		["description", { ...agents, reviewer: { ...agents.reviewer, description: "changed" } }],
		["model", { ...agents, reviewer: { ...agents.reviewer, model: { id: "other" } } }],
		["params", { ...agents, reviewer: { ...agents.reviewer, model: { id: "fixture", params: [{ id: "fast", value: "true" }] } } }],
		["addition", { ...agents, extra: { description: "E", prompt: "P" } }],
		["removal", { reviewer: agents.reviewer }],
		["omitted vs inherit", { ...agents, helper: { description: "H", prompt: "help" } }],
	] satisfies Array<[string, NonNullable<AgentOptions["agents"]>]>)("replaces and disposes on %s changes with fresh send state", async (_change, changed) => {
		const base = params();
		const first = await acquireSessionCursorAgent({ ...base, agents });
		first.commitSend(makeContext(), true);
		const replacement = await acquireSessionCursorAgent({ ...base, agents: changed });
		expect(first.agent[Symbol.asyncDispose]).toHaveBeenCalledOnce();
		expect(replacement.agent).not.toBe(first.agent);
		expect(replacement.poolKey).not.toBe(first.poolKey);
		expect(replacement.sendState).toEqual({ bootstrapped: false, contextFingerprint: "", incrementalSendCount: 0 });
	});
});
