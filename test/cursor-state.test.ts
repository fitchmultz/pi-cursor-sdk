import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	registerCursorRuntimeControls,
	getEffectiveFastForModelId,
	getCursorProviderAgentModeOrThrow,
	__testUtils,
} from "../src/cursor-state.js";
import { __testUtils as modelDiscoveryTestUtils } from "../src/model-discovery.js";
import type { ModelListItem } from "@cursor/sdk";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { CURSOR_HTTP1_ENV, getCursorSdkUserConfigPath } from "../src/cursor-config.js";
import { getCursorCliConfig } from "../src/cursor-runtime-state.js";
import { registerCursorSessionScope } from "../src/cursor-session-scope.js";
import {
	createExtensionCommandContext,
	createExtensionTestContext,
	createPiHarness,
	makeHarnessModel,
	makeModel,
} from "./helpers/pi-harness.js";
import { createTestToolInfo } from "./helpers/tool-fixtures.js";
import { __testUtils as cleanupTestUtils, CURSOR_SESSION_AGENT_CLEANUP_ENTRY_TYPE } from "../src/cursor-session-agent-cleanup.js";

const modelItems: ModelListItem[] = [
	{
		id: "composer-2",
		displayName: "Cursor Composer 2",
		parameters: [{ id: "fast", displayName: "Fast", values: [{ value: "false" }, { value: "true" }] }],
		variants: [
			{
				params: [{ id: "fast", value: "true" }],
				displayName: "Cursor Composer 2",
				isDefault: true,
			},
		],
	},
	{
		id: "composer-2.5",
		displayName: "Cursor Composer 2.5",
		aliases: ["composer-2-5"],
		parameters: [{ id: "fast", displayName: "Fast", values: [{ value: "false" }, { value: "true" }] }],
		variants: [
			{
				params: [{ id: "fast", value: "true" }],
				displayName: "Cursor Composer 2.5",
				isDefault: true,
			},
		],
	},
	{
		id: "gpt-5.5",
		displayName: "GPT-5.5",
		parameters: [
			{ id: "context", displayName: "Context", values: [{ value: "1m" }, { value: "272k" }] },
			{ id: "reasoning", displayName: "Reasoning", values: [{ value: "none" }, { value: "medium" }] },
			{ id: "fast", displayName: "Fast", values: [{ value: "false" }, { value: "true" }] },
		],
		variants: [
			{
				params: [
					{ id: "context", value: "1m" },
					{ id: "reasoning", value: "medium" },
					{ id: "fast", value: "false" },
				],
				displayName: "GPT-5.5",
				isDefault: true,
			},
		],
	},
	{
		id: "gemini-3.1-pro",
		displayName: "Gemini 3.1 Pro",
		variants: [{ params: [], displayName: "Gemini 3.1 Pro", isDefault: true }],
	},
];

function createCursorRuntimeHarness(options: {
	modelId?: string;
	provider?: string;
	api?: string;
	branch?: SessionEntry[];
	cursorFastFlag?: boolean;
	cursorNoFastFlag?: boolean;
	cursorModeFlag?: boolean | string;
	cursorLocalResumeFlag?: boolean;
	cursorNoLocalResumeFlag?: boolean;
	mode?: ExtensionContext["mode"];
	hasUI?: boolean;
	cwd?: string;
} = {}) {
	const pi = createPiHarness({
		flagValues: {
			"cursor-fast": options.cursorFastFlag ?? false,
			"cursor-no-fast": options.cursorNoFastFlag ?? false,
			"cursor-mode": options.cursorModeFlag ?? "",
			"cursor-local-resume": options.cursorLocalResumeFlag ?? false,
			"cursor-no-local-resume": options.cursorNoLocalResumeFlag ?? false,
		},
	});
	const ctx = createExtensionTestContext({
		cwd: options.cwd ?? process.cwd(),
		mode: options.mode ?? "tui",
		hasUI: options.hasUI ?? true,
		model: options.modelId
			? {
					...makeModel(options.modelId),
					provider: options.provider ?? "cursor",
					api: (options.api ?? "cursor-sdk") as "cursor-sdk",
				}
			: undefined,
		sessionManager: {
			getBranch: vi.fn<ExtensionContext["sessionManager"]["getBranch"]>(() => options.branch ?? []),
		},
	});
	registerCursorSessionScope(pi);
	registerCursorRuntimeControls(pi);
	const commandCtx = createExtensionCommandContext({
		cwd: ctx.cwd,
		model: ctx.model,
		ui: ctx.ui,
		sessionManager: ctx.sessionManager,
	});
	return { pi, ctx, commandCtx, commands: pi._commands };
}

