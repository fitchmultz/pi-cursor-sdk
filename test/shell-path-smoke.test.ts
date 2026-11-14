import { describe, expect, it } from "vitest";
import {
	PROBE_JSON_OBJECT,
	PROBE_SOURCE,
	expectedCursorShell,
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

	it("asks the production override what SHELL should be, including a no-op", () => {
		expect(expectedCursorShell((_shellPath, env) => {
			env.SHELL = "/tmp/fixture/bash";
		}, "/tmp/fixture/bash", "/bin/zsh")).toBe("/tmp/fixture/bash");

		let unset: string | undefined;
		expect(expectedCursorShell((shellPath, env) => {
			unset = shellPath;
			env.SHELL = "/bin/bash";
		}, null, "/bin/zsh")).toBe("/bin/bash");
		expect(unset).toBeUndefined();

		expect(expectedCursorShell(() => undefined, "/tmp/fixture/bash", "/bin/zsh")).toBe("/bin/zsh");
	});
});
