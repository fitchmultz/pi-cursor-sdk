import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { resetCursorProviderTestState } from "./helpers/cursor-provider-harness.js";
import {
	createTrustIsolatedPackedFixture,
	createTrustIsolatedRunRoot,
	inspectNativeTrust,
	makeRunPi,
} from "./helpers/project-trust-contract-fixture.js";

// Shard 2/4 of the former test/cursor-project-trust-contract.test.ts (split for
// vitest file-level fork parallelism; all 24 scenarios/assertions across the
// four shards are preserved verbatim; in-file concurrency is unsafe because
// resetCursorProviderTestState mutates provider globals).

describe("non-interactive project trust CLI/provider contract", () => {
	let fixtureRoot: string;
	let packedPackageRoot: string;
	let probeExtensionPath: string;
	let runRoot: string;
	let projectDir: string;
	let agentDir: string;
	let homeDir: string;
	let markerPath: string;
	let runPi: ReturnType<typeof makeRunPi>;

	beforeAll(() => {
		({ fixtureRoot, packedPackageRoot, probeExtensionPath } = createTrustIsolatedPackedFixture());
	}, 120_000);

	beforeEach(async () => {
		await resetCursorProviderTestState();
		({ runRoot, projectDir, agentDir, homeDir, markerPath } = createTrustIsolatedRunRoot(fixtureRoot));
		runPi = makeRunPi(() => ({ runRoot, projectDir, agentDir, homeDir, markerPath, probeExtensionPath }));
		// Standalone extension config is not a Pi trust resource. No ancestor skills
		// or inherited trust decisions may silently change the scenario under test.
		expect(inspectNativeTrust(projectDir, homeDir, agentDir)).toEqual({ requiresTrust: false, decision: null });
	});

	afterEach(() => {
		rmSync(runRoot, { recursive: true, force: true });
	});

	afterAll(() => {
		if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
	});

	it.each([
		["print", false],
		["json", false],
		["rpc", true],
	] as const)("retains Pi project-trust event provenance in %s mode", async (mode, hasUI) => {
		writeFileSync(join(projectDir, ".pi", "settings.json"), "{}\n");
		new ProjectTrustStore(agentDir).set(projectDir, true);
		const { output, events } = await runPi(mode);

		expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ event: "project_trust" })]));
		expect(events).toContainEqual({ event: "session_start", mode, hasUI, trusted: true });
		expect(events).toContainEqual({
			event: "provider_config",
			runtime: "cloud",
			runtimeSource: "project",
			acknowledged: false,
			acknowledgementSource: "builtin",
		});
		expect(events).not.toEqual(expect.arrayContaining([expect.objectContaining({ event: "ui_confirm" })]));
		expect(output).toContain("Cursor SDK runs require a Cursor SDK API key");
	}, 90_000);

	it.each([
		["print", false],
		["json", false],
		["rpc", true],
	] as const)("honors explicit approval for standalone project config in %s mode", async (mode, hasUI) => {
		writeFileSync(join(agentDir, "cursor-sdk.json"), JSON.stringify({ cloud: { acknowledged: true } }));
		const { output, events } = await runPi(mode, true);

		expect(events).toContainEqual({ event: "session_start", mode, hasUI, trusted: true });
		expect(events).toContainEqual({
			event: "provider_config",
			runtime: "cloud",
			runtimeSource: "project",
			acknowledged: true,
			acknowledgementSource: "user",
		});
		expect(events).not.toEqual(expect.arrayContaining([expect.objectContaining({ event: "ui_confirm" })]));
		expect(output).toContain("Cursor SDK runs require a Cursor SDK API key");
	}, 90_000);
});
