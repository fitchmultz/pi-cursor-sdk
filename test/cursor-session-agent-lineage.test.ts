import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_SESSION_AGENT_LINEAGE_ENTRY_TYPE,
	parseCursorSessionAgentLineageEntryData,
	queueCursorSessionAgentLineage,
	registerCursorSessionAgentLineage,
	__testUtils as lineageTestUtils,
	type CursorSessionAgentLineageEntryData,
} from "../src/cursor-session-agent-lineage.js";
import {
	CURSOR_SESSION_AGENT_RESUME_ENTRY_TYPE,
	persistCursorSessionAgentResumeHandle,
	registerCursorSessionAgentResume,
	__testUtils as resumeTestUtils,
} from "../src/cursor-session-agent-resume.js";
import { registerCursorSessionScope, __testUtils as scopeTestUtils } from "../src/cursor-session-scope.js";
import { createPiHarness, type PiHarness } from "./helpers/pi-harness.js";

function lineageEntry(id: string, data: unknown, parentId: string | null = null): SessionEntry {
	return {
		type: "custom",
		id,
		parentId,
		timestamp: "2026-07-23T00:00:00.000Z",
		customType: CURSOR_SESSION_AGENT_LINEAGE_ENTRY_TYPE,
		data,
	};
}

function validData(overrides: Partial<CursorSessionAgentLineageEntryData> = {}): CursorSessionAgentLineageEntryData {
	return {
		version: 1,
		runtime: "local",
		agentId: "agent-1",
		sessionId: "session-1",
		sessionFile: "/tmp/session.jsonl",
		scopeKey: "/tmp/session.jsonl",
		cwd: "/tmp/project",
		timestamp: "2026-07-23T00:00:00.000Z",
		...overrides,
	};
}

