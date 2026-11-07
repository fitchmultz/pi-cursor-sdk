import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { acquireSessionCursorAgent, __testUtils as pool } from "../src/cursor-session-agent.js";
import { registerCursorSessionScope, __testUtils as scope } from "../src/cursor-session-scope.js";
import { registerCursorSessionAgentResume, __testUtils as resume } from "../src/cursor-session-agent-resume.js";
import { createPiHarness, makeAssistantMessage, makeContext } from "./helpers/pi-harness.js";
import { installCursorSessionStoreMock } from "./helpers/cursor-session-store.js";

function agent(agentId: string) {
	return { agentId, [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined) };
}
function params(cwd = "/tmp/project") {
	const createAgent = vi.fn().mockImplementation(async () => agent(`agent-created-${createAgent.mock.calls.length}`));
	return { apiKey: "test-key", cwd, agentMode: "agent" as const, modelSelection: { id: "fixture" }, createAgent,
		resumeAgent: vi.fn().mockImplementation(async (id: string) => agent(id)), localResume: true };
}

describe("MCP-only conversation compatibility", () => {
	beforeEach(async () => {
		installCursorSessionStoreMock();
		await pool.disposeAllSessionCursorAgents();
		scope.reset(); resume.reset();
		scope.set("/tmp/project", "/tmp/sessions/native-tools.jsonl");
	});

	it("keeps default bytes, replaces on policy switches, and reuses the same MCP-only policy", async () => {
		const base = params();
		const plain = await acquireSessionCursorAgent(base);
		const enabled = await acquireSessionCursorAgent({ ...base, nativeToolsEnabled: true });
		expect(enabled.agent).toBe(plain.agent);
		expect(base.createAgent.mock.calls[0][0]).not.toHaveProperty("tools");
		plain.commitSend(makeContext(), true);
		const restricted = await acquireSessionCursorAgent({ ...base, nativeToolsEnabled: false });
		expect(plain.agent[Symbol.asyncDispose]).toHaveBeenCalledOnce();
		expect(restricted.poolKey).toBe(`${plain.poolKey}\0tools:mcp-only`);
		expect(restricted.sendState.bootstrapped).toBe(false);
		expect(base.createAgent.mock.calls[1][0].tools).toEqual(["mcp"]);
		const reused = await acquireSessionCursorAgent({ ...base, nativeToolsEnabled: false });
		expect(reused.agent).toBe(restricted.agent);
		const restored = await acquireSessionCursorAgent(base);
		expect(restricted.agent[Symbol.asyncDispose]).toHaveBeenCalledOnce();
		expect(restored.poolKey).toBe(plain.poolKey);
		expect(base.createAgent.mock.calls[2][0]).not.toHaveProperty("tools");
	});

	it.each([false, true])("persists and resumes policy enabled=%s from real JSONL, refusing the opposite policy", async nativeToolsEnabled => {
		const root = mkdtempSync(join(tmpdir(), "cursor-native-policy-"));
		const base = params(root);
		const options = { ...base, nativeToolsEnabled };
		try {
			let manager = SessionManager.create(root, join(root, "sessions"));
			const pi = createPiHarness();
			pi.appendEntry.mockImplementation((type, data) => { manager.appendCustomEntry(type, data); });
			registerCursorSessionScope(pi); registerCursorSessionAgentResume(pi);
			const context = () => ({ cwd: root, sessionManager: {
				getSessionFile: () => manager.getSessionFile(), getSessionId: () => manager.getSessionId(),
				getBranch: () => manager.getBranch(), getEntries: () => manager.getEntries(),
			} });
			await pi.runSessionStart(context());
			manager.appendMessage({ role: "user", content: "request", timestamp: 1 });
			await pi.runBeforeAgentStart(context());
			const first = await acquireSessionCursorAgent(options);
			first.commitSend(makeContext(), true);
			manager.appendMessage(makeAssistantMessage("answer"));
			await pi.runTurnEnd({}, context());
			const file = manager.getSessionFile()!;
			expect(readFileSync(file, "utf8").includes("tools:mcp-only")).toBe(!nativeToolsEnabled);

			await pool.disposeAllSessionCursorAgents(); resume.reset();
			manager = SessionManager.open(file, join(root, "sessions"), root);
			await pi.runSessionStart(context());
			const samePolicy = await acquireSessionCursorAgent(options);
			expect(samePolicy.resumed).toBe(true);
			expect(base.resumeAgent.mock.calls[0][1].tools).toEqual(nativeToolsEnabled ? undefined : ["mcp"]);
			expect(base.createAgent.mock.calls[0][0].tools).toEqual(base.resumeAgent.mock.calls[0][1].tools);

			await pool.disposeAllSessionCursorAgents(); resume.reset();
			manager = SessionManager.open(file, join(root, "sessions"), root);
			await pi.runSessionStart(context());
			const otherPolicy = await acquireSessionCursorAgent({ ...base, nativeToolsEnabled: !nativeToolsEnabled });
			expect(otherPolicy.resumed).toBe(false);
			expect(base.resumeAgent).toHaveBeenCalledOnce();
			expect(base.createAgent).toHaveBeenCalledTimes(2);
		} finally { await pool.disposeAllSessionCursorAgents(); rmSync(root, { recursive: true, force: true }); }
	});
});
