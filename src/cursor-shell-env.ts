import { homedir } from "node:os";
import { join } from "node:path";
import { getShellConfig } from "@earendil-works/pi-coding-agent";

/**
 * Cursor's shell picker reads `SHELL` and checks zsh before bash. A zsh path
 * selects the executor that kills the process group when `close` is late, and
 * its close-timeout line then has to be filtered out of Pi's input area.
 * Return Pi's own path when it is a bash so the picker chooses that executor,
 * and leave any other Pi choice alone.
 */
export function cursorShellEnvValue(piShellExecutable: string): string | undefined {
	if (piShellExecutable.includes("bash")) return piShellExecutable;
	return undefined;
}

/**
 * The executable to apply, or `undefined` when Pi's `shellPath` cannot name one.
 *
 * Pi accepts a leading `~` in `shellPath`, so accept it here too, the same way
 * its own getter does. Expanding is part of reading the setting, not a special
 * case layered on top of it. An unset `shellPath` still resolves Pi's platform
 * default, which is what Pi itself would run.
 */
function resolvePiShell(shellPath: string | undefined): string | undefined {
	if (!shellPath) {
		try {
			return getShellConfig(undefined).shell;
		} catch {
			return undefined;
		}
	}
	const expanded = shellPath === "~"
		? homedir()
		: shellPath.startsWith("~/") ? join(homedir(), shellPath.slice(2)) : shellPath;
	try {
		return getShellConfig(expanded).shell;
	} catch {
		return undefined;
	}
}

export function applyPiShellToCursorProcess(
	shellPath: string | undefined,
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): void {
	// Cursor's POSIX picker reads SHELL and prefers zsh, which kills the process
	// group when a background command leaves the pipes open. On Windows the same
	// write selects the Bash executor. That executor resolves bash.exe through
	// PATH unless MSYSTEM already named a Git Bash, while Pi's unset shellPath is
	// `%ProgramFiles%\\Git\\bin\\bash.exe` before any PATH search. Writing that
	// path makes every local shell call throw "Can't find Bash" when bash.exe is
	// not on PATH. Leave Windows on the PowerShell fallback Cursor used when
	// SHELL was unset.
	if (platform === "win32") return;
	const next = cursorShellEnvValue(resolvePiShell(shellPath) ?? "");
	if (next) env.SHELL = next;
}
