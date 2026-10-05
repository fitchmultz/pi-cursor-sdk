import { readFileSync, rmSync, writeFileSync } from "node:fs";
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

// Shard 3/4 of the former test/cursor-project-trust-contract.test.ts (split for
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
	] as const)("ignores standalone project cloud runtime without a trust decision in %s mode", async (mode, hasUI) => {
		writeFileSync(join(agentDir, "cursor-sdk.json"), JSON.stringify({ cloud: { acknowledged: true } }));
		const { output, events } = await runPi(mode);

		// Native Pi auto-trusts a resource-free cwd WITHOUT emitting project_trust;
		// that implicit boolean must not authorize Cursor's standalone cloud config.
		expect(events.some((event) => event.event === "project_trust")).toBe(false);
		expect(events).toContainEqual({ event: "session_start", mode, hasUI, trusted: true });
		expect(events).toContainEqual({
			event: "provider_config",
			runtime: "local",
			runtimeSource: "builtin",
			acknowledged: true,
			acknowledgementSource: "user",
		});
		expect(events).not.toEqual(expect.arrayContaining([expect.objectContaining({ event: "ui_confirm" })]));
		expect(output).toContain("Cursor SDK runs require a Cursor SDK API key");
		expect(output).not.toContain("Cursor cloud runtime requires first-use acknowledgement");
	}, 90_000);

	it.each([
		["print", false],
		["json", false],
		["rpc", true],
	] as const)("ignores a trust resource added after Pi trust resolution in %s mode", async (mode, hasUI) => {
		writeFileSync(join(agentDir, "cursor-sdk.json"), JSON.stringify({ cloud: { acknowledged: true } }));
		const { output, events } = await runPi(mode, undefined, true);

		// The settings resource now requires trust, but it was created only inside
		// session_start, after Pi resolved trust. It cannot grant event provenance.
		expect(readFileSync(join(projectDir, ".pi", "settings.json"), "utf8")).toBe("{}\n");
		expect(inspectNativeTrust(projectDir, homeDir, agentDir)).toEqual({ requiresTrust: true, decision: null });
		expect(events.some((event) => event.event === "project_trust")).toBe(false);
		expect(events).toContainEqual({ event: "session_start", mode, hasUI, trusted: true });
		expect(events).toContainEqual({
			event: "provider_config",
			runtime: "local",
			runtimeSource: "builtin",
			acknowledged: true,
			acknowledgementSource: "user",
		});
		expect(events).not.toEqual(expect.arrayContaining([expect.objectContaining({ event: "ui_confirm" })]));
		expect(output).toContain("Cursor SDK runs require a Cursor SDK API key");
	}, 90_000);
});