describe("cursor-session-agent-lineage", () => {
	beforeEach(() => {
		scopeTestUtils.reset();
		lineageTestUtils.reset();
		resumeTestUtils.reset();
		vi.clearAllMocks();
	});

	it("ignores malformed lineage entries conservatively", () => {
		expect(parseCursorSessionAgentLineageEntryData(validData())).toEqual(validData());
		for (const malformed of [
			undefined,
			{ ...validData(), version: 2 },
			{ ...validData(), runtime: "cloud" },
			{ ...validData(), agentId: "bc-cloud" },
			{ ...validData(), sessionId: "" },
			{ ...validData(), sessionFile: 42 },
			{ ...validData(), scopeKey: "" },
			{ ...validData(), cwd: "" },
			{ ...validData(), timestamp: "not-a-date" },
		]) {
			expect(parseCursorSessionAgentLineageEntryData(malformed)).toBeUndefined();
		}
	});

	it("appends queued local agents at turn_end with native session scope and deduplicates them", async () => {
		const pi = createPiHarness();
		registerCursorSessionScope(pi);
		registerCursorSessionAgentLineage(pi);
		await pi.runSessionStart({
			cwd: "/tmp/project",
			sessionManager: {
				getSessionId: vi.fn(() => "session-1"),
				getSessionFile: vi.fn(() => "/tmp/session.jsonl"),
				getEntries: vi.fn(() => []),
			},
		});

		queueCursorSessionAgentLineage("agent-1");
		queueCursorSessionAgentLineage("agent-1");
		await pi.runTurnEnd();

		expect(pi.appendEntry).toHaveBeenCalledTimes(1);
		expect(pi.appendEntry).toHaveBeenCalledWith(CURSOR_SESSION_AGENT_LINEAGE_ENTRY_TYPE, {
			version: 1,
			runtime: "local",
			agentId: "agent-1",
			sessionId: "session-1",
			sessionFile: "/tmp/session.jsonl",
			scopeKey: "/tmp/session.jsonl",
			cwd: "/tmp/project",
			timestamp: expect.any(String),
		});

		queueCursorSessionAgentLineage("agent-1");
		await pi.runTurnEnd();
		expect(pi.appendEntry).toHaveBeenCalledTimes(1);
	});

	it.each([
		["session_compact", (pi: PiHarness) => pi.runSessionCompact()],
		["session_tree", (pi: PiHarness) => pi.runSessionTree()],
		["session_shutdown", (pi: PiHarness) => pi.runSessionShutdown()],
	])("flushes queued agents on %s without waiting for a later turn", async (_event, flush) => {
		const pi = createPiHarness();
		registerCursorSessionScope(pi);
		registerCursorSessionAgentLineage(pi);
		await pi.runSessionStart({
			cwd: "/tmp/project",
			sessionManager: {
				getSessionId: vi.fn(() => "session-1"),
				getSessionFile: vi.fn(() => "/tmp/session.jsonl"),
				getEntries: vi.fn(() => []),
			},
		});

		queueCursorSessionAgentLineage("agent-1");
		await flush(pi);

		expect(pi.appendEntry).toHaveBeenCalledTimes(1);
		expect(pi.appendEntry).toHaveBeenCalledWith(
			CURSOR_SESSION_AGENT_LINEAGE_ENTRY_TYPE,
			expect.objectContaining({ agentId: "agent-1", sessionId: "session-1" }),
		);

		await pi.runTurnEnd();
		expect(pi.appendEntry).toHaveBeenCalledTimes(1);
	});

	it("appends after the existing resume turn_end handler", async () => {
		const pi = createPiHarness();
		registerCursorSessionScope(pi);
		registerCursorSessionAgentResume(pi);
		registerCursorSessionAgentLineage(pi);
		await pi.runSessionStart({
			cwd: "/tmp/project",
			sessionManager: {
				getSessionId: vi.fn(() => "session-1"),
				getSessionFile: vi.fn(() => "/tmp/session.jsonl"),
				getBranch: vi.fn(() => []),
				getEntries: vi.fn(() => []),
			},
		});
		pi.appendEntry.mockClear();
		persistCursorSessionAgentResumeHandle({
			runtime: "local",
			agentId: "agent-1",
			poolKey: "pool-1",
			sendState: { bootstrapped: true, contextFingerprint: "fp", incrementalSendCount: 0 },
			storeIdentity: { version: 1, stateRoot: "/tmp/store" },
		});
		queueCursorSessionAgentLineage("agent-1");

		await pi.runTurnEnd({}, { sessionManager: { getBranch: vi.fn(() => []) } });

		expect(pi.appendEntry.mock.calls.map(([customType]) => customType)).toEqual([
			CURSOR_SESSION_AGENT_RESUME_ENTRY_TYPE,
			CURSOR_SESSION_AGENT_LINEAGE_ENTRY_TYPE,
		]);
	});

	it("deduplicates across restarts only within the same native pi session", async () => {
		const donor = lineageEntry("lineage-donor", validData({ sessionId: "donor-session" }));
		const own = lineageEntry("lineage-own", validData({ agentId: "agent-own", sessionId: "clone-session" }), "lineage-donor");
		const pi = createPiHarness();
		registerCursorSessionScope(pi);
		registerCursorSessionAgentLineage(pi);
		await pi.runSessionStart({
			cwd: "/tmp/project",
			sessionManager: {
				getSessionId: vi.fn(() => "clone-session"),
				getSessionFile: vi.fn(() => "/tmp/clone.jsonl"),
				getEntries: vi.fn(() => [donor, own]),
			},
		});

		queueCursorSessionAgentLineage("agent-own");
		queueCursorSessionAgentLineage("agent-1");
		await pi.runTurnEnd();

		expect(pi.appendEntry).toHaveBeenCalledTimes(1);
		expect(pi.appendEntry).toHaveBeenCalledWith(
			CURSOR_SESSION_AGENT_LINEAGE_ENTRY_TYPE,
			expect.objectContaining({ agentId: "agent-1", sessionId: "clone-session" }),
		);
	});

	it("drops append failures without affecting later lineage records", async () => {
		const pi = createPiHarness();
		registerCursorSessionScope(pi);
		registerCursorSessionAgentLineage(pi);
		await pi.runSessionStart({
			cwd: "/tmp/project",
			sessionManager: {
				getSessionId: vi.fn(() => "session-1"),
				getSessionFile: vi.fn(() => undefined),
				getEntries: vi.fn(() => []),
			},
		});
		pi.appendEntry.mockImplementationOnce(() => { throw new Error("disk full"); });

		queueCursorSessionAgentLineage("agent-1");
		await expect(pi.runTurnEnd()).resolves.toBeUndefined();
		queueCursorSessionAgentLineage("agent-2");
		await expect(pi.runTurnEnd()).resolves.toBeUndefined();

		expect(pi.appendEntry).toHaveBeenCalledTimes(2);
		expect(pi.appendEntry).toHaveBeenLastCalledWith(
			CURSOR_SESSION_AGENT_LINEAGE_ENTRY_TYPE,
			expect.objectContaining({ agentId: "agent-2", sessionId: "session-1" }),
		);
	});
});
