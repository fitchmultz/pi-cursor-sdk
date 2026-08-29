import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelListItem } from "@cursor/sdk";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { CURSOR_ATTRIBUTION_ENV } from "../src/cursor-config.js";
import {
	CURSOR_ATTRIBUTION_ENTRY_TYPE,
	getStoredCursorAttributionEnabled,
} from "../src/cursor-attribution.js";
import { __testUtils, registerCursorRuntimeControls } from "../src/cursor-state.js";
import { __testUtils as modelDiscoveryTestUtils } from "../src/model-discovery.js";
import {
	createExtensionCommandContext,
	createExtensionTestContext,
	createPiHarness,
	makeModel,
} from "./helpers/pi-harness.js";

const modelItem: ModelListItem = {
	id: "gpt-5.5",
	displayName: "GPT-5.5",
	parameters: [
		{ id: "context", displayName: "Context", values: [{ value: "1m" }] },
		{ id: "fast", displayName: "Fast", values: [{ value: "false" }, { value: "true" }] },
	],
	variants: [{
		params: [
			{ id: "context", value: "1m" },
			{ id: "fast", value: "false" },
		],
		displayName: "GPT-5.5",
		isDefault: true,
	}],
};

function customEntry(id: string, customType: string, data: Record<string, unknown>): SessionEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: new Date(0).toISOString(),
		customType,
		data,
	};
}

function createHarness(branch: SessionEntry[] = []) {
	const pi = createPiHarness();
	const ctx = createExtensionTestContext({
		model: makeModel("gpt-5.5@1m"),
		sessionManager: {
			getBranch: vi.fn<ExtensionContext["sessionManager"]["getBranch"]>(() => branch),
		},
	});
	registerCursorRuntimeControls(pi);
	const commandCtx = createExtensionCommandContext({
		cwd: ctx.cwd,
		model: ctx.model,
		ui: ctx.ui,
		sessionManager: ctx.sessionManager,
	});
	return { pi, ctx, commandCtx, commands: pi._commands };
}

describe("Cursor attribution state", () => {
	let agentDir: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "pi-cursor-attribution-state-"));
		process.env.PI_CODING_AGENT_DIR = agentDir;
		delete process.env[CURSOR_ATTRIBUTION_ENV];
		__testUtils.resetCursorModeStateForTests();
		modelDiscoveryTestUtils.registerModelItems([modelItem]);
	});

	afterEach(() => {
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		delete process.env[CURSOR_ATTRIBUTION_ENV];
		rmSync(agentDir, { recursive: true, force: true });
		vi.clearAllMocks();
	});

	it("defaults to enabled and reports the builtin source", async () => {
		const { pi, ctx, commandCtx, commands } = createHarness();
		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		await commands.get("cursor-attribution")!.handler("", commandCtx);

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Cursor attribution is enabled (source: builtin). Usage: /cursor-attribution [on|off|toggle]",
			"info",
		);
		expect(getStoredCursorAttributionEnabled()).toBeUndefined();
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off");
	});

	it("reports the env source without changing session state", async () => {
		process.env[CURSOR_ATTRIBUTION_ENV] = "0";
		const { pi, ctx, commandCtx, commands } = createHarness();
		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		await commands.get("cursor-attribution")!.handler("", commandCtx);

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Cursor attribution is disabled (source: environment). Usage: /cursor-attribution [on|off|toggle]",
			"info",
		);
		expect(getStoredCursorAttributionEnabled()).toBeUndefined();
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off · attrib:off");
	});

	it("toggles session state and atomically updates cursor-sdk.json", async () => {
		writeFileSync(
			__testUtils.getConfigPath(),
			JSON.stringify({ local: { futureLocal: "keep" } }),
		);
		const { pi, ctx, commandCtx, commands } = createHarness();
		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		await commands.get("cursor-attribution")!.handler("off", commandCtx);

		expect(getStoredCursorAttributionEnabled()).toBe(false);
		expect(pi.appendEntry).toHaveBeenCalledWith(CURSOR_ATTRIBUTION_ENTRY_TYPE, { enabled: false });
		expect(JSON.parse(readFileSync(__testUtils.getConfigPath(), "utf-8"))).toEqual({
			local: { futureLocal: "keep", attributeCommitsToAgent: false },
		});
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off · attrib:off");
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Cursor attribution disabled; Cursor is instructed not to add Co-authored-by trailers.",
			"info",
		);

		await commands.get("cursor-attribution")!.handler("toggle", commandCtx);

		expect(getStoredCursorAttributionEnabled()).toBe(true);
		expect(JSON.parse(readFileSync(__testUtils.getConfigPath(), "utf-8"))).toMatchObject({
			local: { attributeCommitsToAgent: true },
		});
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off");
	});

	it("retains a completed global save after session append failure", async () => {
		const { pi, ctx, commandCtx, commands } = createHarness();
		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);
		vi.mocked(pi.appendEntry).mockImplementationOnce(() => {
			throw new Error("journal failed");
		});

		await commands.get("cursor-attribution")!.handler("off", commandCtx);

		expect(JSON.parse(readFileSync(__testUtils.getConfigPath(), "utf-8"))).toEqual({
			local: { attributeCommitsToAgent: false },
		});
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Cursor attribution preference was saved globally, but persisting the session entry failed: journal failed",
			"error",
		);
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off · attrib:off");
	});

	it("restores the global preference from cursor-sdk.json", async () => {
		writeFileSync(
			__testUtils.getConfigPath(),
			JSON.stringify({ local: { attributeCommitsToAgent: false } }),
		);
		const { pi, ctx } = createHarness();

		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(getStoredCursorAttributionEnabled()).toBeUndefined();
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off · attrib:off");
	});

	it("restores branch history on session start and tree navigation", async () => {
		const disabledBranch = [customEntry("attrib-off", CURSOR_ATTRIBUTION_ENTRY_TYPE, { enabled: false })];
		const { pi, ctx } = createHarness(disabledBranch);
		const getBranch = vi.mocked(ctx.sessionManager.getBranch);
		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off · attrib:off");

		getBranch.mockReturnValue([customEntry("attrib-on", CURSOR_ATTRIBUTION_ENTRY_TYPE, { enabled: true })]);
		await pi.invokeEventWithContext("session_tree", { type: "session_tree", oldLeafId: null, newLeafId: null }, ctx);
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off");

		getBranch.mockReturnValue(disabledBranch);
		await pi.invokeEventWithContext("session_tree", { type: "session_tree", oldLeafId: null, newLeafId: null }, ctx);
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off · attrib:off");
	});

	it("rejects invalid command arguments", async () => {
		const { commandCtx, commands } = createHarness();

		await commands.get("cursor-attribution")!.handler("maybe", commandCtx);

		expect(commandCtx.ui.notify).toHaveBeenCalledWith(
			'Invalid Cursor attribution mode "maybe". Usage: /cursor-attribution [on|off|toggle]',
			"error",
		);
	});
});
