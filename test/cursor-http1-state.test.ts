import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelListItem } from "@cursor/sdk";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { CURSOR_HTTP1_ENV, getCursorSdkUserConfigPath } from "../src/cursor-config.js";
import {
	CURSOR_HTTP1_ENTRY_TYPE,
	getStoredCursorHttp1Enabled,
} from "../src/cursor-http1.js";
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

describe("Cursor HTTP/1.1 state", () => {
	let agentDir: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "pi-cursor-http1-state-"));
		process.env.PI_CODING_AGENT_DIR = agentDir;
		delete process.env[CURSOR_HTTP1_ENV];
		__testUtils.resetCursorModeStateForTests();
		modelDiscoveryTestUtils.registerModelItems([modelItem]);
	});

	afterEach(() => {
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		delete process.env[CURSOR_HTTP1_ENV];
		rmSync(agentDir, { recursive: true, force: true });
		vi.clearAllMocks();
	});

	it("reports the env source without changing session state", async () => {
		process.env[CURSOR_HTTP1_ENV] = "1";
		const { pi, ctx, commandCtx, commands } = createHarness();
		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		await commands.get("cursor-http")!.handler("", commandCtx);

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Cursor HTTP/1.1/SSE transport is enabled (source: environment). Usage: /cursor-http [on|off|toggle]",
			"info",
		);
		expect(getStoredCursorHttp1Enabled()).toBeUndefined();
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off · http1");
	});

	it("toggles session state and atomically updates cursor-sdk.json", async () => {
		writeFileSync(
			getCursorSdkUserConfigPath(),
			JSON.stringify({ future: { enabled: true }, local: { futureLocal: "keep" } }),
		);
		const { pi, ctx, commandCtx, commands } = createHarness();
		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		await commands.get("cursor-http")!.handler("on", commandCtx);

		expect(getStoredCursorHttp1Enabled()).toBe(true);
		expect(pi.appendEntry).toHaveBeenCalledWith(CURSOR_HTTP1_ENTRY_TYPE, { enabled: true });
		expect(JSON.parse(readFileSync(getCursorSdkUserConfigPath(), "utf-8"))).toEqual({
			future: { enabled: true },
			local: { futureLocal: "keep", useHttp1ForAgent: true },
		});
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off · http1");

		await commands.get("cursor-http")!.handler("toggle", commandCtx);

		expect(getStoredCursorHttp1Enabled()).toBe(false);
		expect(JSON.parse(readFileSync(getCursorSdkUserConfigPath(), "utf-8"))).toMatchObject({
			local: { futureLocal: "keep", useHttp1ForAgent: false },
		});
		expect(ctx.ui.notify).toHaveBeenCalledWith("Cursor HTTP/1.1/SSE transport disabled", "info");
	});

	it("retains a completed global save after session append failure", async () => {
		process.env[CURSOR_HTTP1_ENV] = "1";
		const { pi, ctx, commandCtx, commands } = createHarness();
		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);
		vi.mocked(pi.appendEntry).mockImplementationOnce(() => {
			throw new Error("journal failed");
		});

		await commands.get("cursor-http")!.handler("off", commandCtx);

		expect(JSON.parse(readFileSync(getCursorSdkUserConfigPath(), "utf-8"))).toEqual({
			local: { useHttp1ForAgent: false },
		});
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Cursor HTTP/1.1 preference was saved globally, but persisting the session entry failed: journal failed",
			"error",
		);
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off · http1");
	});

	it("restores the global preference from cursor-sdk.json", async () => {
		writeFileSync(
			getCursorSdkUserConfigPath(),
			JSON.stringify({ local: { useHttp1ForAgent: true } }),
		);
		const { pi, ctx } = createHarness();

		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(getStoredCursorHttp1Enabled()).toBeUndefined();
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off · http1");
	});

	it("restores branch history on session start and tree navigation", async () => {
		const enabledBranch = [customEntry("http-on", CURSOR_HTTP1_ENTRY_TYPE, { enabled: true })];
		const { pi, ctx } = createHarness(enabledBranch);
		const getBranch = vi.mocked(ctx.sessionManager.getBranch);
		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off · http1");

		getBranch.mockReturnValue([customEntry("http-off", CURSOR_HTTP1_ENTRY_TYPE, { enabled: false })]);
		await pi.invokeEventWithContext("session_tree", { type: "session_tree", oldLeafId: null, newLeafId: null }, ctx);
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off");

		getBranch.mockReturnValue(enabledBranch);
		await pi.invokeEventWithContext("session_tree", { type: "session_tree", oldLeafId: null, newLeafId: null }, ctx);
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off · http1");
	});

	it("does not show the local-only marker for cloud runtime", async () => {
		process.env[CURSOR_HTTP1_ENV] = "1";
		const { pi, ctx } = createHarness([
			customEntry("runtime", "cursor-runtime-state", {
				runtime: "cloud",
				cloudAcknowledged: true,
			}),
		]);

		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:cloud · fast:n/a");
	});

	it("rejects invalid command arguments", async () => {
		const { commandCtx, commands } = createHarness();

		await commands.get("cursor-http")!.handler("maybe", commandCtx);

		expect(commandCtx.ui.notify).toHaveBeenCalledWith(
			'Invalid Cursor HTTP transport mode "maybe". Usage: /cursor-http [on|off|toggle]',
			"error",
		);
	});
});
