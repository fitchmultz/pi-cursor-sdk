import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveInstalledPackageRoot } from "./helpers/installed-package.js";

const sdkRoot = resolveInstalledPackageRoot("@cursor/sdk");

describe("installed SDK lean policy contract", () => {
	it("documents local-only allowlists that must be supplied again on resume", () => {
		const types = readFileSync(join(sdkRoot, "dist/esm/options.d.ts"), "utf8");
		expect(types).toContain("tools?: ToolName[];");
		expect(types).toContain('`"mcp"` grants the whole MCP tool family');
		expect(types).toContain("pass `tools` again on `Agent.resume`");
		expect(types).toContain("combining `tools` with `cloud` throws");
		expect(types).toContain("Ambient Cursor settings layers to load from the local filesystem.");
	});
});
