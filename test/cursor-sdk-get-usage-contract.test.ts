import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readInstalledPackageDistText, resolveInstalledPackageRoot } from "./helpers/installed-package.js";

const require = createRequire(import.meta.url);
const sdkRoot = resolveInstalledPackageRoot("@cursor/sdk");
describe("installed Cursor SDK 1.0.32 getUsage contract", () => {
	it("exposes billed AgentUsage with usage totals and runId-keyed runs", () => {
		const agentTypes = readFileSync(join(sdkRoot, "dist/esm/agent.d.ts"), "utf8");
		expect(agentTypes).toContain("getUsage(options?: GetUsageOptions): Promise<AgentUsage>");
		expect(agentTypes).toContain("runId?: string");
		expect(agentTypes).toContain("a usage UUID from a previous");
		expect(agentTypes).toContain("`getUsage().runs[].runId`");
		expect(agentTypes).toContain("client-side `run-<uuid>` labels throw a");

		const stubs = readFileSync(join(sdkRoot, "dist/esm/stubs.d.ts"), "utf8");
		expect(stubs).toContain("static getUsage(agentId: string, options?: GetUsageOptions & CursorRequestOptions): Promise<AgentUsage>");

		const usageTypes = readFileSync(join(sdkRoot, "dist/esm/usage-types.d.ts"), "utf8");
		expect(usageTypes).toContain("export interface AgentUsage");
		expect(usageTypes).toContain("usage: TokenUsage");
		expect(usageTypes).not.toMatch(/export interface AgentUsage[\s\S]*totalUsage/);
		expect(usageTypes).toContain("runId: string");
		expect(usageTypes).toContain("rawCostCents: number");
		expect(usageTypes).toContain("chargedCents: number");

		const bundle = readFileSync(require.resolve("@cursor/sdk"), "utf8");
		expect(bundle).toContain(
			"Local agent usage cannot be filtered by a client-minted `run-<uuid>` run ID because the backend never receives it. Pass a usage UUID from `getUsage().runs[].runId` instead.",
		);
	});

	it("attaches a no-op error listener before local shell snapshot writes", () => {
		expect(readInstalledPackageDistText("@cursor/sdk")).toMatch(
			/function (\w+)\(e\)\{e\?\.on\("error",\(\(\)=>\{\}\)\)\}function \w+\(e,t\)\{e&&\(\1\(e\),e\.write\(t\),e\.end\(\)\)\}/,
		);
	});
});
