/**
 * Rebuild dist/ before a launcher loads the repo-root extension, so direct
 * `node scripts/<launcher>.mjs` invocations can never exercise stale code.
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function ensureBuilt() {
	execFileSync(process.execPath, [fileURLToPath(new URL("../build.mjs", import.meta.url))], {
		// build.mjs anchors tsc/dist/staging to its cwd; pin it to the repo root so
		// direct launcher invocations work from any directory.
		cwd: fileURLToPath(new URL("../..", import.meta.url)),
		stdio: "inherit",
	});
}
