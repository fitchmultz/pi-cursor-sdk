import { describe, expect, it } from "vitest";
import { applyPiShellToCursorProcess, cursorShellEnvValue } from "../src/cursor-shell-env.js";
import { createHostBashFixture } from "./helpers/bash-fixture.js";

/** Run `body` with HOME pointed at `home`, so `~` in a shellPath is testable. */
function withHome<T>(home: string, body: () => T): T {
	const previous = process.env.HOME;
	process.env.HOME = home;
	try {
		return body();
	} finally {
		if (previous === undefined) delete process.env.HOME;
		else process.env.HOME = previous;
	}
}

describe("Cursor shell follows Pi", () => {
	it("gives Cursor Pi's bash path so a zsh login shell is not selected", () => {
		expect(cursorShellEnvValue("/opt/homebrew/bin/bash")).toBe("/opt/homebrew/bin/bash");
		expect(cursorShellEnvValue("/bin/zsh")).toBeUndefined();
		expect(cursorShellEnvValue("/bin/sh")).toBeUndefined();
		const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh" };
		applyPiShellToCursorProcess(undefined, env);
		expect(env.SHELL).toBe("/bin/bash");
		applyPiShellToCursorProcess("/bin/zsh", env);
		expect(env.SHELL).toBe("/bin/bash");
	});

	it("replaces SHELL from Pi's bash path while Pi's settings are readable", () => {
		// The override runs on session_start: reading settings during extension
		// load throws and fails the whole extension load. A temporary bash keeps
		// this host-independent, and its unique path proves the override ran
		// rather than getShellConfig falling back to /bin/bash.
		const bash = createHostBashFixture();
		try {
			const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh" };
			applyPiShellToCursorProcess(bash.shellPath, env);
			expect(env.SHELL).toBe(bash.shellPath);
		} finally {
			bash.dispose();
		}
	});

	it("accepts a leading tilde in shellPath like Pi's own setting does", () => {
		// Pi documents `shellPath` with `~` support, so a `~/...` value is an
		// ordinary setting, not a malformed one. It must resolve to the same
		// executable its absolute form would name.
		const bash = createHostBashFixture();
		try {
			withHome(bash.home, () => {
				const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh" };
				applyPiShellToCursorProcess(bash.tildePath, env);
				expect(env.SHELL).toBe(bash.shellPath);
			});
		} finally {
			bash.dispose();
		}
	});

	it("expands a bare tilde to the home directory", () => {
		const bash = createHostBashFixture();
		try {
			withHome(bash.home, () => {
				const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh" };
				applyPiShellToCursorProcess("~", env);
				// A directory is not an executable, so the override correctly
				// declines instead of writing an unusable SHELL.
				expect(env.SHELL).toBe("/bin/zsh");
			});
		} finally {
			bash.dispose();
		}
	});
});
