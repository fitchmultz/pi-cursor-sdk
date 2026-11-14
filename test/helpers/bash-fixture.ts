import { accessSync, constants, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOST_BASH_CANDIDATES = ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash", "/opt/homebrew/bin/bash"];

function findHostBash(): string {
	for (const candidate of HOST_BASH_CANDIDATES) {
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			// Keep looking: no single bash location exists on every host.
		}
	}
	throw new Error(`No bash found on this host. Checked: ${HOST_BASH_CANDIDATES.join(", ")}`);
}

export interface HostBashFixture {
	/** A real bash executable at a path unique to this fixture. */
	shellPath: string;
	/** The same executable, addressed the way a `~/...` shellPath would name it. */
	tildePath: string;
	/** The directory that `~` must expand to for `tildePath` to resolve. */
	home: string;
	dispose(): void;
}

/**
 * A real bash at a temporary path, so a `shellPath` assertion distinguishes the
 * override from `getShellConfig`'s own `/bin/bash` fallback. Hard-coding a
 * Homebrew path instead fails on every host without one, CI runners included.
 *
 * The layout is `<home>/bin/bash`, which also makes `~/bin/bash` resolvable and
 * gives the tilde case a real executable to reach.
 */
export function createHostBashFixture(): HostBashFixture {
	const home = mkdtempSync(join(tmpdir(), "cursor-shell-fixture-"));
	const binDir = join(home, "bin");
	mkdirSync(binDir);
	const shellPath = join(binDir, "bash");
	symlinkSync(findHostBash(), shellPath);
	return {
		home,
		shellPath,
		tildePath: "~/bin/bash",
		dispose: () => rmSync(home, { recursive: true, force: true }),
	};
}
