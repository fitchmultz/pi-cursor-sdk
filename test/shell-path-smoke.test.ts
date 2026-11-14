import { describe, expect, it } from "vitest";
import {
	PROBE_JSON_OBJECT,
	PROBE_SOURCE,
	expectedAppliedShell,
	formatShellPathProbe,
	parseShellPathEvidence,
} from "../scripts/shell-path-smoke.mjs";

describe("shell-path smoke evidence", () => {
	it("round-trips an unset shellPath as JSON null", () => {
		const line = formatShellPathProbe(undefined, undefined);
		expect(parseShellPathEvidence([line])).toEqual({ shell: null, shellPath: null });
		expect(parseShellPathEvidence(['SHELL="/bin/bash" shellPath=undefined'])).toBeUndefined();
	});

	it("keeps the probe source on the same null encoding", () => {
		expect(PROBE_SOURCE).toContain(PROBE_JSON_OBJECT);
		expect(PROBE_SOURCE).not.toContain("JSON.stringify(pi.getSettings().shellPath)}");
	});

	it("expects the configured path or Pi's default, and the pinned shell on Windows", () => {
		expect(expectedAppliedShell("/tmp/fixture/bash", "/bin/zsh", "darwin", "/bin/bash")).toBe("/tmp/fixture/bash");
		expect(expectedAppliedShell(null, "/bin/zsh", "darwin", "/bin/bash")).toBe("/bin/bash");
		expect(expectedAppliedShell("/tmp/fixture/bash", "/bin/zsh", "win32", "/bin/bash")).toBe("/bin/zsh");
		expect(expectedAppliedShell(null, "/bin/zsh", "win32", "/bin/bash")).toBe("/bin/zsh");
	});
});
