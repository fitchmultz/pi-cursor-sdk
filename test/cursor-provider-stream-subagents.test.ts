import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	resetCursorProviderTestState, mockedCreate, mockCreatedAgent, makeContext, makeModel, collectEvents,
	registerBridgeForProviderTest, createTestToolInfo,
} from "./helpers/cursor-provider-harness.js";
import { streamCursor } from "./helpers/cursor-provider-ownership.js";
import { __testUtils as scope } from "../src/cursor-session-scope.js";
import { __testUtils as discovery } from "../src/model-discovery.js";

describe("custom subagent config to ordinary provider turns", () => {
	beforeEach(resetCursorProviderTestState);

	it.each([false, true])("honors captured project trust=%s, independent child selections and next-turn file edits", async (trusted) => {
		const root = mkdtempSync(join(tmpdir(), "cursor-provider-subagents-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "repo");
		const previous = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		mkdirSync(agentDir);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		const userPath = join(agentDir, "cursor-sdk.json");
		const projectPath = join(cwd, ".pi", "cursor-sdk.json");
		const entry = { description: "Review", prompt: "private child instructions", model: "fixture:slow", thinking: "high", fast: true };
		writeFileSync(userPath, JSON.stringify({ fastDefaults: { fixture: true }, subagents: { user: entry } }));
		writeFileSync(projectPath, JSON.stringify({ subagents: { project: entry } }));
		scope.set(cwd, join(root, "session.jsonl"), "test-session", trusted);
		discovery.registerModelItems([{
			id: "fixture", displayName: "Fixture", parameters: [
				{ id: "fast", displayName: "Fast", values: [{ value: "true" }, { value: "false" }] },
				{ id: "reasoning", displayName: "Reasoning", values: [{ value: "none" }, { value: "high" }] },
			], variants: [{ displayName: "Fixture", isDefault: true, params: [{ id: "fast", value: "true" }, { id: "reasoning", value: "none" }] }],
		}]);
		registerBridgeForProviderTest({ active: ["subagent"], tools: [createTestToolInfo("subagent", Type.Object({ task: Type.String() }), "Pi delegation")] });
		const send = vi.fn().mockResolvedValue({
			id: "run-1", agentId: "agent-1", status: "finished", wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "done" }),
			cancel: vi.fn(), supports: () => true, unsupportedReason: () => undefined,
		});
		mockCreatedAgent({ send });
		try {
			const events = await collectEvents(streamCursor(makeModel("fixture:fast"), makeContext(), { apiKey: "test-key" }));
			expect(events.at(-1)?.type, JSON.stringify(events.at(-1))).toBe("done");
			const name = trusted ? "project" : "user";
			expect(mockedCreate.mock.calls[0][0].agents).toEqual({ [name]: {
				description: "Review", prompt: "private child instructions", model: { id: "fixture", params: [
					{ id: "fast", value: "false" }, { id: "reasoning", value: "high" },
				] },
			} });
			expect(mockedCreate.mock.calls[0][0].model).toEqual({ id: "fixture", params: [{ id: "fast", value: "true" }, { id: "reasoning", value: "none" }] });
			expect(send.mock.calls[0][0].text).toContain("prefer pi__mcp for MCP work and pi__subagent for delegation");
			expect(send.mock.calls[0][0].text).not.toContain("private child instructions");
			const divergent = { ...makeContext(), systemPrompt: "Updated parent context" };
			await collectEvents(streamCursor(makeModel("fixture:fast"), divergent, { apiKey: "test-key" }));
			expect(mockedCreate).toHaveBeenCalledTimes(2);
			expect(mockedCreate.mock.calls[1][0].agents).toEqual(mockedCreate.mock.calls[0][0].agents);
			writeFileSync(trusted ? projectPath : userPath, JSON.stringify({ subagents: { [name]: { ...entry, prompt: "updated instructions" } } }));
			await collectEvents(streamCursor(makeModel("fixture:fast"), divergent, { apiKey: "test-key" }));
			expect(mockedCreate).toHaveBeenCalledTimes(3);
			expect(mockedCreate.mock.calls[2][0].agents?.[name]?.prompt).toBe("updated instructions");
		} finally {
			await resetCursorProviderTestState();
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("passes configured definitions through the offline cloud prepare branch", async () => {
		const root = mkdtempSync(join(tmpdir(), "cursor-cloud-subagents-"));
		const previous = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = root;
		process.env.PI_CURSOR_RUNTIME = "cloud";
		process.env.PI_CURSOR_CLOUD_ACK = "1";
		process.env.PI_CURSOR_CLOUD_ALLOW_LOCAL_STATE = "1";
		writeFileSync(join(root, "cursor-sdk.json"), JSON.stringify({ subagents: { reviewer: { description: "D", prompt: "P", model: "inherit" } } }));
		mockCreatedAgent({ agentId: "bc-00000000-0000-0000-0000-000000000001", send: vi.fn().mockResolvedValue({
			id: "run-1", agentId: "bc-00000000-0000-0000-0000-000000000001", status: "finished", wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "done" }),
			cancel: vi.fn(), supports: () => true, unsupportedReason: () => undefined,
		}) });
		try {
			const events = await collectEvents(streamCursor(makeModel("fixture"), makeContext(), { apiKey: "test-key" }));
			expect(events.at(-1)?.type, JSON.stringify(events.at(-1))).toBe("done");
			expect(mockedCreate.mock.calls[0][0].agents).toEqual({ reviewer: { description: "D", prompt: "P", model: "inherit" } });
			expect(mockedCreate.mock.calls[0][0]).not.toHaveProperty("mcpServers");
		} finally {
			await resetCursorProviderTestState();
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
			rmSync(root, { recursive: true, force: true });
		}
	});
});
