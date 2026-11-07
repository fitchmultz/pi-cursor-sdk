import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentOptions, SettingSource } from "@cursor/sdk";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import {
	acquireSessionCursorAgent,
	type SessionCursorAgentLease,
	__testUtils as pool,
} from "../src/cursor-session-agent.js";
import { registerCursorSessionScope, __testUtils as scope } from "../src/cursor-session-scope.js";
import {
	CURSOR_SESSION_AGENT_RESUME_ENTRY_TYPE,
	registerCursorSessionAgentResume,
	__testUtils as resume,
} from "../src/cursor-session-agent-resume.js";
import {
	registerCursorPiToolBridge,
	__testUtils as bridges,
	type CursorPiToolBridge,
} from "../src/cursor-pi-tool-bridge.js";
import {
	createBridgePiHarness,
	createPiHarness,
	createTestToolInfo,
	makeAssistantMessage,
	makeContext,
} from "./helpers/pi-harness.js";
import { installCursorSessionStoreMock } from "./helpers/cursor-session-store.js";

const temporaryRoots: string[] = [];

function mockAgent(agentId: string) {
	return { agentId, [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined) };
}

function agentParams(cwd: string, bridge?: CursorPiToolBridge) {
	const settingSources: SettingSource[] = ["all"];
	const createAgent = vi.fn().mockImplementation(async () => mockAgent(`agent-created-${createAgent.mock.calls.length}`));
	return {
		apiKey: "test-key",
		cwd,
		agentMode: "agent" as const,
		modelSelection: { id: "fixture" },
		settingSources,
		bridge,
		createAgent,
		resumeAgent: vi.fn().mockImplementation(async (agentId: string) => mockAgent(agentId)),
		localResume: true,
	};
}

function jsonlSession() {
	const root = mkdtempSync(join(tmpdir(), "cursor-lean-resume-"));
	temporaryRoots.push(root);
	const sessionsDir = join(root, "sessions");
	let manager = SessionManager.create(root, sessionsDir);
	const pi = createPiHarness();
	pi.appendEntry.mockImplementation((type, data) => { manager.appendCustomEntry(type, data); });
	registerCursorSessionScope(pi);
	registerCursorSessionAgentResume(pi);
	const context = () => ({
		cwd: root,
		sessionManager: {
			getSessionFile: () => manager.getSessionFile(),
			getSessionId: () => manager.getSessionId(),
			getBranch: () => manager.getBranch(),
			getEntries: () => manager.getEntries(),
		},
	});
	return {
		root,
		async startTurn() {
			await pi.runSessionStart(context());
			manager.appendMessage({ role: "user", content: "request", timestamp: 1 });
			await pi.runBeforeAgentStart(context());
		},
		async finishTurn(lease: SessionCursorAgentLease) {
			lease.commitSend(makeContext([{ role: "user", content: "request", timestamp: 1 }]), true);
			manager.appendMessage(makeAssistantMessage("answer"));
			await pi.runTurnEnd({}, context());
			const file = manager.getSessionFile();
			if (!file) throw new Error("Expected a persisted Pi session file");
			const records = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
			const handles = records.filter(record => record.type === "custom" && record.customType === CURSOR_SESSION_AGENT_RESUME_ENTRY_TYPE);
			expect(handles).toHaveLength(1);
			expect(handles[0].data).toMatchObject({
				agentId: lease.agent.agentId,
				poolKey: lease.poolKey,
				sendState: lease.sendState,
			});
			return file;
		},
		async reopen(file: string) {
			await pool.disposeAllSessionCursorAgents();
			resume.reset();
			manager = SessionManager.open(file, sessionsDir, root);
			await pi.runSessionStart(context());
		},
	};
}

