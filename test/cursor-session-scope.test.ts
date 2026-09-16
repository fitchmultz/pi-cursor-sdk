import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	__testUtils as cursorSessionScopeTestUtils,
	associateCursorSessionScopeSignal,
	getCursorSessionCwd,
	getCursorSessionName,
	getCursorSessionProjectTrusted,
	getCursorSessionScope,
	MAX_CURSOR_SESSION_NAME_LENGTH,
	registerCursorSessionScope,
	releaseCursorSessionScope,
	resolveCursorSessionScope,
} from "../src/cursor-session-scope.js";
import { createEventHarness, createExtensionTestContext } from "./helpers/pi-harness.js";

describe("cursor-session-scope cwd", () => {
	afterEach(() => {
		cursorSessionScopeTestUtils.reset();
	});

	it("falls back to process.cwd() before session_start", () => {
		expect(getCursorSessionCwd()).toBe(process.cwd());
	});

	it("syncs cwd from session_start", async () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "pi-cursor-session-cwd-"));
		try {
			const pi = createEventHarness();
			registerCursorSessionScope(pi);
			await pi.runSessionStart({ cwd: sessionDir });

			expect(getCursorSessionCwd()).toBe(sessionDir);
		} finally {
			rmSync(sessionDir, { recursive: true, force: true });
		}
	});

	it("snapshots trust only from Pi trust-resolution provenance", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-cursor-session-trust-"));
		try {
			mkdirSync(join(cwd, ".pi"));
			writeFileSync(join(cwd, ".pi", "cursor-sdk.json"), '{"runtime":"cloud"}\n');
			const pi = createEventHarness();
			registerCursorSessionScope(pi);

			await pi.runSessionStart({ cwd, isProjectTrusted: vi.fn(() => true) });
			expect(getCursorSessionProjectTrusted()).toBe(false);

			writeFileSync(join(cwd, ".pi", "settings.json"), "{}\n");
			expect(getCursorSessionProjectTrusted()).toBe(false);

			cursorSessionScopeTestUtils.recordProjectTrustResolution(cwd);
			await pi.runSessionStart({ cwd, isProjectTrusted: vi.fn(() => true) });
			expect(getCursorSessionProjectTrusted()).toBe(true);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("uses Pi argument-consumption semantics for explicit CLI trust", () => {
		expect(cursorSessionScopeTestUtils.isCliProjectTrustApproved(["--approve"])).toBe(true);
		expect(cursorSessionScopeTestUtils.isCliProjectTrustApproved(["-a", "--no-approve"])).toBe(false);
		expect(cursorSessionScopeTestUtils.isCliProjectTrustApproved(["--no-approve", "-a"])).toBe(true);
		expect(cursorSessionScopeTestUtils.isCliProjectTrustApproved(["--name", "-a"])).toBe(false);
		expect(cursorSessionScopeTestUtils.isCliProjectTrustApproved(["--model", "--approve"])).toBe(false);
		expect(cursorSessionScopeTestUtils.isCliProjectTrustApproved([])).toBe(false);
	});

	it("syncs the normalized session name from session_start", async () => {
		const pi = createEventHarness();
		registerCursorSessionScope(pi);

		await pi.runSessionStart({ sessionManager: { getSessionName: vi.fn(() => "  Cloud handoff  ") } });

		expect(getCursorSessionName()).toBe("Cloud handoff");
	});

	it("updates the normalized session name when session metadata changes", async () => {
		const pi = createEventHarness();
		registerCursorSessionScope(pi);
		await pi.runSessionStart({ sessionManager: { getSessionName: vi.fn(() => "Initial") } });

		await pi.invokeEvent("session_info_changed", {
			type: "session_info_changed",
			name: "  Renamed\tsession\u001bwith\0controls\u0085  ",
		});
		expect(getCursorSessionName()).toBe("Renamed session with controls");

		await pi.invokeEvent("session_info_changed", { type: "session_info_changed", name: " \t\u001b\0 " });
		expect(getCursorSessionName()).toBeUndefined();
	});

	it("bounds session names before exposing them to provider callers", async () => {
		const pi = createEventHarness();
		registerCursorSessionScope(pi);
		await pi.runSessionStart({
			sessionManager: { getSessionName: vi.fn(() => "x".repeat(MAX_CURSOR_SESSION_NAME_LENGTH + 20)) },
		});

		expect(MAX_CURSOR_SESSION_NAME_LENGTH).toBe(100);
		expect(getCursorSessionName()).toHaveLength(MAX_CURSOR_SESSION_NAME_LENGTH);
		expect(getCursorSessionName()?.endsWith("…")).toBe(true);
	});

	it("resolves concurrent sessions by Pi session ID and event signal", async () => {
		const parent = createEventHarness();
		const child = createEventHarness();
		registerCursorSessionScope(parent);
		registerCursorSessionScope(child);
		await parent.runSessionStart({
			cwd: "/tmp/parent",
			sessionManager: {
				getSessionId: () => "parent-session",
				getSessionFile: () => "/tmp/parent.jsonl",
			},
		});
		await child.runSessionStart({
			cwd: "/tmp/child",
			sessionManager: {
				getSessionId: () => "child-session",
				getSessionFile: () => "/tmp/child.jsonl",
			},
		});

		const parentScope = resolveCursorSessionScope({ sessionId: "parent-session" });
		expect(parentScope).toMatchObject({ cwd: "/tmp/parent", scopeKey: "/tmp/parent.jsonl" });
		expect(resolveCursorSessionScope({ sessionId: "child-session" })).toMatchObject({
			cwd: "/tmp/child",
			scopeKey: "/tmp/child.jsonl",
		});

		const signal = new AbortController().signal;
		associateCursorSessionScopeSignal(signal, createExtensionTestContext({
			cwd: "/tmp/parent",
			sessionManager: { getSessionId: () => "parent-session" },
		}));
		expect(resolveCursorSessionScope({ sessionId: "standalone-summary", signal })).toBe(parentScope);

		releaseCursorSessionScope(createExtensionTestContext({
			sessionManager: { getSessionId: () => "child-session" },
		}));
		expect(getCursorSessionScope()).toBe(parentScope);
	});

	it("updates cwd on subsequent session_start events", async () => {
		const firstDir = mkdtempSync(join(tmpdir(), "pi-cursor-session-cwd-a-"));
		const secondDir = mkdtempSync(join(tmpdir(), "pi-cursor-session-cwd-b-"));
		try {
			const pi = createEventHarness();
			registerCursorSessionScope(pi);

			await pi.runSessionStart({ cwd: firstDir });
			expect(getCursorSessionCwd()).toBe(firstDir);

			await pi.runSessionStart({ cwd: secondDir });
			expect(getCursorSessionCwd()).toBe(secondDir);
		} finally {
			rmSync(firstDir, { recursive: true, force: true });
			rmSync(secondDir, { recursive: true, force: true });
		}
	});
});
