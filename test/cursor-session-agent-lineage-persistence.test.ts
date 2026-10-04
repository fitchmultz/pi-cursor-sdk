import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_SESSION_AGENT_LINEAGE_ENTRY_TYPE,
	parseCursorSessionAgentLineageEntryData,
	registerCursorSessionAgentLineage,
	__testUtils as lineageTestUtils,
} from "../src/cursor-session-agent-lineage.js";
import { registerCursorSessionScope } from "../src/cursor-session-scope.js";
import {
	asMockSdkAgent,
	collectEvents,
	createPiHarness,
	makeContext,
	makeModel,
	mockedCreate,
	resetCursorProviderTestState,
} from "./helpers/cursor-provider-harness.js";
import { streamCursor } from "./helpers/cursor-provider-ownership.js";

function makeAssistantMessage(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "cursor-sdk",
		provider: "cursor",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

describe("cursor-sdk-agent-lineage SessionManager persistence contract", () => {
	let tempDir: string;

	beforeEach(async () => {
		await resetCursorProviderTestState();
		lineageTestUtils.reset();
		tempDir = mkdtempSync(join(tmpdir(), "cursor-lineage-persist-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
		lineageTestUtils.reset();
	});

	it("persists failed-send lineage to JSONL under PI_CURSOR_LOCAL_RESUME=0 and survives SessionManager reopen", async () => {
		const previousResume = process.env.PI_CURSOR_LOCAL_RESUME;
		process.env.PI_CURSOR_LOCAL_RESUME = "0";
		try {
			const sessionId = "lineage-persist-contract";
			const manager = SessionManager.create(tempDir, tempDir, { id: sessionId });
			manager.appendMessage({ role: "user", content: "start", timestamp: 1 });

			const pi = createPiHarness();
			pi.appendEntry.mockImplementation((customType, data) => manager.appendCustomEntry(customType, data));
			registerCursorSessionScope(pi);
			registerCursorSessionAgentLineage(pi);
			await pi.runSessionStart({
				cwd: tempDir,
				sessionManager: {
					getSessionId: () => manager.getSessionId(),
					getSessionFile: () => manager.getSessionFile(),
					getEntries: () => manager.getEntries(),
				},
			});

			const failSend = vi.fn().mockRejectedValue(new Error("send failed after initiate"));
			mockedCreate.mockResolvedValueOnce(asMockSdkAgent({ agentId: "agent-fail-1", send: failSend }));

			await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
			expect(mockedCreate).toHaveBeenCalledTimes(1);
			expect(failSend).toHaveBeenCalledTimes(1);

			// Materialize the session file the same way Pi does after an assistant turn.
			manager.appendMessage(makeAssistantMessage("persist"));
			const sessionFile = manager.getSessionFile();
			expect(sessionFile).toBeTruthy();

			const customLines = readFileSync(sessionFile!, "utf8")
				.split(/\r?\n/)
				.filter(Boolean)
				.map((line) => JSON.parse(line) as { type?: string; customType?: string; data?: unknown })
				.filter((entry) => entry.type === "custom" && entry.customType === CURSOR_SESSION_AGENT_LINEAGE_ENTRY_TYPE);
			expect(customLines).toHaveLength(1);
			expect(parseCursorSessionAgentLineageEntryData(customLines[0]?.data)).toMatchObject({
				agentId: "agent-fail-1",
				sessionId,
				runtime: "local",
			});

			lineageTestUtils.reset();
			const reopened = SessionManager.open(sessionFile!);
			const reopenedEntry = reopened
				.getEntries()
				.find((entry) => entry.type === "custom" && entry.customType === CURSOR_SESSION_AGENT_LINEAGE_ENTRY_TYPE);
			expect(reopenedEntry?.type).toBe("custom");
			if (!reopenedEntry || reopenedEntry.type !== "custom") throw new Error("expected lineage custom entry after reopen");
			expect(parseCursorSessionAgentLineageEntryData(reopenedEntry.data)).toMatchObject({
				agentId: "agent-fail-1",
				sessionId,
				runtime: "local",
			});
			expect(process.env.PI_CURSOR_LOCAL_RESUME).toBe("0");
		} finally {
			if (previousResume === undefined) delete process.env.PI_CURSOR_LOCAL_RESUME;
			else process.env.PI_CURSOR_LOCAL_RESUME = previousResume;
		}
	});
});
