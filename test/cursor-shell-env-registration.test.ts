import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionHandler, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { registerCursorShellEnv } from "../src/cursor-shell-env-registration.js";
import { createHostBashFixture } from "./helpers/bash-fixture.js";

type SessionStartHandler = ExtensionHandler<SessionStartEvent>;

// The handler reads only `pi.getSettings`, so the event and ctx stay stubs.
const SESSION_START = {} as SessionStartEvent;
const SESSION_CTX = {} as Parameters<SessionStartHandler>[1];

function runHandler(handler: SessionStartHandler): void | Promise<void> {
	return handler(SESSION_START, SESSION_CTX);
}

function harnessWithSettings(getSettings: () => { shellPath?: string }) {
	const handlers: SessionStartHandler[] = [];
	return {
		handlers,
		pi: {
			getSettings,
			on(_event: "session_start", handler: SessionStartHandler) {
				handlers.push(handler);
			},
		},
	};
}

describe("Cursor shell override follows Pi settings without failing extension load", () => {
	const originalShell = process.env.SHELL;
	afterEach(() => {
		if (originalShell === undefined) delete process.env.SHELL;
		else process.env.SHELL = originalShell;
	});

	it("reads settings on session_start instead of during extension load", async () => {
		const bash = createHostBashFixture();
		try {
			const getSettings = vi.fn(() => ({ shellPath: bash.shellPath }));
			const { handlers, pi } = harnessWithSettings(getSettings);
			registerCursorShellEnv(pi);
			// Registration alone must not touch settings: Pi throws when they are
			// read before the extension runtime initializes.
			expect(getSettings).not.toHaveBeenCalled();
			process.env.SHELL = "/bin/zsh";
			await runHandler(handlers[0]);
			expect(getSettings).toHaveBeenCalled();
			expect(process.env.SHELL).toBe(bash.shellPath);
		} finally {
			bash.dispose();
		}
	});

	it("keeps loading when Pi settings are unreadable", async () => {
		const { handlers, pi } = harnessWithSettings(() => {
			throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.");
		});
		registerCursorShellEnv(pi);
		process.env.SHELL = "/bin/zsh";
		expect(() => runHandler(handlers[0])).not.toThrow();
		expect(process.env.SHELL).toBe("/bin/zsh");
	});
});
