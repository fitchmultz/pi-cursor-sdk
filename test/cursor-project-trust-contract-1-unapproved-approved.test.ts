import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetCursorProviderTestState } from "./helpers/cursor-provider-harness.js";
import {
	createTrustIsolatedPackedFixture,
	createTrustIsolatedRunRoot,
	inspectNativeTrust,
	makeRunPi,
	PROJECT_TRUST_FIXTURE_SETUP_TIMEOUT_MS,
} from "./helpers/project-trust-contract-fixture.js";

// Shard 1/4 of the former test/cursor-project-trust-contract.test.ts (split for
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
	}, PROJECT_TRUST_FIXTURE_SETUP_TIMEOUT_MS);

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
	] as const)("ignores project cloud runtime under --no-approve in %s mode", async (mode, hasUI) => {
		writeFileSync(join(projectDir, ".pi", "settings.json"), "{}\n");
		const { output, events } = await runPi(mode, false);

		expect(events).toContainEqual({ event: "session_start", mode, hasUI, trusted: false });
		expect(events).toContainEqual({
			event: "provider_config",
			runtime: "local",
			runtimeSource: "builtin",
			acknowledged: false,
			acknowledgementSource: "builtin",
		});
		expect(events).not.toEqual(expect.arrayContaining([expect.objectContaining({ event: "ui_confirm" })]));
		expect(output).toContain("Cursor SDK runs require a Cursor SDK API key");
		expect(output).not.toContain("Cursor cloud runtime requires first-use acknowledgement");
	}, 90_000);

	it.each([
		["print", false],
		["json", false],
		["rpc", true],
	] as const)("excludes project cloud acknowledgement in approved %s mode", async (mode, hasUI) => {
		writeFileSync(join(projectDir, ".pi", "settings.json"), "{}\n");
		const { output, events } = await runPi(mode, true);

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
});
