import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import {
	collectEvents,
	getErrorEvent,
	makeContext,
	makeModel,
	mockCreatedAgent,
	mockedCreate,
	mockedResume,
	resetCursorProviderTestState,
} from "./helpers/cursor-provider-harness.js";
import {
	createTrustIsolatedPackedFixture,
	createTrustIsolatedRunRoot,
	inspectNativeTrust,
	makeRunPi,
	PROJECT_TRUST_FIXTURE_SETUP_TIMEOUT_MS,
} from "./helpers/project-trust-contract-fixture.js";
import { streamCursor } from "./helpers/cursor-provider-ownership.js";
import { __testUtils as cursorSessionScopeTestUtils } from "../src/cursor-session-scope.js";

// Shard 4/4 of the former test/cursor-project-trust-contract.test.ts (split for
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
	}, PROJECT_TRUST_FIXTURE_SETUP_TIMEOUT_MS);

	it.each([
		["print", false],
		["json", false],
		["rpc", true],
	] as const)("requires trust for ancestor Agent Skills even with --no-skills in %s mode", async (mode, hasUI) => {
		// Reproduce the original contamination intentionally, inside this test's
		// own ancestry. Disabling skill loading does not bypass Pi's trust gate.
		mkdirSync(join(runRoot, ".agents", "skills"), { recursive: true });
		expect(inspectNativeTrust(projectDir, homeDir, agentDir)).toEqual({ requiresTrust: true, decision: null });
		const { output, events } = await runPi(mode);

		expect(events.some((event) => event.event === "project_trust")).toBe(true);
		expect(events).toContainEqual({ event: "session_start", mode, hasUI, trusted: false });
		expect(events).toContainEqual({
			event: "provider_config",
			runtime: "local",
			runtimeSource: "builtin",
			acknowledged: false,
			acknowledgementSource: "builtin",
		});
		expect(events.some((event) => event.event === "ui_confirm")).toBe(false);
		expect(output).toContain("Cursor SDK runs require a Cursor SDK API key");
	}, 90_000);

	it.each([
		[undefined, "local", "builtin"],
		[true, "cloud", "project"],
	] as const)(
		"requires explicit --approve=%s for project-local package config",
		async (trusted, runtime, runtimeSource) => {
			writeFileSync(
				join(projectDir, ".pi", "settings.json"),
				JSON.stringify({ packages: [packedPackageRoot] }),
			);
			new ProjectTrustStore(agentDir).set(projectDir, true);

			const { events } = await runPi("print", trusted, false, true);

			expect(events).not.toEqual(expect.arrayContaining([expect.objectContaining({ event: "project_trust" })]));
			expect(events).toContainEqual({ event: "session_start", mode: "print", hasUI: false, trusted: true });
			expect(events).toContainEqual(expect.objectContaining({
				event: "provider_config",
				runtime,
				runtimeSource,
			}));
		},
		90_000,
	);

	it("fails cloud preflight before SDK create or send when project acknowledgement is the only acknowledgement", async () => {
		writeFileSync(join(projectDir, ".pi", "settings.json"), "{}\n");
		cursorSessionScopeTestUtils.set(projectDir, join(runRoot, "session.jsonl"), "contract-session", true);
		const send = vi.fn();
		mockCreatedAgent({ send });

		const events = await collectEvents(streamCursor(makeModel("composer-2.5"), makeContext(), { apiKey: "test-key" }));

		expect(getErrorEvent(events).error.errorMessage).toContain("Cursor cloud runtime requires first-use acknowledgement");
		expect(mockedCreate).not.toHaveBeenCalled();
		expect(mockedResume).not.toHaveBeenCalled();
		expect(send).not.toHaveBeenCalled();
	});
});