describe("lean agent options across persisted local resume", () => {
	beforeEach(async () => {
		await pool.disposeAllSessionCursorAgents();
		await bridges.resetRegisteredBridgeForTests();
		scope.reset();
		resume.reset();
		installCursorSessionStoreMock();
		vi.stubEnv("PI_CURSOR_LEAN", "1");
	});

	afterEach(async () => {
		await pool.disposeAllSessionCursorAgents();
		await bridges.resetRegisteredBridgeForTests();
		resume.reset();
		scope.reset();
		for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
		vi.unstubAllEnvs();
	});

	// SDK 1.0.40 AgentOptions documents tools as not persisted: restrictions must
	// be supplied on Agent.resume as well as Agent.create. No real SDK calls run here.
	it.each([
		{ bridgePresent: true, nativeToolsEnabled: true },
		{ bridgePresent: true, nativeToolsEnabled: false },
		{ bridgePresent: false, nativeToolsEnabled: true },
		{ bridgePresent: false, nativeToolsEnabled: false },
	])("forwards lean tools and no settings on create AND resume (bridge=$bridgePresent, native=$nativeToolsEnabled)", async ({ bridgePresent, nativeToolsEnabled }) => {
		const session = jsonlSession();
		const bridge = bridgePresent ? registerCursorPiToolBridge(createBridgePiHarness({
			active: ["proof"],
			tools: [createTestToolInfo("proof", Type.Object({}), "Proof tool")],
		})) : undefined;
		const base = agentParams(session.root, bridge);
		const options = { ...base, nativeToolsEnabled };
		const expectedTools: AgentOptions["tools"] = bridgePresent ? ["mcp"] : [];
		await session.startTurn();
		const first = await acquireSessionCursorAgent(options);
		expect(first.resumed).toBe(false);
		expect(base.createAgent.mock.calls[0][0].tools).toEqual(expectedTools);
		expect(base.createAgent.mock.calls[0][0].local.settingSources).toEqual([]);
		expect(base.createAgent.mock.calls[0][0].mcpServers).toEqual(first.bridgeRun?.mcpServers);
		const file = await session.finishTurn(first);

		await session.reopen(file);
		const reopened = await acquireSessionCursorAgent(options);
		expect(reopened.resumed).toBe(true);
		expect(reopened.poolKey).toBe(first.poolKey);
		expect(reopened.sendState).toEqual(first.sendState);
		expect(base.createAgent).toHaveBeenCalledOnce();
		expect(base.resumeAgent).toHaveBeenCalledOnce();
		expect(base.resumeAgent.mock.calls[0][0]).toBe(first.agent.agentId);
		expect(base.resumeAgent.mock.calls[0][1].tools).toEqual(expectedTools);
		expect(base.resumeAgent.mock.calls[0][1].local.settingSources).toEqual([]);
		expect(base.resumeAgent.mock.calls[0][1].mcpServers).toEqual(reopened.bridgeRun?.mcpServers);
	});

	it("refuses a proven-resumable nonlean JSONL handle when reopening under lean", async () => {
		vi.stubEnv("PI_CURSOR_LEAN", "0");
		const session = jsonlSession();
		const base = agentParams(session.root);
		await session.startTurn();
		const first = await acquireSessionCursorAgent(base);
		expect(base.createAgent.mock.calls[0][0]).not.toHaveProperty("tools");
		expect(base.createAgent.mock.calls[0][0].local.settingSources).toEqual(["all"]);
		const file = await session.finishTurn(first);

		// Prove the exact same durable handle is valid before changing only lean policy.
		await session.reopen(file);
		const samePolicy = await acquireSessionCursorAgent(base);
		expect(samePolicy.resumed).toBe(true);
		expect(base.resumeAgent).toHaveBeenCalledOnce();
		expect(base.resumeAgent.mock.calls[0][0]).toBe(first.agent.agentId);

		vi.stubEnv("PI_CURSOR_LEAN", "1");
		await session.reopen(file);
		const lean = await acquireSessionCursorAgent(base);
		expect(lean.resumed).toBe(false);
		expect(lean.agent.agentId).not.toBe(first.agent.agentId);
		expect(lean.poolKey).not.toBe(first.poolKey);
		expect(lean.sendState.bootstrapped).toBe(false);
		expect(base.resumeAgent).toHaveBeenCalledOnce();
		expect(base.createAgent).toHaveBeenCalledTimes(2);
		expect(base.createAgent.mock.calls[1][0].tools).toEqual([]);
		expect(base.createAgent.mock.calls[1][0].local.settingSources).toEqual([]);
	});
});
