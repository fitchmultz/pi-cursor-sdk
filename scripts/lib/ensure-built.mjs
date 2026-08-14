/**
 * Rebuild dist/ before a launcher loads the repo-root extension, so direct
 * `node scripts/<launcher>.mjs` invocations can never exercise stale code.
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function ensureBuilt() {
	execFileSync(process.execPath, [fileURLToPath(new URL("../build.mjs", import.meta.url))], {
		stdio: "inherit",
	});
}
