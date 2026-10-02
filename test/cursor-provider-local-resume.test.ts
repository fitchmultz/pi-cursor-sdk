import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	asMockCursorRun,
	asMockSdkAgent,
	collectEvents,
	collectThinkingDeltas,
	createTestToolInfo,
	getDoneEvent,
	makeAssistantMessage,
	makeContext,
	makeModel,
	mockCreatedAgent,
	mockedCreate,
	mockedResume,
	registerBridgeForProviderTest,
	registerNativeToolDisplayForTest,
	resetCursorProviderTestState,
} from "./helpers/cursor-provider-harness.js";
import { streamCursor } from "../src/cursor-provider.js";
import { __testUtils as cursorSessionScopeTestUtils } from "../src/cursor-session-scope.js";
import { __testUtils as cursorSessionAgentTestUtils } from "../src/cursor-session-agent.js";
import { __testUtils as resumeTestUtils } from "../src/cursor-session-agent-resume.js";
import { computeCursorContextFingerprint } from "../src/context.js";
import { buildCursorModelSelection } from "../src/model-discovery.js";

describe("streamCursor local resume", () => {
	beforeEach(resetCursorProviderTestState);

	function seedResumeHandle(
		scopeKey: string,
		contextFingerprint = "{}",
		agentId = "agent-old",
		incrementalSendCount = 0,
	): void {
		cursorSessionScopeTestUtils.set(process.cwd(), scopeKey);
		const modelSelection = buildCursorModelSelection("gpt-5.5@1m", "off", false);
		const poolKey = cursorSessionAgentTestUtils.buildSessionAgentPoolKey(scopeKey, {
			apiKey: "test-key",
			agentMode: "agent",
			cwd: process.cwd(),
			modelSelection,
			settingSources: ["all"],
			localSafety: { autoReview: false, sandboxEnabled: false },
			localResume: true,
		});
		resumeTestUtils.set({
			scopeKey,
			sessionFile: scopeKey,
			cwd: process.cwd(),
			branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
			compactionGeneration: 0,
			activeHandle: {
				version: 1,
				runtime: "local",
				agentId,
				scopeKey,
				sessionFile: scopeKey,
				cwd: process.cwd(),
				poolKey,
				branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
				compactionGeneration: 0,
				sendState: { bootstrapped: true, contextFingerprint, incrementalSendCount },
				createdAt: "2026-07-07T00:00:00.000Z",
			},
		});
	}

	it("resumes with current bridge MCP and bootstraps the current Pi transcript", async () => {
		process.env.PI_CURSOR_LOCAL_RESUME = "1";
		registerBridgeForProviderTest({
			active: ["mcp", "subagent"],
			tools: [
				createTestToolInfo("mcp", Type.Object({}), "Call an MCP server"),
				createTestToolInfo("subagent", Type.Object({}), "Delegate to a pi subagent"),
			],
		});
		const priorContext = makeContext();
		const resumedContext = makeContext([
			...priorContext.messages,
			makeAssistantMessage("Prior answer"),
			{ role: "user", content: "Follow up", timestamp: 3 },
		]);
		const mockSend = vi.fn().mockImplementation(async (message: { text?: string }) =>
			asMockCursorRun({
				id: "run-resumed",
				agentId: "agent-old",
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-resumed", status: "finished", result: message.text ?? "" }),
			}),
		);
		mockedResume.mockResolvedValueOnce(asMockSdkAgent({ agentId: "agent-old", send: mockSend }));
		seedResumeHandle("/tmp/resume-bridge-session.jsonl", computeCursorContextFingerprint(priorContext));

		await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), resumedContext, { apiKey: "test-key" }));

		expect(mockedCreate).not.toHaveBeenCalled();
		expect(mockedResume).toHaveBeenCalledTimes(1);
		expect(mockedResume.mock.calls[0]?.[0]).toBe("agent-old");
		expect(mockedResume.mock.calls[0]?.[1]).toMatchObject({
			mcpServers: { pi_tools: { type: "http" } },
		});
		const prompt = mockSend.mock.calls[0]?.[0] as { text?: string };
		expect(prompt.text).toContain("User: Follow up");
		expect(prompt.text).toContain("User: Hello");
		expect(prompt.text).toContain("prefer pi__todo for todos and pi__subagent_spawn for delegation");
	});

	it.each([
		{ reason: "incremental_threshold", fingerprint: (context: ReturnType<typeof makeContext>) => computeCursorContextFingerprint(context), count: 20 },
		{ reason: "context_divergence", fingerprint: () => "stale-context", count: 0 },
	])("replaces a resumed agent with Agent.create for $reason while preserving resume persistence", async ({ fingerprint, count }) => {
		process.env.PI_CURSOR_LOCAL_RESUME = "1";
		const context = makeContext();
		const oldDispose = vi.fn().mockResolvedValue(undefined);
		mockedResume.mockResolvedValueOnce(asMockSdkAgent({
			agentId: "agent-old",
			send: vi.fn(),
			[Symbol.asyncDispose]: oldDispose,
		}));
		const newSend = vi.fn().mockResolvedValue(asMockCursorRun({
			id: "run-new",
			agentId: "agent-new",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-new", status: "finished", result: "done" }),
		}));
		mockCreatedAgent({ agentId: "agent-new", send: newSend });
		seedResumeHandle(`/tmp/reset-${count}.jsonl`, fingerprint(context), "agent-old", count);

		await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), context, { apiKey: "test-key" }));

		expect(mockedResume).toHaveBeenCalledTimes(1);
		expect(oldDispose).toHaveBeenCalledTimes(1);
		expect(mockedCreate).toHaveBeenCalledTimes(1);
		expect(newSend).toHaveBeenCalledTimes(1);
		expect(resumeTestUtils.state.pendingHandle).toMatchObject({ agentId: "agent-new" });
	});

	it("does not pass a crafted cloud agent ID to local Agent.resume", async () => {
		process.env.PI_CURSOR_LOCAL_RESUME = "1";
		mockCreatedAgent({
			agentId: "agent-new",
			send: vi.fn().mockResolvedValue(asMockCursorRun({
				id: "run-new",
				agentId: "agent-new",
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-new", status: "finished", result: "done" }),
			})),
		});
		seedResumeHandle("/tmp/reject-cloud-resume-session.jsonl", "{}", "bc-cloud-agent");

		await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), { apiKey: "test-key" }));

		expect(mockedResume).not.toHaveBeenCalled();
		expect(mockedCreate).toHaveBeenCalledTimes(1);
	});

	it("falls back from local Agent.resume with a display-only continuity note", async () => {
		process.env.PI_CURSOR_LOCAL_RESUME = "1";
		const mockSend = vi.fn().mockResolvedValue({
			id: "run-1",
			agentId: "agent-new",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "done" }),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		});
		mockedResume.mockRejectedValueOnce(new Error("Agent agent-old not found"));
		mockCreatedAgent({ agentId: "agent-new", send: mockSend });
		seedResumeHandle("/tmp/resume-session.jsonl");

		const events = await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), { apiKey: "test-key" }));
		const followUpEvents = await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), { apiKey: "test-key" }));

		expect(mockedResume).toHaveBeenCalledTimes(1);
		expect(mockedCreate).toHaveBeenCalledTimes(1);
		expect(collectThinkingDeltas(events)).toContain("Could not resume prior Cursor agent");
		expect(JSON.stringify(getDoneEvent(events).message.content)).not.toContain("Could not resume prior Cursor agent");
		expect(collectThinkingDeltas(followUpEvents)).not.toContain("Could not resume prior Cursor agent");
	});

	it("emits the resume fallback continuity note on the live native replay path", async () => {
		process.env.PI_CURSOR_LOCAL_RESUME = "1";
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		await registerNativeToolDisplayForTest([]);
		const mockSend = vi.fn().mockResolvedValue({
			id: "run-1",
			agentId: "agent-new",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "done" }),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		});
		mockedResume.mockRejectedValueOnce(new Error("Agent agent-old not found"));
		mockCreatedAgent({ agentId: "agent-new", send: mockSend });
		seedResumeHandle("/tmp/resume-live-session.jsonl");

		const events = await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), { apiKey: "test-key" }));

		expect(collectThinkingDeltas(events)).toContain("Could not resume prior Cursor agent");
		expect(JSON.stringify(getDoneEvent(events).message.content)).not.toContain("Could not resume prior Cursor agent");
	});
});
