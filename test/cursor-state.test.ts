import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	registerCursorRuntimeControls,
	getEffectiveFastForModelId,
	getCursorProviderAgentModeOrThrow,
	getStoredCursorAgentMode,
	resolveCursorAgentMode,
	formatCursorToolsDebugReport,
	getCursorCliConfig,
	__testUtils,
} from "../src/cursor-state.js";
import { __testUtils as modelDiscoveryTestUtils } from "../src/model-discovery.js";
import type { ModelListItem } from "@cursor/sdk";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createExtensionCommandContext,
	createExtensionTestContext,
	createPiHarness,
	makeHarnessModel,
	makeModel,
} from "./helpers/pi-harness.js";
import { createTestToolInfo } from "./helpers/tool-fixtures.js";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

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
	cursorRuntimeFlag?: string;
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
			"cursor-runtime": options.cursorRuntimeFlag ?? "",
			"cursor-local-resume": options.cursorLocalResumeFlag ?? false,
			"cursor-no-local-resume": options.cursorNoLocalResumeFlag ?? false,
		},
	});
	const ctx = createExtensionTestContext({
		cwd: options.cwd,
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
	let originalCursorRuntime: string | undefined;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

	beforeEach(() => {
		tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-cursor-state-"));
		process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
		originalCursorRuntime = process.env.PI_CURSOR_RUNTIME;
		delete process.env.PI_CURSOR_RUNTIME;
		__testUtils.sessionFastPreferences.clear();
		__testUtils.resetCursorModeStateForTests();
		modelDiscoveryTestUtils.registerModelItems(modelItems);
	});

	afterEach(() => {
		if (originalAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		}
		if (originalCursorRuntime === undefined) {
			delete process.env.PI_CURSOR_RUNTIME;
		} else {
			process.env.PI_CURSOR_RUNTIME = originalCursorRuntime;
		}
		rmSync(tmpAgentDir, { recursive: true, force: true });
		vi.clearAllMocks();
	});

	it("defaults Cursor SDK mode to agent", async () => {
		const { pi, ctx } = createCursorRuntimeHarness({ modelId: "gpt-5.5@1m" });

		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(resolveCursorAgentMode()).toEqual({ kind: "valid", mode: "agent" });
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off");
	});

	it("forces Cursor SDK plan mode with --cursor-mode without writing session state", async () => {
		const { pi, ctx } = createCursorRuntimeHarness({ modelId: "gpt-5.5@1m", cursorModeFlag: "plan" });

		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(resolveCursorAgentMode()).toEqual({ kind: "valid", mode: "plan" });
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
					customType: __testUtils.MODE_ENTRY_TYPE,
					data: { mode: "plan" },
				},
			],
		});

		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(resolveCursorAgentMode()).toEqual({ kind: "valid", mode: "agent" });
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off");
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("reports invalid --cursor-mode values in UI sessions and rejects provider mode reads", async () => {
		const { pi, ctx } = createCursorRuntimeHarness({ modelId: "gpt-5.5@1m", cursorModeFlag: "review" });

		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith('Invalid --cursor-mode "review". Use "agent" or "plan".', "error");
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off · mode invalid");
		expect(resolveCursorAgentMode()).toEqual({
			kind: "invalid",
			raw: "review",
			message: 'Invalid --cursor-mode "review". Use "agent" or "plan".',
		});
		expect(getStoredCursorAgentMode()).toBe("agent");
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

		expect(pi.appendEntry).toHaveBeenCalledWith(__testUtils.MODE_ENTRY_TYPE, { mode: "plan" });
		expect(resolveCursorAgentMode()).toEqual({ kind: "valid", mode: "plan" });
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off · plan");
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Cursor mode set to plan; cleared invalid --cursor-mode override",
			"info",
		);
	});

	it("does not abort non-Cursor RPC sessions for invalid --cursor-mode", async () => {
		const { pi, ctx } = createCursorRuntimeHarness({
			provider: "anthropic",
			api: "anthropic-messages",
			modelId: "claude-sonnet-4-5",
			cursorModeFlag: "review",
			mode: "rpc",
			hasUI: true,
		});

		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(ctx.ui.notify).not.toHaveBeenCalled();
		expect(resolveCursorAgentMode()).toEqual({
			kind: "invalid",
			raw: "review",
			message: 'Invalid --cursor-mode "review". Use "agent" or "plan".',
		});
		expect(getStoredCursorAgentMode()).toBe("agent");
	});

	it("does not abort non-Cursor JSON sessions for invalid --cursor-mode", async () => {
		const { pi, ctx } = createCursorRuntimeHarness({
			provider: "anthropic",
			api: "anthropic-messages",
			modelId: "claude-sonnet-4-5",
			cursorModeFlag: "review",
			mode: "json",
			hasUI: false,
		});

		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(resolveCursorAgentMode()).toEqual({
			kind: "invalid",
			raw: "review",
			message: 'Invalid --cursor-mode "review". Use "agent" or "plan".',
		});
		expect(getStoredCursorAgentMode()).toBe("agent");
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

	it("rejects invalid --cursor-mode for Cursor provider runs", async () => {
		const { pi, ctx } = createCursorRuntimeHarness({
			modelId: "composer-2",
			cursorModeFlag: "review",
			mode: "rpc",
			hasUI: true,
		});

		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(() => getCursorProviderAgentModeOrThrow()).toThrow('Invalid --cursor-mode "review"');
	});

	it("persists /cursor-mode plan as session mode", async () => {
		const { pi, ctx, commandCtx, commands } = createCursorRuntimeHarness({ modelId: "gpt-5.5@1m" });
		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		await commands.get("cursor-mode")!.handler("plan", commandCtx);

		expect(pi.appendEntry).toHaveBeenCalledWith(__testUtils.MODE_ENTRY_TYPE, { mode: "plan" });
		expect(resolveCursorAgentMode()).toEqual({ kind: "valid", mode: "plan" });
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
					customType: __testUtils.MODE_ENTRY_TYPE,
					data: { mode: "plan" },
				},
			],
		});
		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);
		expect(resolveCursorAgentMode()).toEqual({ kind: "valid", mode: "plan" });

		await commands.get("cursor-mode")!.handler("agent", commandCtx);

		expect(pi.appendEntry).toHaveBeenCalledWith(__testUtils.MODE_ENTRY_TYPE, { mode: "agent" });
		expect(resolveCursorAgentMode()).toEqual({ kind: "valid", mode: "agent" });
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off");
		expect(ctx.ui.notify).toHaveBeenCalledWith("Cursor mode set to agent", "info");
	});

	it("reports current mode and usage for /cursor-mode with no args", async () => {
		const { pi, ctx, commandCtx, commands } = createCursorRuntimeHarness({ modelId: "gpt-5.5@1m", cursorModeFlag: "plan" });
		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		await commands.get("cursor-mode")!.handler("", commandCtx);

		expect(ctx.ui.notify).toHaveBeenCalledWith("Cursor mode is plan. Usage: /cursor-mode agent|plan", "info");
	});

	it("combines Cursor fast and plan mode in one status value", async () => {
		const { pi, ctx } = createCursorRuntimeHarness({ modelId: "composer-2", cursorModeFlag: "plan" });

		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:on · plan");
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

	it("toggles fast per session and writes the global default", async () => {
		const { pi, ctx, commandCtx, commands } = createCursorRuntimeHarness({ modelId: "composer-2" });
		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:on");

		await commands.get("cursor-fast")!.handler("", commandCtx);

		expect(pi.appendEntry).toHaveBeenCalledWith(__testUtils.FAST_ENTRY_TYPE, {
			modelId: "composer-2",
			fast: false,
		});
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off");
		expect(getEffectiveFastForModelId("composer-2")).toBe(false);
		expect(JSON.parse(readFileSync(__testUtils.getConfigPath(), "utf-8"))).toEqual({
			fastDefaults: { "composer-2": false },
		});
	});

	it("uses the selected Cursor SDK alias as the fast preference key", async () => {
		const { pi, ctx, commandCtx, commands } = createCursorRuntimeHarness({ modelId: "composer-2-5" });
		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:on");

		await commands.get("cursor-fast")!.handler("", commandCtx);

		expect(pi.appendEntry).toHaveBeenCalledWith(__testUtils.FAST_ENTRY_TYPE, {
			modelId: "composer-2-5",
			fast: false,
		});
		expect(getEffectiveFastForModelId("composer-2-5")).toBe(false);
		expect(JSON.parse(readFileSync(__testUtils.getConfigPath(), "utf-8"))).toEqual({
			fastDefaults: { "composer-2-5": false },
		});
	});

	it("restores legacy base-model fast preferences for Cursor SDK aliases", async () => {
		const { pi, ctx } = createCursorRuntimeHarness({
			modelId: "composer-2-5",
			branch: [
				{
					type: "custom",
					id: "fast-entry",
					parentId: null,
					timestamp: new Date(0).toISOString(),
					customType: __testUtils.FAST_ENTRY_TYPE,
					data: { baseModelId: "composer-2.5", fast: false },
				},
			],
		});

		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off");
		expect(getEffectiveFastForModelId("composer-2-5")).toBe(false);
	});

	it("keeps legacy session fast preferences above global alias defaults", async () => {
		writeFileSync(__testUtils.getConfigPath(), JSON.stringify({ fastDefaults: { "composer-2-5": true } }));
		const { pi, ctx } = createCursorRuntimeHarness({
			modelId: "composer-2-5",
			branch: [
				{
					type: "custom",
					id: "fast-entry",
					parentId: null,
					timestamp: new Date(0).toISOString(),
					customType: __testUtils.FAST_ENTRY_TYPE,
					data: { baseModelId: "composer-2.5", fast: false },
				},
			],
		});

		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off");
		expect(getEffectiveFastForModelId("composer-2-5")).toBe(false);
	});

	it("does not update fast state when the global config cannot be saved", async () => {
		const blockedAgentDir = join(tmpAgentDir, "not-a-directory");
		writeFileSync(blockedAgentDir, "x");
		process.env.PI_CODING_AGENT_DIR = blockedAgentDir;
		const { pi, ctx, commandCtx, commands } = createCursorRuntimeHarness({ modelId: "composer-2" });
		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		await commands.get("cursor-fast")!.handler("", commandCtx);

		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Failed to save Cursor fast preference"), "error");
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:on");
		expect(getEffectiveFastForModelId("composer-2")).toBe(true);
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("rolls fast state back when the session journal append fails", async () => {
		writeFileSync(__testUtils.getConfigPath(), JSON.stringify({ fastDefaults: { "composer-2": true } }));
		const { pi, ctx, commandCtx, commands } = createCursorRuntimeHarness({ modelId: "composer-2" });
		pi.appendEntry.mockImplementationOnce(() => {
			throw new Error("journal unavailable");
		});
		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		await commands.get("cursor-fast")!.handler("", commandCtx);

		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Failed to save Cursor fast preference"), "error");
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:on");
		expect(getEffectiveFastForModelId("composer-2")).toBe(true);
		expect(JSON.parse(readFileSync(__testUtils.getConfigPath(), "utf-8"))).toEqual({
			fastDefaults: { "composer-2": true },
		});
	});

	it("restores fast state from the active session branch", async () => {
		const { pi, ctx } = createCursorRuntimeHarness({
			modelId: "composer-2",
			branch: [
				{
					type: "custom",
					id: "fast-entry",
					parentId: null,
					timestamp: new Date(0).toISOString(),
					customType: __testUtils.FAST_ENTRY_TYPE,
					data: { baseModelId: "composer-2", fast: false },
				},
			],
		});

		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off");
		expect(getEffectiveFastForModelId("composer-2")).toBe(false);
	});

	it("uses global fast defaults for new sessions", async () => {
		writeFileSync(__testUtils.getConfigPath(), JSON.stringify({ fastDefaults: { "gpt-5.5": true } }));
		const { pi, ctx } = createCursorRuntimeHarness({ modelId: "gpt-5.5@1m" });

		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:on");
		expect(getEffectiveFastForModelId("gpt-5.5@1m")).toBe(true);
	});

	it("lets virtual fast models override stored slow preferences", async () => {
		writeFileSync(__testUtils.getConfigPath(), JSON.stringify({ fastDefaults: { "composer-2": false } }));
		const { pi, ctx } = createCursorRuntimeHarness({ modelId: "composer-2:fast" });

		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:on");
		expect(getEffectiveFastForModelId("composer-2:fast")).toBe(true);
	});

	it("lets virtual slow models override stored fast preferences", async () => {
		writeFileSync(__testUtils.getConfigPath(), JSON.stringify({ fastDefaults: { "composer-2": true } }));
		const { pi, ctx } = createCursorRuntimeHarness({ modelId: "composer-2:slow" });

		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off");
		expect(getEffectiveFastForModelId("composer-2:slow")).toBe(false);
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

	it("forces fast with the CLI flag without writing session state", async () => {
		const { pi, ctx } = createCursorRuntimeHarness({ modelId: "gpt-5.5@1m", cursorFastFlag: true });

		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:on");
		expect(getEffectiveFastForModelId("gpt-5.5@1m")).toBe(true);
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("forces fast off with --cursor-no-fast without writing session state", async () => {
		const { pi, ctx } = createCursorRuntimeHarness({ modelId: "composer-2", cursorNoFastFlag: true });

		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off");
		expect(getEffectiveFastForModelId("composer-2")).toBe(false);
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("maps local resume CLI flags and lets --cursor-no-local-resume win", async () => {
		let harness = createCursorRuntimeHarness({ cursorLocalResumeFlag: true });
		await harness.pi.runSessionStart({ model: makeModel("composer-2.5") });
		expect(getCursorCliConfig().local?.resume).toBe(true);

		harness = createCursorRuntimeHarness({ cursorLocalResumeFlag: true, cursorNoLocalResumeFlag: true });
		await harness.pi.runSessionStart({ model: makeModel("composer-2.5") });
		expect(getCursorCliConfig().local?.resume).toBe(false);
	});

	it("lets --cursor-no-fast win when both one-run force flags are set", async () => {
		const { pi, ctx } = createCursorRuntimeHarness({ modelId: "composer-2", cursorFastFlag: true, cursorNoFastFlag: true });

		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off");
		expect(getEffectiveFastForModelId("composer-2")).toBe(false);
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("does not apply --cursor-no-fast to unsupported Cursor models", async () => {
		const { pi, ctx } = createCursorRuntimeHarness({ modelId: "gemini-3.1-pro", cursorNoFastFlag: true });

		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:n/a");
		expect(getEffectiveFastForModelId("gemini-3.1-pro")).toBeUndefined();
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("keeps not-applicable fast status when unsupported Cursor models run in plan mode", async () => {
		const { pi, ctx } = createCursorRuntimeHarness({ modelId: "gemini-3.1-pro", cursorModeFlag: "plan" });

		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:n/a · plan");
		expect(getEffectiveFastForModelId("gemini-3.1-pro")).toBeUndefined();
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("does not let /cursor-fast persist while --cursor-no-fast is active", async () => {
		const { pi, ctx, commandCtx, commands } = createCursorRuntimeHarness({ modelId: "composer-2", cursorNoFastFlag: true });
		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		await commands.get("cursor-fast")!.handler("", commandCtx);

		expect(ctx.ui.notify).toHaveBeenCalledWith("Cursor fast is forced off by --cursor-no-fast", "info");
		expect(getEffectiveFastForModelId("composer-2")).toBe(false);
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("mentions --cursor-no-fast when both force flags block /cursor-fast", async () => {
		const { ctx, commandCtx, commands, pi } = createCursorRuntimeHarness({ modelId: "composer-2", cursorFastFlag: true, cursorNoFastFlag: true });
		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		await commands.get("cursor-fast")!.handler("", commandCtx);

		expect(ctx.ui.notify).toHaveBeenCalledWith("Cursor fast is forced off by --cursor-no-fast", "info");
	});

	it("does not let /cursor-fast persist an opposite value when --cursor-fast is active", async () => {
		const { pi, ctx, commandCtx, commands } = createCursorRuntimeHarness({ modelId: "gpt-5.5@1m", cursorFastFlag: true });
		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

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
		expect(JSON.parse(readFileSync(__testUtils.getConfigPath(), "utf-8"))).toEqual({
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
		writeFileSync(__testUtils.getConfigPath(), "{not json");
		const { pi, ctx } = createCursorRuntimeHarness({ modelId: "gpt-5.5@1m" });

		await expect(
			pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx),
		).resolves.toBeUndefined();

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off");
		expect(getEffectiveFastForModelId("gpt-5.5@1m")).toBe(false);
	});

	it("filters global config entries with invalid fast default values", async () => {
		writeFileSync(__testUtils.getConfigPath(), JSON.stringify({ fastDefaults: { "gpt-5.5": true, "composer-2": "true" } }));
		expect(__testUtils.loadGlobalFastPreferences()).toEqual(new Map([["gpt-5.5", true]]));
		const { pi, ctx } = createCursorRuntimeHarness({ modelId: "gpt-5.5@1m" });

		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:on");
		expect(getEffectiveFastForModelId("gpt-5.5@1m")).toBe(true);
	});

	it("does not apply or persist --cursor-fast for unsupported Cursor models", async () => {
		const { pi, ctx } = createCursorRuntimeHarness({ modelId: "gemini-3.1-pro", cursorFastFlag: true });

		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:n/a");
		expect(getEffectiveFastForModelId("gemini-3.1-pro")).toBeUndefined();
		expect(pi.appendEntry).not.toHaveBeenCalled();
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

	it("shows cloud runtime status from CLI runtime selection", async () => {
		const { pi, ctx } = createCursorRuntimeHarness({ modelId: "gpt-5.5@1m", cursorRuntimeFlag: "cloud" });

		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:cloud · fast:n/a");
	});

	it("shows cloud runtime status from env runtime selection", async () => {
		process.env.PI_CURSOR_RUNTIME = " cloud ";
		const { pi, ctx } = createCursorRuntimeHarness({ modelId: "gpt-5.5@1m" });

		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:cloud · fast:n/a");
	});

	it("shows cloud runtime status from user config", async () => {
		writeFileSync(__testUtils.getConfigPath(), JSON.stringify({ runtime: "cloud" }));
		const { pi, ctx } = createCursorRuntimeHarness({ modelId: "gpt-5.5@1m" });

		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:cloud · fast:n/a");
	});

	it("shows cloud runtime status from trusted project config", async () => {
		const cwd = join(tmpAgentDir, "project-runtime-status");
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "cursor-sdk.json"), JSON.stringify({ runtime: "cloud" }));
		const { pi, ctx } = createCursorRuntimeHarness({ modelId: "gpt-5.5@1m", cwd });

		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:cloud · fast:n/a");
	});

	it("lets CLI runtime override persisted session runtime in status", async () => {
		const cloudSessionEntry: SessionEntry = {
			type: "custom",
			id: "runtime-entry",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			customType: __testUtils.RUNTIME_ENTRY_TYPE,
			data: { runtime: "cloud", cloudAcknowledged: true },
		};
		const localSessionEntry: SessionEntry = {
			...cloudSessionEntry,
			id: "runtime-entry-local",
			data: { runtime: "local" },
		};
		const localOverride = createCursorRuntimeHarness({
			modelId: "gpt-5.5@1m",
			cursorRuntimeFlag: "local",
			branch: [cloudSessionEntry],
		});
		await localOverride.pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, localOverride.ctx);
		expect(localOverride.ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off");

		__testUtils.resetCursorModeStateForTests();
		const cloudOverride = createCursorRuntimeHarness({
			modelId: "gpt-5.5@1m",
			cursorRuntimeFlag: "cloud",
			branch: [localSessionEntry],
		});
		await cloudOverride.pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, cloudOverride.ctx);
		expect(cloudOverride.ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:cloud · fast:n/a");
	});

	it("preserves invalid CLI cloud environment type for cloud preflight", async () => {
		const pi = createPiHarness({ flagValues: { "cursor-cloud-env-type": "poll" } });
		registerCursorRuntimeControls(pi);
		await pi.runSessionStart({ model: makeModel("gpt-5.5@1m") });

		expect(getCursorCliConfig().cloud?.environment).toEqual({ type: "poll" });
	});

	it("persists /cursor-runtime as session runtime state", async () => {
		const { pi, ctx, commandCtx, commands } = createCursorRuntimeHarness({ modelId: "gpt-5.5@1m" });
		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		await commands.get("cursor-runtime")!.handler("cloud", commandCtx);

		expect(pi.appendEntry).toHaveBeenCalledWith(__testUtils.RUNTIME_ENTRY_TYPE, { runtime: "cloud", cloudAcknowledged: true });
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:cloud · fast:n/a");
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("first-use cloud risk acknowledged"), "info");
	});

	it("reports /cursor-runtime usage and rejects invalid values", async () => {
		const { pi, ctx, commandCtx, commands } = createCursorRuntimeHarness({ modelId: "gpt-5.5@1m" });
		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		await commands.get("cursor-runtime")!.handler("", commandCtx);
		await commands.get("cursor-runtime")!.handler("remote", commandCtx);

		expect(ctx.ui.notify).toHaveBeenCalledWith("Cursor runtime is local. Usage: /cursor-runtime local|cloud [--save-user|--save-project]", "info");
		expect(ctx.ui.notify).toHaveBeenCalledWith("Invalid Cursor runtime arguments. Usage: /cursor-runtime local|cloud [--save-user|--save-project]", "error");
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("saves /cursor-runtime cloud acknowledgement only to user or session state", async () => {
		const cwd = join(tmpAgentDir, "project");
		mkdirSync(cwd, { recursive: true });
		const { pi, commandCtx, commands } = createCursorRuntimeHarness({ modelId: "gpt-5.5@1m", cwd });
		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, commandCtx);

		await commands.get("cursor-runtime")!.handler("cloud --save-user", commandCtx);

		expect(JSON.parse(readFileSync(join(tmpAgentDir, "cursor-sdk.json"), "utf-8"))).toEqual({
			runtime: "cloud",
			cloud: { acknowledged: true },
		});
	});

	it("saves /cursor-runtime project default without project-level cloud acknowledgement", async () => {
		const cwd = join(tmpAgentDir, "project");
		mkdirSync(cwd, { recursive: true });
		const { pi, commandCtx, commands } = createCursorRuntimeHarness({ modelId: "gpt-5.5@1m", cwd });
		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, commandCtx);

		await commands.get("cursor-runtime")!.handler("cloud --save-project", commandCtx);

		expect(JSON.parse(readFileSync(join(cwd, ".pi", "cursor-sdk.json"), "utf-8"))).toEqual({ runtime: "cloud" });
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
			registerCursorRuntimeControls(pi);
			const ctx = createExtensionTestContext();
			await pi.runCommand("cursor-tools", "", { ui: ctx.ui, hasUI: true });

			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("PI_CURSOR_PI_TOOL_BRIDGE: enabled"), "info");
			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("PI_CURSOR_SETTING_SOURCES: none (effective: none)"), "info");
			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Callable tool surfaces this run:"), "info");
			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("pi__custom_bridge_tool"), "info");
			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Cursor host/MCP"), "info");
			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Pi tool toggles affect pi tools/bridge exposure only"), "info");
		} finally {
			if (originalBridgeEnv === undefined) delete process.env.PI_CURSOR_PI_TOOL_BRIDGE;
			else process.env.PI_CURSOR_PI_TOOL_BRIDGE = originalBridgeEnv;
			if (originalSettingSourcesEnv === undefined) delete process.env.PI_CURSOR_SETTING_SOURCES;
			else process.env.PI_CURSOR_SETTING_SOURCES = originalSettingSourcesEnv;
		}
	});

	it("formatCursorToolsDebugReport notes disabled bridge", () => {
		const pi = createPiHarness();
		const report = formatCursorToolsDebugReport(pi, {
			PI_CURSOR_PI_TOOL_BRIDGE: "0",
			PI_CURSOR_SETTING_SOURCES: "project",
		});
		expect(report).toContain("PI_CURSOR_PI_TOOL_BRIDGE: disabled");
		expect(report).toContain("Pi bridge: disabled (PI_CURSOR_PI_TOOL_BRIDGE=0).");
		expect(report).toContain("PI_CURSOR_SETTING_SOURCES: project (effective: project)");
		expect(report).toContain("Callable tool surfaces this run:");
	});

	it("formatCursorToolsDebugReport notes disabled manifest", () => {
		const pi = createPiHarness();
		const report = formatCursorToolsDebugReport(pi, {
			PI_CURSOR_TOOL_MANIFEST: "0",
		});
		expect(report).toContain("PI_CURSOR_TOOL_MANIFEST: disabled");
	});

	it("logs /cursor-tools to stdout when UI is unavailable", async () => {
		const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
		try {
			const pi = createPiHarness();
			registerCursorRuntimeControls(pi);
			await pi.runCommand("cursor-tools", "", { hasUI: false });

			expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Cursor tool surfaces (current session):"));
			expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Callable tool surfaces this run:"));
		} finally {
			consoleSpy.mockRestore();
		}
	});
});