describe("Cursor runtime state", () => {
	let tmpAgentDir: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const originalHttp1Env = process.env[CURSOR_HTTP1_ENV];

	beforeEach(() => {
		tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-cursor-state-"));
		process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
		delete process.env[CURSOR_HTTP1_ENV];
		__testUtils.resetCursorModeStateForTests();
		modelDiscoveryTestUtils.registerModelItems(modelItems);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		if (originalAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		}
		if (originalHttp1Env === undefined) delete process.env[CURSOR_HTTP1_ENV];
		else process.env[CURSOR_HTTP1_ENV] = originalHttp1Env;
		rmSync(tmpAgentDir, { recursive: true, force: true });
		vi.clearAllMocks();
	});

	it("defaults Cursor SDK mode to agent", async () => {
		const { pi, ctx } = createCursorRuntimeHarness({ modelId: "gpt-5.5@1m" });

		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(getCursorProviderAgentModeOrThrow()).toBe("agent");
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off");
	});

	it("forces Cursor SDK plan mode with --cursor-mode without writing session state", async () => {
		const { pi, ctx } = createCursorRuntimeHarness({ modelId: "gpt-5.5@1m", cursorModeFlag: "plan" });

		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(getCursorProviderAgentModeOrThrow()).toBe("plan");
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off · plan");
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("forces Cursor SDK agent mode with --cursor-mode over a persisted plan preference", async () => {
		const { pi, ctx } = createCursorRuntimeHarness({
			modelId: "gpt-5.5@1m",
			cursorModeFlag: "agent",
			branch: [
				{
					type: "custom",
					id: "mode-entry",
					parentId: null,
					timestamp: new Date(0).toISOString(),
					customType: "cursor-mode-state",
					data: { mode: "plan" },
				},
			],
		});

		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(getCursorProviderAgentModeOrThrow()).toBe("agent");
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off");
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("reports invalid --cursor-mode values in UI sessions and rejects provider mode reads", async () => {
		const { pi, ctx } = createCursorRuntimeHarness({ modelId: "gpt-5.5@1m", cursorModeFlag: "review" });

		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith('Invalid --cursor-mode "review". Use "agent" or "plan".', "error");
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off · mode invalid");
		expect(() => getCursorProviderAgentModeOrThrow()).toThrow('Invalid --cursor-mode "review"');
	});

	it("reports invalid --cursor-mode from /cursor-mode status instead of soft defaulting", async () => {
		const { pi, ctx, commandCtx, commands } = createCursorRuntimeHarness({
			modelId: "gpt-5.5@1m",
			cursorModeFlag: "review",
		});
		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);
		vi.mocked(ctx.ui.notify).mockClear();

		await commands.get("cursor-mode")!.handler("", commandCtx);

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			'Invalid --cursor-mode "review". Use "agent" or "plan". Usage: /cursor-mode agent|plan',
			"error",
		);
		expect(ctx.ui.notify).not.toHaveBeenCalledWith("Cursor mode is agent. Usage: /cursor-mode agent|plan", "info");
	});

	it("allows /cursor-mode to recover an interactive session from invalid --cursor-mode", async () => {
		const { pi, ctx, commandCtx, commands } = createCursorRuntimeHarness({
			modelId: "gpt-5.5@1m",
			cursorModeFlag: "review",
		});
		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);
		expect(() => getCursorProviderAgentModeOrThrow()).toThrow('Invalid --cursor-mode "review"');

		await commands.get("cursor-mode")!.handler("plan", commandCtx);

		expect(pi.appendEntry).toHaveBeenCalledWith("cursor-mode-state", { mode: "plan" });
		expect(getCursorProviderAgentModeOrThrow()).toBe("plan");
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off · plan");
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Cursor mode set to plan; cleared invalid --cursor-mode override",
			"info",
		);
	});

	it.each([
		["rpc", true],
		["json", false],
	] as const)("does not abort non-Cursor %s sessions for invalid --cursor-mode", async (mode, hasUI) => {
		const { pi, ctx } = createCursorRuntimeHarness({
			provider: "anthropic",
			api: "anthropic-messages",
			modelId: "claude-sonnet-4-5",
			cursorModeFlag: "review",
			mode,
			hasUI,
		});

		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(ctx.ui.notify).not.toHaveBeenCalled();
		expect(() => getCursorProviderAgentModeOrThrow()).toThrow('Invalid --cursor-mode "review"');
	});

	it("reports invalid --cursor-mode when a non-Cursor session later selects a Cursor model", async () => {
		const { pi, ctx } = createCursorRuntimeHarness({
			provider: "anthropic",
			api: "anthropic-messages",
			modelId: "claude-sonnet-4-5",
			cursorModeFlag: "review",
		});

		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);
		expect(ctx.ui.notify).not.toHaveBeenCalled();

		await pi.invokeEventWithContext(
			"model_select",
			{
				type: "model_select",
				model: { ...makeModel("composer-2"), provider: "cursor", api: "cursor-sdk" },
				previousModel: ctx.model!,
				source: "set",
			},
			ctx,
		);

		expect(ctx.ui.notify).toHaveBeenCalledWith('Invalid --cursor-mode "review". Use "agent" or "plan".', "error");
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:on · mode invalid");
	});

	it("persists /cursor-mode plan as session mode", async () => {
		const { pi, ctx, commandCtx, commands } = createCursorRuntimeHarness({ modelId: "gpt-5.5@1m" });
		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		await commands.get("cursor-mode")!.handler("plan", commandCtx);

		expect(pi.appendEntry).toHaveBeenCalledWith("cursor-mode-state", { mode: "plan" });
		expect(getCursorProviderAgentModeOrThrow()).toBe("plan");
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off · plan");
		expect(ctx.ui.notify).toHaveBeenCalledWith("Cursor mode set to plan", "info");
	});

	it("persists /cursor-mode agent as session mode", async () => {
		const { pi, ctx, commandCtx, commands } = createCursorRuntimeHarness({
			modelId: "gpt-5.5@1m",
			branch: [
				{
					type: "custom",
					id: "mode-entry",
					parentId: null,
					timestamp: new Date(0).toISOString(),
					customType: "cursor-mode-state",
					data: { mode: "plan" },
				},
			],
		});
		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);
		expect(getCursorProviderAgentModeOrThrow()).toBe("plan");

		await commands.get("cursor-mode")!.handler("agent", commandCtx);

		expect(pi.appendEntry).toHaveBeenCalledWith("cursor-mode-state", { mode: "agent" });
		expect(getCursorProviderAgentModeOrThrow()).toBe("agent");
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off");
		expect(ctx.ui.notify).toHaveBeenCalledWith("Cursor mode set to agent", "info");
	});

	it("reports current mode and usage for /cursor-mode with no args", async () => {
		const { pi, ctx, commandCtx, commands } = createCursorRuntimeHarness({ modelId: "gpt-5.5@1m", cursorModeFlag: "plan" });
		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		await commands.get("cursor-mode")!.handler("", commandCtx);

		expect(ctx.ui.notify).toHaveBeenCalledWith("Cursor mode is plan. Usage: /cursor-mode agent|plan", "info");
	});

	it("updates Cursor mode status when switching between Cursor models", async () => {
		const { pi, ctx } = createCursorRuntimeHarness({ modelId: "composer-2", cursorModeFlag: "plan" });
		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:on · plan");

		await pi.invokeEventWithContext(
			"model_select",
			{
				type: "model_select",
				model: { ...makeModel("gpt-5.5@1m"), provider: "cursor", api: "cursor-sdk" },
				previousModel: ctx.model!,
				source: "set",
			},
			ctx,
		);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off · plan");
	});

	it("restores fast and mode together when session tree navigation changes branches", async () => {
		const entry = (id: string, customType: string, data: Record<string, unknown>): SessionEntry => ({
			type: "custom",
			id,
			parentId: null,
			timestamp: new Date(0).toISOString(),
			customType,
			data,
		});
		const planBranch = [
			entry("fast-off", "cursor-fast-state", { baseModelId: "composer-2", fast: false }),
			entry("mode-plan", "cursor-mode-state", { mode: "plan" }),
		];
		const { pi, ctx } = createCursorRuntimeHarness({
			modelId: "composer-2",
			branch: planBranch,
		});
		const getBranch = vi.mocked(ctx.sessionManager.getBranch);
		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);
		expect(getEffectiveFastForModelId("composer-2")).toBe(false);
		expect(getCursorProviderAgentModeOrThrow()).toBe("plan");

		getBranch.mockReturnValue([
			entry("fast-on", "cursor-fast-state", { baseModelId: "composer-2", fast: true }),
			entry("mode-agent", "cursor-mode-state", { mode: "agent" }),
		]);
		await pi.invokeEventWithContext("session_tree", { type: "session_tree", oldLeafId: null, newLeafId: null }, ctx);
		expect(getEffectiveFastForModelId("composer-2")).toBe(true);
		expect(getCursorProviderAgentModeOrThrow()).toBe("agent");
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:on");

		getBranch.mockReturnValue(planBranch);
		await pi.invokeEventWithContext("session_tree", { type: "session_tree", oldLeafId: null, newLeafId: null }, ctx);
		expect(getEffectiveFastForModelId("composer-2")).toBe(false);
		expect(getCursorProviderAgentModeOrThrow()).toBe("plan");
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off · plan");

		getBranch.mockReturnValue([]);
		await pi.invokeEventWithContext("session_tree", { type: "session_tree", oldLeafId: null, newLeafId: null }, ctx);
		expect(getEffectiveFastForModelId("composer-2")).toBe(true);
		expect(getCursorProviderAgentModeOrThrow()).toBe("agent");
	});

	it("uses global fast defaults for new sessions", async () => {
		writeFileSync(getCursorSdkUserConfigPath(), JSON.stringify({ fastDefaults: { "gpt-5.5": true } }));
		const { pi, ctx } = createCursorRuntimeHarness({ modelId: "gpt-5.5@1m" });

		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:on");
		expect(getEffectiveFastForModelId("gpt-5.5@1m")).toBe(true);
	});

	it.each([
		["fast", true, "cursor:local · fast:on"],
		["slow", false, "cursor:local · fast:off"],
	] as const)("lets virtual %s models override stored opposite preferences", async (speed, fast, status) => {
		writeFileSync(getCursorSdkUserConfigPath(), JSON.stringify({ fastDefaults: { "composer-2": !fast } }));
		const modelId = `composer-2:${speed}`;
		const { pi, ctx } = createCursorRuntimeHarness({ modelId });

		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", status);
		expect(getEffectiveFastForModelId(modelId)).toBe(fast);
	});

	it("does not persist /cursor-fast while a virtual fast model is selected", async () => {
		const { pi, ctx, commandCtx, commands } = createCursorRuntimeHarness({ modelId: "composer-2:slow" });
		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		await commands.get("cursor-fast")!.handler("", commandCtx);

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Cursor fast is fixed disabled by selected model composer-2:slow; choose composer-2 to use /cursor-fast preferences",
			"info",
		);
		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(getEffectiveFastForModelId("composer-2:slow")).toBe(false);
	});

	it("maps local resume CLI flags and lets --cursor-no-local-resume win", async () => {
		let harness = createCursorRuntimeHarness({ cursorLocalResumeFlag: true });
		await harness.pi.runSessionStart({ model: makeModel("composer-2.5") });
		expect(getCursorCliConfig().local?.resume).toBe(true);

		harness = createCursorRuntimeHarness({ cursorLocalResumeFlag: true, cursorNoLocalResumeFlag: true });
		await harness.pi.runSessionStart({ model: makeModel("composer-2.5") });
		expect(getCursorCliConfig().local?.resume).toBe(false);
	});

	it.each([
		[{ cursorNoFastFlag: true }, "cursor:local · fast:n/a"],
		[{ cursorFastFlag: true }, "cursor:local · fast:n/a"],
		[{ cursorModeFlag: "plan" }, "cursor:local · fast:n/a · plan"],
	] as const)("keeps fast inapplicable on unsupported Cursor models with %j", async (options, status) => {
		const { pi, ctx } = createCursorRuntimeHarness({ modelId: "gemini-3.1-pro", ...options });

		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", status);
		expect(getEffectiveFastForModelId("gemini-3.1-pro")).toBeUndefined();
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it.each([false, true])("does not let /cursor-fast persist while --cursor-no-fast is active (also --cursor-fast: %s)", async (cursorFastFlag) => {
		const { pi, ctx, commandCtx, commands } = createCursorRuntimeHarness({ modelId: "composer-2", cursorNoFastFlag: true, cursorFastFlag });
		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off");
		expect(getEffectiveFastForModelId("composer-2")).toBe(false);
		expect(pi.appendEntry).not.toHaveBeenCalled();

		await commands.get("cursor-fast")!.handler("", commandCtx);

		expect(ctx.ui.notify).toHaveBeenCalledWith("Cursor fast is forced off by --cursor-no-fast", "info");
		expect(getEffectiveFastForModelId("composer-2")).toBe(false);
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("does not let /cursor-fast persist an opposite value when --cursor-fast is active", async () => {
		const { pi, ctx, commandCtx, commands } = createCursorRuntimeHarness({ modelId: "gpt-5.5@1m", cursorFastFlag: true });
		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:on");
		expect(getEffectiveFastForModelId("gpt-5.5@1m")).toBe(true);
		expect(pi.appendEntry).not.toHaveBeenCalled();

		await commands.get("cursor-fast")!.handler("", commandCtx);

		expect(ctx.ui.notify).toHaveBeenCalledWith("Cursor fast is forced by --cursor-fast", "info");
		expect(getEffectiveFastForModelId("gpt-5.5@1m")).toBe(true);
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("notifies and no-ops when the selected model does not support fast", async () => {
		const { ctx, commandCtx, commands, pi } = createCursorRuntimeHarness({ modelId: "gemini-3.1-pro" });
		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		await commands.get("cursor-fast")!.handler("", commandCtx);

		expect(ctx.ui.notify).toHaveBeenCalledWith("Fast mode not supported by gemini-3.1-pro", "info");
	});

	it("toggles fast by base model id so context sibling variants share the preference", async () => {
		const { ctx, commandCtx, commands, pi } = createCursorRuntimeHarness({ modelId: "gpt-5.5@1m" });
		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		await commands.get("cursor-fast")!.handler("", commandCtx);

		expect(getEffectiveFastForModelId("gpt-5.5@1m")).toBe(true);
		expect(getEffectiveFastForModelId("gpt-5.5@272k")).toBe(true);
		expect(JSON.parse(readFileSync(getCursorSdkUserConfigPath(), "utf-8"))).toEqual({
			fastDefaults: { "gpt-5.5": true },
		});
	});

	it("clears Cursor status when model_select moves from Cursor fast model to non-cursor model", async () => {
		const { pi, ctx } = createCursorRuntimeHarness({ modelId: "composer-2" });
		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:on");

		await pi.invokeEventWithContext(
			"model_select",
			{
				type: "model_select",
				model: makeHarnessModel("anthropic", "anthropic-messages", "claude-sonnet-4-5"),
				previousModel: ctx.model!,
				source: "set",
			},
			ctx,
		);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", undefined);
	});

	it("ignores malformed global config without throwing", async () => {
		writeFileSync(getCursorSdkUserConfigPath(), "{not json");
		const { pi, ctx } = createCursorRuntimeHarness({ modelId: "gpt-5.5@1m" });

		await expect(
			pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx),
		).resolves.toBeUndefined();

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off");
		expect(getEffectiveFastForModelId("gpt-5.5@1m")).toBe(false);
	});

	it("filters global config entries with invalid fast default values", async () => {
		writeFileSync(getCursorSdkUserConfigPath(), JSON.stringify({ fastDefaults: { "gpt-5.5": true, "composer-2": "false" } }));
		const { pi, ctx } = createCursorRuntimeHarness({ modelId: "composer-2" });

		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:on");
		expect(getEffectiveFastForModelId("composer-2")).toBe(true);
		expect(getEffectiveFastForModelId("gpt-5.5@1m")).toBe(true);
	});

	it("clears Cursor status for non-cursor models", async () => {
		const { pi, ctx } = createCursorRuntimeHarness({
			provider: "anthropic",
			api: "anthropic-messages",
			modelId: "claude-sonnet-4-5",
		});

		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", undefined);
	});

	it("refreshes Cursor fast status on turn_start after session_start without a model", async () => {
		const { pi, ctx } = createCursorRuntimeHarness();
		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", undefined);

		ctx.model = makeModel("composer-2");
		await pi.invokeEventWithContext("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() }, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:on");
	});

	it("recognizes cursor-sdk api models when updating footer status", async () => {
		const { pi, ctx } = createCursorRuntimeHarness({
			modelId: "composer-2",
			provider: "other-provider",
		});
		ctx.model = { ...makeModel("composer-2"), provider: "other-provider", api: "cursor-sdk" };

		await pi.invokeEventWithContext("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() }, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:on");
	});

	it("registers /cursor-tools and reports bridge and setting sources", async () => {
		const originalBridgeEnv = process.env.PI_CURSOR_PI_TOOL_BRIDGE;
		const originalSettingSourcesEnv = process.env.PI_CURSOR_SETTING_SOURCES;
		process.env.PI_CURSOR_PI_TOOL_BRIDGE = "1";
		process.env.PI_CURSOR_SETTING_SOURCES = "none";
		try {
			const pi = createPiHarness({
				activeTools: ["custom_bridge_tool"],
				initialTools: [createTestToolInfo("custom_bridge_tool", undefined, "Custom bridge tool")],
			});
			registerCursorSessionScope(pi);
			registerCursorRuntimeControls(pi);
			const ctx = createExtensionTestContext();
			await pi.runCommand("cursor-tools", "", { ui: ctx.ui, hasUI: true });

			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("PI_CURSOR_PI_TOOL_BRIDGE: enabled"), "info");
			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("PI_CURSOR_SETTING_SOURCES: none (effective: none)"), "info");
			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("current registry snapshot; not a live run"), "info");
			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("pi__custom_bridge_tool"), "info");
			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Cursor host/MCP"), "info");
			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Pi tool toggles affect pi tools/bridge exposure only"), "info");
			const report = vi.mocked(ctx.ui.notify).mock.calls[0][0];
			expect(report).toContain("Pi bridge exposure eligibility: pi__custom_bridge_tool");
			expect(report).toContain("does not prove a run's endpoint attachment, MCP initialization, catalog fetch, or tool calls");
			expect(report).toContain("mcp_initialized records a validated notifications/initialized receipt");
			expect(report).toContain("mcp_tools_list records catalog-handler output (toolCount), not client/model consumption");
			expect(report).toContain("request_queued/resolved/rejected record actual bridge call handling");
			expect(report).not.toContain("Callable tool surfaces this run:");
		} finally {
			if (originalBridgeEnv === undefined) delete process.env.PI_CURSOR_PI_TOOL_BRIDGE;
			else process.env.PI_CURSOR_PI_TOOL_BRIDGE = originalBridgeEnv;
			if (originalSettingSourcesEnv === undefined) delete process.env.PI_CURSOR_SETTING_SOURCES;
			else process.env.PI_CURSOR_SETTING_SOURCES = originalSettingSourcesEnv;
		}
	});

	it("reports disabled bridge and manifest through /cursor-tools", async () => {
		vi.stubEnv("PI_CURSOR_PI_TOOL_BRIDGE", "0");
		vi.stubEnv("PI_CURSOR_TOOL_MANIFEST", "0");
		vi.stubEnv("PI_CURSOR_SETTING_SOURCES", "project");
		const { pi, ctx } = createCursorRuntimeHarness();
		await pi.runCommand("cursor-tools", "", { ui: ctx.ui, hasUI: true });
		const report = vi.mocked(ctx.ui.notify).mock.calls[0][0];
		expect(report).toContain("PI_CURSOR_PI_TOOL_BRIDGE: disabled");
		expect(report).toContain("Pi bridge: disabled (PI_CURSOR_PI_TOOL_BRIDGE=0).");
		expect(report).toContain("PI_CURSOR_TOOL_MANIFEST: disabled");
		expect(report).toContain("PI_CURSOR_SETTING_SOURCES: project (effective: project)");
		expect(report).not.toContain("Callable tool surfaces this run:");
	});

	it("honors builtin exposure configuration in /cursor-tools", async () => {
		vi.stubEnv("PI_CURSOR_PI_TOOL_BRIDGE", "1");
		vi.stubEnv("PI_CURSOR_EXPOSE_BUILTIN_TOOLS", "0");
		const pi = createPiHarness({
			activeTools: ["read"],
			initialTools: [createTestToolInfo("read")],
		});
		registerCursorSessionScope(pi);
		registerCursorRuntimeControls(pi);
		const ctx = createExtensionTestContext();
		await pi.runCommand("cursor-tools", "", { ui: ctx.ui, hasUI: true });
		expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Pi bridge exposure eligibility: no eligible pi__* tools."), "info");
		vi.stubEnv("PI_CURSOR_EXPOSE_BUILTIN_TOOLS", "1");
		await pi.runCommand("cursor-tools", "", { ui: ctx.ui, hasUI: true });
		expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Pi bridge exposure eligibility: pi__read."), "info");
	});

	it.each([
		["", "No recorded superseded local Cursor SDK agents are cleanup-eligible.", "info", { action: "dry-run" }],
		["--dry-run", "No recorded superseded local Cursor SDK agents are cleanup-eligible.", "info", { action: "dry-run" }],
		["--help", "Invalid Cursor local resume cleanup arguments. Usage: /cursor-local-resume-cleanup [--dry-run|--yes]", "error", undefined],
		["--invalid", "Invalid Cursor local resume cleanup arguments. Usage: /cursor-local-resume-cleanup [--dry-run|--yes]", "error", undefined],
		["--yes", "No recorded superseded local Cursor SDK agents to delete.", "info", { action: "delete", phase: "result", deletedAgentIds: [] }],
	] as const)("registered local cleanup %s ignores unrelated invalid runtime config", async (args, message, level, ledger) => {
		const originalRuntime = process.env.PI_CURSOR_RUNTIME;
		const deleteAgent = vi.fn();
		cleanupTestUtils.setSdkOperations({ delete: deleteAgent });
		process.env.PI_CURSOR_RUNTIME = "invalid-unrelated-runtime";
		try {
			const { pi, ctx, commandCtx, commands } = createCursorRuntimeHarness();
			await commands.get("cursor-local-resume-cleanup")!.handler(args, commandCtx);
			expect(ctx.ui.notify).toHaveBeenCalledWith(message, level);
			if (ledger) {
				expect(pi.appendEntry).toHaveBeenCalledOnce();
				expect(pi.appendEntry).toHaveBeenCalledWith(CURSOR_SESSION_AGENT_CLEANUP_ENTRY_TYPE,
					expect.objectContaining({ ...ledger, runtime: "local", candidateAgentIds: [] }));
			} else expect(pi.appendEntry).not.toHaveBeenCalled();
			expect(deleteAgent).not.toHaveBeenCalled();
		} finally {
			cleanupTestUtils.reset();
			if (originalRuntime === undefined) delete process.env.PI_CURSOR_RUNTIME;
			else process.env.PI_CURSOR_RUNTIME = originalRuntime;
		}
	});

	it("logs /cursor-tools to stdout when UI is unavailable", async () => {
		const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
		try {
			const pi = createPiHarness();
			registerCursorSessionScope(pi);
			registerCursorRuntimeControls(pi);
			await pi.runCommand("cursor-tools", "", { hasUI: false });

			expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Cursor tool surfaces (current registry snapshot; not a live run):"));
			expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("does not prove a run's endpoint attachment"));
		} finally {
			consoleSpy.mockRestore();
		}
	});
});
