import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelListItem } from "@cursor/sdk";
import { SessionManager, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { CURSOR_HTTP1_ENV } from "../src/cursor-config.js";
import {
	__testUtils,
	getEffectiveFastForModelId,
	registerCursorRuntimeControls,
} from "../src/cursor-state.js";
import { __testUtils as modelDiscoveryTestUtils } from "../src/model-discovery.js";
import {
	createExtensionCommandContext,
	createExtensionTestContext,
	createPiHarness,
	makeAssistantMessage,
	makeModel,
} from "./helpers/pi-harness.js";

const modelItems: ModelListItem[] = [
	{
		id: "composer-2",
		displayName: "Cursor Composer 2",
		parameters: [{ id: "fast", displayName: "Fast", values: [{ value: "false" }, { value: "true" }] }],
		variants: [{
			params: [{ id: "fast", value: "true" }],
			displayName: "Cursor Composer 2",
			isDefault: true,
		}],
	},
	{
		id: "composer-2.5",
		displayName: "Cursor Composer 2.5",
		aliases: ["composer-2-5"],
		parameters: [{ id: "fast", displayName: "Fast", values: [{ value: "false" }, { value: "true" }] }],
		variants: [{
			params: [{ id: "fast", value: "true" }],
			displayName: "Cursor Composer 2.5",
			isDefault: true,
		}],
	},
];

function createFastHarness(options: { modelId?: string; branch?: SessionEntry[] } = {}) {
	const pi = createPiHarness();
	const ctx = createExtensionTestContext({
		model: options.modelId
			? { ...makeModel(options.modelId), provider: "cursor", api: "cursor-sdk" }
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

describe("Cursor fast preference persistence", () => {
	let tmpAgentDir: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const originalHttp1Env = process.env[CURSOR_HTTP1_ENV];

	beforeEach(() => {
		tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-cursor-fast-persistence-"));
		process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
		delete process.env[CURSOR_HTTP1_ENV];
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
		if (originalHttp1Env === undefined) delete process.env[CURSOR_HTTP1_ENV];
		else process.env[CURSOR_HTTP1_ENV] = originalHttp1Env;
		rmSync(tmpAgentDir, { recursive: true, force: true });
		vi.clearAllMocks();
	});

	it("toggles fast per session and writes the global default", async () => {
		const { pi, ctx, commandCtx, commands } = createFastHarness({ modelId: "composer-2" });
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

	it("preserves forward-compatible config fields when saving fast defaults", async () => {
		writeFileSync(__testUtils.getConfigPath(), JSON.stringify({
			future: { enabled: true },
			cloud: { futureCloud: "kept" },
			fastDefaults: { "composer-2": true },
		}));
		const { pi, ctx, commandCtx, commands } = createFastHarness({ modelId: "composer-2" });
		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		await commands.get("cursor-fast")!.handler("", commandCtx);

		expect(JSON.parse(readFileSync(__testUtils.getConfigPath(), "utf-8"))).toEqual({
			future: { enabled: true },
			cloud: { futureCloud: "kept" },
			fastDefaults: { "composer-2": false },
		});
	});

	it("rejects malformed config before saving fast defaults or appending session state", async () => {
		const sentinel = "PI_CURSOR_MALFORMED_SECRET";
		writeFileSync(__testUtils.getConfigPath(), `{"secret":"${sentinel}`);
		const { pi, ctx, commandCtx, commands } = createFastHarness({ modelId: "composer-2" });
		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		await commands.get("cursor-fast")!.handler("", commandCtx);

		expect(readFileSync(__testUtils.getConfigPath(), "utf-8")).toBe(`{"secret":"${sentinel}`);
		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Failed to save Cursor fast preference"), "error");
		expect(vi.mocked(ctx.ui.notify).mock.calls.flat().join("\n")).not.toContain(sentinel);
	});

	it("uses the selected Cursor SDK alias as the fast preference key", async () => {
		const { pi, ctx, commandCtx, commands } = createFastHarness({ modelId: "composer-2-5" });
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
		const { pi, ctx } = createFastHarness({
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
		const { pi, ctx } = createFastHarness({
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
		const { pi, ctx, commandCtx, commands } = createFastHarness({ modelId: "composer-2" });
		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		await commands.get("cursor-fast")!.handler("", commandCtx);

		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Failed to save Cursor fast preference"), "error");
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:on");
		expect(getEffectiveFastForModelId("composer-2")).toBe(true);
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("keeps the global fast save authoritative when session append fails", async () => {
		writeFileSync(__testUtils.getConfigPath(), JSON.stringify({ fastDefaults: { "composer-2": true } }));
		const { pi, ctx, commandCtx, commands } = createFastHarness({ modelId: "composer-2" });
		pi.appendEntry.mockImplementationOnce(() => {
			throw new Error("journal unavailable");
		});
		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		await commands.get("cursor-fast")!.handler("", commandCtx);

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("was saved globally, but persisting the session entry failed"),
			"error",
		);
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off");
		expect(getEffectiveFastForModelId("composer-2")).toBe(false);
		expect(JSON.parse(readFileSync(__testUtils.getConfigPath(), "utf-8"))).toEqual({
			fastDefaults: { "composer-2": false },
		});
	});

	it("keeps new and forward-compatible config changes when session append fails", async () => {
		const path = __testUtils.getConfigPath();
		const original = {
			future: { enabled: true },
			fastDefaults: { "composer-2": "future-value", other: true },
		};
		writeFileSync(path, JSON.stringify(original));
		const { pi, ctx, commandCtx, commands } = createFastHarness({ modelId: "composer-2" });
		pi.appendEntry.mockImplementationOnce(() => {
			throw new Error("journal unavailable");
		});
		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		await commands.get("cursor-fast")!.handler("", commandCtx);

		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
			future: { enabled: true },
			fastDefaults: { "composer-2": false, other: true },
		});
		expect(existsSync(`${path}.lock`)).toBe(false);
	});

	it.each([false, true])(
		"keeps failed append globally authoritative across tree restore (side effect: %s)",
		async (sideEffect) => {
			writeFileSync(__testUtils.getConfigPath(), JSON.stringify({ fastDefaults: { "composer-2": true } }));
			const branch: SessionEntry[] = [{
				type: "custom",
				id: "existing-fast",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				customType: __testUtils.FAST_ENTRY_TYPE,
				data: { modelId: "composer-2", fast: true },
			}];
			const { pi, ctx, commandCtx, commands } = createFastHarness({ modelId: "composer-2", branch });
			pi.appendEntry.mockImplementationOnce((customType, data) => {
				if (sideEffect) {
					branch.push({
						type: "custom",
						id: "partially-appended-fast",
						parentId: "existing-fast",
						timestamp: new Date(1).toISOString(),
						customType,
						data,
					});
				}
				throw new Error("journal unavailable");
			});
			await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

			await commands.get("cursor-fast")!.handler("", commandCtx);
			await pi.invokeEventWithContext("session_tree", { type: "session_tree", oldLeafId: null, newLeafId: null }, ctx);

			expect(getEffectiveFastForModelId("composer-2")).toBe(false);
			expect(JSON.parse(readFileSync(__testUtils.getConfigPath(), "utf8"))).toEqual({
				fastDefaults: { "composer-2": false },
			});
		},
	);

	it("clears failed-append authority after a later successful append", async () => {
		writeFileSync(__testUtils.getConfigPath(), JSON.stringify({ fastDefaults: { "composer-2": true } }));
		const branch: SessionEntry[] = [{
			type: "custom",
			id: "initial-fast",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			customType: __testUtils.FAST_ENTRY_TYPE,
			data: { modelId: "composer-2", fast: true },
		}];
		const { pi, ctx, commandCtx, commands } = createFastHarness({ modelId: "composer-2", branch });
		pi.appendEntry.mockImplementationOnce(() => { throw new Error("journal unavailable"); });
		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		await commands.get("cursor-fast")!.handler("", commandCtx);
		await commands.get("cursor-fast")!.handler("", commandCtx);
		branch.splice(0, branch.length, {
			type: "custom",
			id: "contrary-fast",
			parentId: null,
			timestamp: new Date(1).toISOString(),
			customType: __testUtils.FAST_ENTRY_TYPE,
			data: { modelId: "composer-2", fast: false },
		});
		await pi.invokeEventWithContext("session_tree", { type: "session_tree", oldLeafId: null, newLeafId: null }, ctx);

		expect(getEffectiveFastForModelId("composer-2")).toBe(false);
	});

	it("clears failed-append authority on session start", async () => {
		writeFileSync(__testUtils.getConfigPath(), JSON.stringify({ fastDefaults: { "composer-2": true } }));
		const branch: SessionEntry[] = [{
			type: "custom",
			id: "contrary-fast",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			customType: __testUtils.FAST_ENTRY_TYPE,
			data: { modelId: "composer-2", fast: true },
		}];
		const { pi, ctx, commandCtx, commands } = createFastHarness({ modelId: "composer-2", branch });
		pi.appendEntry.mockImplementationOnce(() => { throw new Error("journal unavailable"); });
		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		await commands.get("cursor-fast")!.handler("", commandCtx);
		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "reload" }, ctx);

		expect(getEffectiveFastForModelId("composer-2")).toBe(true);
	});

	it("keeps failed alias authority scoped away from legacy base-model preferences", async () => {
		writeFileSync(__testUtils.getConfigPath(), JSON.stringify({ fastDefaults: { "composer-2-5": false } }));
		const branch: SessionEntry[] = [{
			type: "custom",
			id: "legacy-fast",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			customType: __testUtils.FAST_ENTRY_TYPE,
			data: { baseModelId: "composer-2.5", fast: false },
		}];
		const { pi, ctx, commandCtx, commands } = createFastHarness({ modelId: "composer-2-5", branch });
		pi.appendEntry.mockImplementationOnce(() => { throw new Error("journal unavailable"); });
		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		await commands.get("cursor-fast")!.handler("", commandCtx);
		await pi.invokeEventWithContext("session_tree", { type: "session_tree", oldLeafId: null, newLeafId: null }, ctx);

		expect(getEffectiveFastForModelId("composer-2-5")).toBe(true);
		expect(getEffectiveFastForModelId("composer-2.5")).toBe(false);
	});

	it("contracts Pi append failure as a possible in-memory partial commit", () => {
		const manager = SessionManager.create(tmpAgentDir, tmpAgentDir, { id: "fast-append-contract" });
		manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		manager.appendMessage(makeAssistantMessage("ready"));
		const sessionFile = manager.getSessionFile()!;
		const savedSessionFile = `${sessionFile}.saved`;
		renameSync(sessionFile, savedSessionFile);
		mkdirSync(sessionFile);

		try {
			expect(() => manager.appendCustomEntry(__testUtils.FAST_ENTRY_TYPE, { modelId: "composer-2", fast: false })).toThrow();
		} finally {
			// Restore the same journal before reading; native managers may refresh it from disk.
			rmSync(sessionFile, { recursive: true });
			renameSync(savedSessionFile, sessionFile);
		}
		expect(manager.getBranch()).toEqual(expect.arrayContaining([
			expect.objectContaining({
				type: "custom",
				customType: __testUtils.FAST_ENTRY_TYPE,
				data: { modelId: "composer-2", fast: false },
			}),
		]));
	});

});
