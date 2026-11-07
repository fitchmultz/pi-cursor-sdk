import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	__testUtils as cursorSessionScopeTestUtils,
	getCursorSessionScopeSnapshot,
	getCursorSessionProjectTrusted,
	registerCursorSessionScope,
} from "../src/cursor-session-scope.js";
import { createEventHarness } from "./helpers/pi-harness.js";

describe("cursor-session-scope cwd", () => {
	afterEach(() => {
		cursorSessionScopeTestUtils.reset();
	});

	it("falls back to process.cwd() before session_start", () => {
		expect(getCursorSessionScopeSnapshot().cwd).toBe(process.cwd());
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

	it.each([
		["  Cloud handoff  ", "Cloud handoff"],
		["x".repeat(120), `${"x".repeat(99)}…`],
	])("normalizes and bounds session names from session_start (%#)", async (name, expected) => {
		const pi = createEventHarness();
		registerCursorSessionScope(pi);

		await pi.runSessionStart({ sessionManager: { getSessionName: vi.fn(() => name) } });

		expect(getCursorSessionScopeSnapshot(pi).sessionName).toBe(expected);
	});

	it("updates the normalized session name when session metadata changes", async () => {
		const pi = createEventHarness();
		registerCursorSessionScope(pi);
		await pi.runSessionStart({ sessionManager: { getSessionName: vi.fn(() => "Initial") } });

		await pi.invokeEvent("session_info_changed", {
			type: "session_info_changed",
			name: "  Renamed\tsession\u001bwith\0controls\u0085  ",
		});
		expect(getCursorSessionScopeSnapshot(pi).sessionName).toBe("Renamed session with controls");

		await pi.invokeEvent("session_info_changed", { type: "session_info_changed", name: " \t\u001b\0 " });
		expect(getCursorSessionScopeSnapshot(pi).sessionName).toBeUndefined();
	});

	it("updates cwd on subsequent session_start events", async () => {
		const firstDir = mkdtempSync(join(tmpdir(), "pi-cursor-session-cwd-a-"));
		const secondDir = mkdtempSync(join(tmpdir(), "pi-cursor-session-cwd-b-"));
		try {
			const pi = createEventHarness();
			registerCursorSessionScope(pi);

			await pi.runSessionStart({ cwd: firstDir });
			expect(getCursorSessionScopeSnapshot(pi).cwd).toBe(firstDir);

			await pi.runSessionStart({ cwd: secondDir });
			expect(getCursorSessionScopeSnapshot(pi).cwd).toBe(secondDir);
		} finally {
			rmSync(firstDir, { recursive: true, force: true });
			rmSync(secondDir, { recursive: true, force: true });
		}
	});
});
