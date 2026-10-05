import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { CURSOR_HTTP1_ENV } from "../src/cursor-config.js";
import {
	__testUtils,
	CURSOR_FOOTER_ENV,
	getCursorCliConfig,
	getCursorSessionConfig,
	registerCursorRuntimeControls,
} from "../src/cursor-state.js";
import { CURSOR_CLOUD_ACK_DISCLOSURE } from "../src/cursor-runtime-state.js";
import {
	__testUtils as cursorSessionScopeTestUtils,
	registerCursorSessionScope,
	getCursorSessionScopeSnapshot,
} from "../src/cursor-session-scope.js";
import { __testUtils as modelDiscoveryTestUtils } from "../src/model-discovery.js";
import {
	createExtensionCommandContext,
	createExtensionTestContext,
	createPiHarness,
	makeModel,
} from "./helpers/pi-harness.js";
import {
	collectEvents,
	getErrorEvent,
	mockCreatedAgent,
	mockedCreate,
	resetCursorProviderTestState,
} from "./helpers/cursor-provider-harness.js";
import { streamCursor } from "../src/cursor-provider.js";
import { registerCursorNativeToolDisplayState } from "../src/cursor-native-tool-display-state.js";
import { captureProviderTestOwnership } from "./helpers/cursor-provider-ownership.js";

const RUNTIME_ENV_NAMES = [
	"PI_CURSOR_RUNTIME",
	"PI_CURSOR_CLOUD_CONTEXT",
	"PI_CURSOR_CLOUD_AUTO_CREATE_PR",
	"PI_CURSOR_CLOUD_SKIP_REVIEWER_REQUEST",
	"PI_CURSOR_CLOUD_ACK",
	CURSOR_HTTP1_ENV,
	CURSOR_FOOTER_ENV,
] as const;

function createCursorRuntimeHarness(options: {
	branch?: SessionEntry[];
	cursorRuntimeFlag?: string;
	cursorCloudContextFlag?: string;
	cursorCloudAckFlag?: boolean;
	confirm?: boolean;
	hasUI?: boolean;
	cwd?: string;
	projectTrusted?: boolean;
} = {}) {
	const pi = createPiHarness({
		flagValues: {
			"cursor-runtime": options.cursorRuntimeFlag ?? "",
			"cursor-cloud-context": options.cursorCloudContextFlag ?? "",
			"cursor-cloud-ack": options.cursorCloudAckFlag ?? false,
		},
	});
	const confirm = vi.fn(async () => options.confirm ?? false);
	const ctx = createExtensionTestContext({
		cwd: options.cwd ?? process.cwd(),
		hasUI: options.hasUI ?? true,
		isProjectTrusted: vi.fn(() => options.projectTrusted ?? true),
		model: makeModel("gpt-5.5@1m"),
		ui: { confirm },
		sessionManager: {
			getBranch: vi.fn<ExtensionContext["sessionManager"]["getBranch"]>(() => options.branch ?? []),
		},
	});
	registerCursorSessionScope(pi);
	registerCursorRuntimeControls(pi);
	const commandCtx = createExtensionCommandContext({
		cwd: ctx.cwd,
		hasUI: ctx.hasUI,
		isProjectTrusted: ctx.isProjectTrusted,
		model: ctx.model,
		ui: ctx.ui,
		sessionManager: ctx.sessionManager,
	});
	return { pi, ctx, commandCtx, commands: pi._commands, confirm };
}

function runtimeEntry(runtime: "local" | "cloud", cloudAcknowledged = false): SessionEntry {
	return {
		type: "custom",
		id: `runtime-${runtime}`,
		parentId: null,
		timestamp: new Date(0).toISOString(),
		customType: __testUtils.RUNTIME_ENTRY_TYPE,
		data: { runtime, ...(cloudAcknowledged ? { cloudAcknowledged } : {}) },
	};
}

describe("Cursor cloud runtime state", () => {
	let tmpAgentDir: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const originalEnv = new Map<string, string | undefined>();

	beforeEach(() => {
		tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-cursor-runtime-state-"));
		process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
		for (const name of RUNTIME_ENV_NAMES) {
			originalEnv.set(name, process.env[name]);
			delete process.env[name];
		}
		__testUtils.resetCursorModeStateForTests();
		modelDiscoveryTestUtils.registerModelItems([{
			id: "gpt-5.5",
			displayName: "GPT-5.5",
			parameters: [
				{ id: "context", displayName: "Context", values: [{ value: "1m" }] },
				{ id: "fast", displayName: "Fast", values: [{ value: "false" }, { value: "true" }] },
			],
			variants: [{
				params: [{ id: "context", value: "1m" }, { id: "fast", value: "false" }],
				displayName: "GPT-5.5",
				isDefault: true,
			}],
		}]);
	});

	afterEach(() => {
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		for (const name of RUNTIME_ENV_NAMES) {
			const value = originalEnv.get(name);
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		originalEnv.clear();
		rmSync(tmpAgentDir, { recursive: true, force: true });
		vi.clearAllMocks();
	});

	it.each(["0", "false", "off", "none", "no", "disabled", " OFF "])("clears an existing footer when PI_CURSOR_FOOTER=%s", async value => {
		const harness = createCursorRuntimeHarness();
		await harness.pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, harness.ctx);
		expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off");
		process.env[CURSOR_FOOTER_ENV] = value;
		await harness.pi.invokeEventWithContext("session_tree", { type: "session_tree", oldLeafId: null, newLeafId: null }, harness.ctx);
		expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", undefined);
		process.env[CURSOR_FOOTER_ENV] = "1";
		await harness.pi.invokeEventWithContext("session_tree", { type: "session_tree", oldLeafId: null, newLeafId: null }, harness.ctx);
		expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off");
	});

	it.each([undefined, "", "unknown", "1", "true", "on", "yes", "enabled"])("keeps the default footer visible for PI_CURSOR_FOOTER=%s", async value => {
		if (value !== undefined) process.env[CURSOR_FOOTER_ENV] = value;
		const harness = createCursorRuntimeHarness({ cursorRuntimeFlag: "cloud" });
		await harness.pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, harness.ctx);
		expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:cloud · fast:n/a");
	});

	it("rejects an invalid runtime before SDK creation with the footer hidden", async () => {
		await resetCursorProviderTestState();
		process.env[CURSOR_FOOTER_ENV] = "0";
		process.env.PI_CURSOR_RUNTIME = "remote";
		const harness = createCursorRuntimeHarness();
		await harness.pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, harness.ctx);
		expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", undefined);
		registerCursorNativeToolDisplayState(harness.pi);
		const model = makeModel("gpt-5.5@1m");
		const context = { messages: [{ role: "user" as const, content: "hello", timestamp: 1 }] };
		const ownership = captureProviderTestOwnership(model, context, undefined, harness.pi);
		const events = await collectEvents(streamCursor(model, context, { apiKey: "offline-key" }, ownership));
		expect(getErrorEvent(events).error.errorMessage).toContain("Invalid PI_CURSOR_RUNTIME");
		expect(mockedCreate).not.toHaveBeenCalled();
	});

	it("shows cloud runtime status from CLI and environment selection", async () => {
		let harness = createCursorRuntimeHarness({ cursorRuntimeFlag: "cloud" });
		await harness.pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, harness.ctx);
		expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:cloud · fast:n/a");

		__testUtils.resetCursorModeStateForTests();
		process.env.PI_CURSOR_RUNTIME = " cloud ";
		harness = createCursorRuntimeHarness();
		await harness.pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, harness.ctx);
		expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:cloud · fast:n/a");
	});

	it("shows invalid status and refuses writes for invalid explicit overrides", async () => {
		const harness = createCursorRuntimeHarness({ cursorRuntimeFlag: "remote" });
		await harness.pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, harness.ctx);
		expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:invalid · fast:n/a");

		await harness.commands.get("cursor-runtime")!.handler("", harness.commandCtx);
		await harness.commands.get("cursor-runtime")!.handler("cloud", harness.commandCtx);

		expect(harness.ctx.ui.notify).toHaveBeenCalledWith(
			'Invalid --cursor-runtime "remote". Use "local" or "cloud". Usage: /cursor-runtime local|cloud [--save-user|--save-project]',
			"error",
		);
		expect(harness.ctx.ui.notify).toHaveBeenCalledWith(
			'Invalid --cursor-runtime "remote". Use "local" or "cloud". Fix the explicit override before changing the session runtime.',
			"error",
		);
		expect(harness.pi.appendEntry).not.toHaveBeenCalled();
	});

	it("shows invalid status for invalid CLI and env cloud-context overrides", async () => {
		let harness = createCursorRuntimeHarness({ cursorCloudContextFlag: "reuse" });
		await harness.pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, harness.ctx);
		expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:invalid · fast:n/a");

		__testUtils.resetCursorModeStateForTests();
		process.env.PI_CURSOR_CLOUD_CONTEXT = "reuse";
		harness = createCursorRuntimeHarness();
		await harness.pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, harness.ctx);
		expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:invalid · fast:n/a");
	});

	it("reports CLI and env runtime sources instead of raw session state", async () => {
		let harness = createCursorRuntimeHarness({
			cursorRuntimeFlag: "local",
			branch: [runtimeEntry("cloud", true)],
		});
		await harness.pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, harness.ctx);
		await harness.commands.get("cursor-runtime")!.handler("", harness.commandCtx);
		expect(harness.ctx.ui.notify).toHaveBeenCalledWith(
			"Cursor runtime is local (source: cli). Usage: /cursor-runtime local|cloud [--save-user|--save-project]",
			"info",
		);

		__testUtils.resetCursorModeStateForTests();
		process.env.PI_CURSOR_RUNTIME = "local";
		harness = createCursorRuntimeHarness({ branch: [runtimeEntry("cloud", true)] });
		await harness.pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, harness.ctx);
		await harness.commands.get("cursor-runtime")!.handler("", harness.commandCtx);
		expect(harness.ctx.ui.notify).toHaveBeenCalledWith(
			"Cursor runtime is local (source: environment). Usage: /cursor-runtime local|cloud [--save-user|--save-project]",
			"info",
		);
	});

	it("reports user safety caps over requested session runtime", async () => {
		writeFileSync(__testUtils.getConfigPath(), JSON.stringify({ runtime: "local" }));
		const harness = createCursorRuntimeHarness({ branch: [runtimeEntry("cloud", true)] });
		await harness.pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, harness.ctx);
		await harness.commands.get("cursor-runtime")!.handler("", harness.commandCtx);
		expect(harness.ctx.ui.notify).toHaveBeenCalledWith(
			"Cursor runtime is local (source: user safety cap over session cloud). Usage: /cursor-runtime local|cloud [--save-user|--save-project]",
			"info",
		);
	});

	it("shows cloud status from user and trusted project config", async () => {
		writeFileSync(__testUtils.getConfigPath(), JSON.stringify({ runtime: "cloud" }));
		let harness = createCursorRuntimeHarness();
		await harness.pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, harness.ctx);
		expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:cloud · fast:n/a");

		writeFileSync(__testUtils.getConfigPath(), "{}");
		__testUtils.resetCursorModeStateForTests();
		const cwd = join(tmpAgentDir, "project-runtime-status");
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), "{}\n");
		writeFileSync(join(cwd, ".pi", "cursor-sdk.json"), JSON.stringify({ runtime: "cloud" }));
		harness = createCursorRuntimeHarness({ cwd });
		cursorSessionScopeTestUtils.recordProjectTrustResolution(cwd);
		await harness.pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, harness.ctx);
		expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:cloud · fast:n/a");
	});

	it("lets CLI runtime override persisted session runtime in status", async () => {
		let harness = createCursorRuntimeHarness({ cursorRuntimeFlag: "local", branch: [runtimeEntry("cloud", true)] });
		await harness.pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, harness.ctx);
		expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off");

		__testUtils.resetCursorModeStateForTests();
		harness = createCursorRuntimeHarness({ cursorRuntimeFlag: "cloud", branch: [runtimeEntry("local")] });
		await harness.pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, harness.ctx);
		expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:cloud · fast:n/a");
	});

	it("preserves invalid CLI cloud environment type for cloud preflight", async () => {
		const pi = createPiHarness({ flagValues: { "cursor-cloud-env-type": "poll" } });
		registerCursorSessionScope(pi);
		registerCursorRuntimeControls(pi);
		await pi.runSessionStart({ model: makeModel("gpt-5.5@1m") });
		expect(getCursorCliConfig().cloud?.environment).toEqual({ type: "poll" });
	});

	it("shows the complete first-use disclosure before persisting cloud state", async () => {
		const harness = createCursorRuntimeHarness({ confirm: true });
		await harness.pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, harness.ctx);

		await harness.commands.get("cursor-runtime")!.handler("cloud", harness.commandCtx);

		expect(harness.confirm).toHaveBeenCalledOnce();
		expect(harness.confirm).toHaveBeenCalledWith("Enable Cursor Cloud runtime?", CURSOR_CLOUD_ACK_DISCLOSURE);
		expect(CURSOR_CLOUD_ACK_DISCLOSURE).toContain("remotely");
		expect(CURSOR_CLOUD_ACK_DISCLOSURE).toContain("bootstrap opt-in");
		expect(CURSOR_CLOUD_ACK_DISCLOSURE).toContain("Pi-local tools");
		expect(CURSOR_CLOUD_ACK_DISCLOSURE).toContain("branch");
		expect(CURSOR_CLOUD_ACK_DISCLOSURE).toContain("archive or delete");
		expect(CURSOR_CLOUD_ACK_DISCLOSURE).toContain("Max Mode");
		expect(CURSOR_CLOUD_ACK_DISCLOSURE).toContain("Cursor API pricing");
		expect(CURSOR_CLOUD_ACK_DISCLOSURE).toContain("spend-limit");
		expect(harness.pi.appendEntry).toHaveBeenCalledWith(__testUtils.RUNTIME_ENTRY_TYPE, {
			runtime: "cloud",
			cloudAcknowledged: true,
		});
	});

	it("keeps cloud acknowledgement across cloud to local to cloud changes", async () => {
		const harness = createCursorRuntimeHarness({ confirm: true });
		await harness.pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, harness.ctx);

		await harness.commands.get("cursor-runtime")!.handler("cloud", harness.commandCtx);
		await harness.commands.get("cursor-runtime")!.handler("local", harness.commandCtx);
		await harness.commands.get("cursor-runtime")!.handler("cloud", harness.commandCtx);

		expect(harness.confirm).toHaveBeenCalledOnce();
		expect(harness.pi.appendEntry).toHaveBeenNthCalledWith(2, __testUtils.RUNTIME_ENTRY_TYPE, {
			runtime: "local",
			cloudAcknowledged: true,
		});
		expect(harness.pi.appendEntry).toHaveBeenNthCalledWith(3, __testUtils.RUNTIME_ENTRY_TYPE, {
			runtime: "cloud",
			cloudAcknowledged: true,
		});
	});

	it("restores cloud acknowledgement monotonically from the active branch", async () => {
		const harness = createCursorRuntimeHarness({
			branch: [runtimeEntry("cloud", true), runtimeEntry("local")],
		});
		await harness.pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, harness.ctx);

		await harness.commands.get("cursor-runtime")!.handler("cloud", harness.commandCtx);

		expect(harness.confirm).not.toHaveBeenCalled();
		expect(harness.pi.appendEntry).toHaveBeenCalledWith(__testUtils.RUNTIME_ENTRY_TYPE, {
			runtime: "cloud",
			cloudAcknowledged: true,
		});
	});

	it("restores branch-scoped runtime and acknowledgement on session tree navigation", async () => {
		const harness = createCursorRuntimeHarness({ branch: [runtimeEntry("local")] });
		const getBranch = vi.mocked(harness.ctx.sessionManager.getBranch);
		await harness.pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, harness.ctx);
		expect(getCursorSessionConfig()).toEqual({ runtime: "local" });

		getBranch.mockReturnValue([runtimeEntry("cloud", true)]);
		await harness.pi.invokeEventWithContext(
			"session_tree",
			{ type: "session_tree", oldLeafId: null, newLeafId: null },
			harness.ctx,
		);
		expect(getCursorSessionConfig()).toEqual({ runtime: "cloud", cloud: { acknowledged: true } });
		expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:cloud · fast:n/a");

		getBranch.mockReturnValue([]);
		await harness.pi.invokeEventWithContext(
			"session_tree",
			{ type: "session_tree", oldLeafId: null, newLeafId: null },
			harness.ctx,
		);
		expect(getCursorSessionConfig()).toEqual({});
		expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off");

		await harness.commands.get("cursor-runtime")!.handler("cloud", harness.commandCtx);
		expect(harness.confirm).toHaveBeenCalledOnce();
		expect(harness.pi.appendEntry).not.toHaveBeenCalled();
	});

	it("cancels user save and rejects untrusted project save without config writes", async () => {
		const cwd = join(tmpAgentDir, "cancelled-project");
		mkdirSync(cwd, { recursive: true });
		const harness = createCursorRuntimeHarness({ cwd, confirm: false });
		await harness.pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, harness.ctx);

		await harness.commands.get("cursor-runtime")!.handler("cloud --save-user", harness.commandCtx);
		await harness.commands.get("cursor-runtime")!.handler("cloud --save-project", harness.commandCtx);

		expect(harness.confirm).toHaveBeenCalledOnce();
		expect(harness.pi.appendEntry).not.toHaveBeenCalled();
		expect(harness.ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("Cannot save Cursor project config without explicit project-trust provenance"),
			"error",
		);
		expect(() => readFileSync(join(tmpAgentDir, "cursor-sdk.json"), "utf8")).toThrow();
		expect(() => readFileSync(join(cwd, ".pi", "cursor-sdk.json"), "utf8")).toThrow();
		expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off");
	});

	it("does not re-prompt for CLI acknowledgement", async () => {
		const harness = createCursorRuntimeHarness({ cursorCloudAckFlag: true });
		await harness.pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, harness.ctx);
		await harness.commands.get("cursor-runtime")!.handler("cloud", harness.commandCtx);
		expect(harness.confirm).not.toHaveBeenCalled();
		expect(harness.pi.appendEntry).toHaveBeenCalledWith(__testUtils.RUNTIME_ENTRY_TYPE, {
			runtime: "cloud",
			cloudAcknowledged: true,
		});
	});

	it("requires explicit acknowledgement for noninteractive cloud selection", async () => {
		const harness = createCursorRuntimeHarness({ hasUI: false });
		await harness.pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, harness.ctx);
		await harness.commands.get("cursor-runtime")!.handler("cloud", harness.commandCtx);
		expect(harness.confirm).not.toHaveBeenCalled();
		expect(harness.pi.appendEntry).not.toHaveBeenCalled();
		expect(harness.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("--cursor-cloud-ack"), "error");
	});

	it("reports usage and rejects invalid values", async () => {
		const harness = createCursorRuntimeHarness();
		await harness.pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, harness.ctx);
		await harness.commands.get("cursor-runtime")!.handler("", harness.commandCtx);
		await harness.commands.get("cursor-runtime")!.handler("remote", harness.commandCtx);
		expect(harness.ctx.ui.notify).toHaveBeenCalledWith(
			"Cursor runtime is local (source: builtin). Usage: /cursor-runtime local|cloud [--save-user|--save-project]",
			"info",
		);
		expect(harness.pi.appendEntry).not.toHaveBeenCalled();
	});

	it.each(["user", "project"] as const)(
		"does not append session state when %s config persistence fails",
		async (target) => {
			let cwd: string | undefined;
			if (target === "user") {
				const blockedAgentDir = join(tmpAgentDir, "blocked-agent-dir");
				writeFileSync(blockedAgentDir, "not a directory");
				process.env.PI_CODING_AGENT_DIR = blockedAgentDir;
			} else {
				cwd = join(tmpAgentDir, "blocked-project");
				mkdirSync(join(cwd, ".pi"), { recursive: true });
				writeFileSync(join(cwd, ".pi", "settings.json"), "{}\n");
				mkdirSync(join(cwd, ".pi", "cursor-sdk.json"));
			}
			const harness = createCursorRuntimeHarness({ cwd, confirm: true });
			if (cwd) cursorSessionScopeTestUtils.recordProjectTrustResolution(cwd);
			await harness.pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, harness.ctx);

			await harness.commands.get("cursor-runtime")!.handler(`cloud --save-${target}`, harness.commandCtx);

			expect(harness.pi.appendEntry).not.toHaveBeenCalled();
			expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off");
			expect(harness.ctx.ui.notify).toHaveBeenCalledWith(
				expect.stringContaining(`Failed to save Cursor runtime preference to ${target} config`),
				"error",
			);
			expect(harness.ctx.ui.notify).toHaveBeenCalledWith(
				expect.stringContaining("Effective runtime remains local (source: builtin)"),
				"error",
			);
		},
	);

	it.each(["user", "project"] as const)(
		"reports persisted %s config when the session append fails",
		async (target) => {
			const cwd = target === "project" ? join(tmpAgentDir, "partial-project") : undefined;
			if (cwd) {
				mkdirSync(join(cwd, ".pi"), { recursive: true });
				writeFileSync(join(cwd, ".pi", "settings.json"), "{}\n");
			}
			const harness = createCursorRuntimeHarness({ cwd, confirm: true });
			if (cwd) cursorSessionScopeTestUtils.recordProjectTrustResolution(cwd);
			await harness.pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, harness.ctx);
			harness.pi.appendEntry.mockImplementationOnce(() => {
				throw new Error("journal unavailable");
			});

			await harness.commands.get("cursor-runtime")!.handler(`cloud --save-${target}`, harness.commandCtx);

			const configPath = target === "user"
				? join(tmpAgentDir, "cursor-sdk.json")
				: join(cwd!, ".pi", "cursor-sdk.json");
			expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({ runtime: "cloud" });
			expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:cloud · fast:n/a");
			expect(harness.ctx.ui.notify).toHaveBeenCalledWith(
				expect.stringContaining(`${target === "user" ? "User" : "Project"} config was saved, but persisting the session runtime entry failed.`),
				"error",
			);
			expect(harness.ctx.ui.notify).toHaveBeenCalledWith(
				expect.stringContaining(`Effective runtime is cloud (source: ${target})`),
				"error",
			);
		},
	);

	it("saves acknowledged cloud runtime to user config", async () => {
		const harness = createCursorRuntimeHarness({ confirm: true });
		await harness.pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, harness.commandCtx);
		await harness.commands.get("cursor-runtime")!.handler("cloud --save-user", harness.commandCtx);
		expect(JSON.parse(readFileSync(join(tmpAgentDir, "cursor-sdk.json"), "utf8"))).toEqual({
			runtime: "cloud",
			cloud: { acknowledged: true },
		});
	});

	it("rejects project saves until Pi recognizes and trusts a project resource", async () => {
		const cwd = join(tmpAgentDir, "standalone-project");
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		const configPath = join(cwd, ".pi", "cursor-sdk.json");
		writeFileSync(configPath, JSON.stringify({ runtime: "local" }));
		const harness = createCursorRuntimeHarness({ cwd, confirm: true });
		await harness.pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, harness.commandCtx);

		await harness.commands.get("cursor-runtime")!.handler("cloud --save-project", harness.commandCtx);

		expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({ runtime: "local" });
		expect(() => readFileSync(join(cwd, ".pi", "settings.json"), "utf8")).toThrow();
		expect(harness.confirm).not.toHaveBeenCalled();
		expect(harness.pi.appendEntry).not.toHaveBeenCalled();
		expect(harness.ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("Project-local package installs must use --approve on every run"),
			"error",
		);
	});

	it("rejects project saves when a recognized project resource is not trusted", async () => {
		const cwd = join(tmpAgentDir, "untrusted-project");
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), "{}\n");
		const configPath = join(cwd, ".pi", "cursor-sdk.json");
		writeFileSync(configPath, JSON.stringify({ runtime: "local" }));
		const harness = createCursorRuntimeHarness({ cwd, projectTrusted: false });
		cursorSessionScopeTestUtils.recordProjectTrustResolution(cwd);
		await harness.pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, harness.commandCtx);

		await harness.commands.get("cursor-runtime")!.handler("cloud --save-project", harness.commandCtx);

		expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({ runtime: "local" });
		expect(harness.confirm).not.toHaveBeenCalled();
		expect(harness.pi.appendEntry).not.toHaveBeenCalled();
		expect(harness.ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("Ensure .pi/settings.json or another Pi project resource exists, trust the project"),
			"error",
		);
	});

	it("preserves the trusted project snapshot when its trust resource disappears before save", async () => {
		const cwd = join(tmpAgentDir, "resource-removed-project");
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		const settingsPath = join(cwd, ".pi", "settings.json");
		writeFileSync(settingsPath, "{}\n");
		const configPath = join(cwd, ".pi", "cursor-sdk.json");
		writeFileSync(
			configPath,
			JSON.stringify({ runtime: "cloud", fastDefaults: { "composer-2": false }, local: { resume: false } }),
		);
		const harness = createCursorRuntimeHarness({ cwd });
		cursorSessionScopeTestUtils.recordProjectTrustResolution(cwd);
		await harness.pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, harness.commandCtx);
		rmSync(settingsPath);

		await harness.commands.get("cursor-runtime")!.handler("local --save-project", harness.commandCtx);

		expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
			runtime: "local",
			fastDefaults: { "composer-2": false },
			local: { resume: false },
		});
	});

	it.each(["user", "project"] as const)("preserves forward-compatible fields on %s runtime save", async (target) => {
		const cwd = join(tmpAgentDir, `future-${target}`);
		const configPath = target === "user"
			? join(tmpAgentDir, "cursor-sdk.json")
			: join(cwd, ".pi", "cursor-sdk.json");
		mkdirSync(target === "user" ? tmpAgentDir : join(cwd, ".pi"), { recursive: true });
		if (target === "project") writeFileSync(join(cwd, ".pi", "settings.json"), "{}\n");
		writeFileSync(configPath, JSON.stringify({
			runtime: "local",
			future: { enabled: true },
			cloud: { acknowledged: false, futureCloud: "kept" },
			local: { resume: false, futureLocal: 7 },
		}));
		const harness = createCursorRuntimeHarness({ cwd, confirm: true });
		if (target === "project") cursorSessionScopeTestUtils.recordProjectTrustResolution(cwd);
		await harness.pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, harness.commandCtx);

		await harness.commands.get("cursor-runtime")!.handler(`cloud --save-${target}`, harness.commandCtx);

		expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
			runtime: "cloud",
			future: { enabled: true },
			cloud: {
				acknowledged: target === "user",
				futureCloud: "kept",
			},
			local: { resume: false, futureLocal: 7 },
		});
	});

	it.each(["user", "project"] as const)("rejects malformed %s config before write or session append", async (target) => {
		const cwd = join(tmpAgentDir, `malformed-${target}`);
		const configPath = target === "user"
			? join(tmpAgentDir, "cursor-sdk.json")
			: join(cwd, ".pi", "cursor-sdk.json");
		mkdirSync(target === "user" ? tmpAgentDir : join(cwd, ".pi"), { recursive: true });
		if (target === "project") writeFileSync(join(cwd, ".pi", "settings.json"), "{}\n");
		const sentinel = "PI_CURSOR_MALFORMED_SECRET";
		writeFileSync(configPath, `{"secret":"${sentinel}`);
		const harness = createCursorRuntimeHarness({ cwd });
		if (target === "project") cursorSessionScopeTestUtils.recordProjectTrustResolution(cwd);
		await harness.pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, harness.commandCtx);

		await harness.commands.get("cursor-runtime")!.handler(`local --save-${target}`, harness.commandCtx);

		expect(readFileSync(configPath, "utf8")).toBe(`{"secret":"${sentinel}`);
		expect(harness.pi.appendEntry).not.toHaveBeenCalled();
		expect(harness.ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining(`Failed to save Cursor runtime preference to ${target} config`),
			"error",
		);
		expect(vi.mocked(harness.ctx.ui.notify).mock.calls.flat().join("\n")).not.toContain(sentinel);
	});

	it("saves a project cloud default without project acknowledgement in a trusted project", async () => {
		const cwd = join(tmpAgentDir, "trusted-project");
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), "{}\n");
		writeFileSync(
			join(cwd, ".pi", "cursor-sdk.json"),
			JSON.stringify({ fastDefaults: { "composer-2": false }, local: { resume: false } }),
		);
		const harness = createCursorRuntimeHarness({ cwd, confirm: true });
		cursorSessionScopeTestUtils.recordProjectTrustResolution(cwd);
		await harness.pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, harness.commandCtx);
		await harness.commands.get("cursor-runtime")!.handler("cloud --save-project", harness.commandCtx);
		expect(JSON.parse(readFileSync(join(cwd, ".pi", "cursor-sdk.json"), "utf8"))).toEqual({
			fastDefaults: { "composer-2": false },
			local: { resume: false },
			runtime: "cloud",
		});
		expect(JSON.parse(readFileSync(join(cwd, ".pi", "settings.json"), "utf8"))).toEqual({});
	});
});

describe("Cursor cloud model selection", () => {
	beforeEach(resetCursorProviderTestState);

	it("ignores mutable fast preferences while preserving catalog defaults and explicit aliases", async () => {
		mockCreatedAgent({
			agentId: "bc-00000000-0000-0000-0000-000000000001",
			send: vi.fn().mockResolvedValue({
				id: "run-1",
				agentId: "bc-00000000-0000-0000-0000-000000000001",
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "cloud done" }),
				cancel: vi.fn(),
				supports: () => true,
				unsupportedReason: () => undefined,
			}),
		});
		const cases = [
			{ modelId: "gpt-5.5@1m", flag: "cursor-fast", expected: "false" },
			{ modelId: "gpt-5.5@1m:fast", flag: "cursor-no-fast", expected: "true" },
			{ modelId: "gpt-5.5@1m:slow", flag: "cursor-fast", expected: "false" },
		] as const;

		for (const { modelId, flag } of cases) {
			const pi = createPiHarness({ flagValues: {
				"cursor-runtime": "cloud",
				"cursor-cloud-allow-local-state": true,
				"cursor-cloud-ack": true,
				[flag]: true,
			} });
			registerCursorSessionScope(pi);
			registerCursorNativeToolDisplayState(pi);
			registerCursorRuntimeControls(pi);
			await pi.runSessionStart({ model: makeModel(modelId) });
			await collectEvents(streamCursor(makeModel(modelId), {
				systemPrompt: "Be helpful.",
				messages: [{ role: "user", content: "hello", timestamp: 1 }],
			}, { apiKey: "test-key" }, captureProviderTestOwnership(makeModel(modelId), { messages: [] }, getCursorSessionScopeSnapshot(pi), pi)));
			await pi.runSessionShutdown({ reason: "quit" });
		}

		expect(mockedCreate.mock.calls.map(([options]) =>
			options.model?.params?.find((param) => param.id === "fast")?.value,
		)).toEqual(cases.map(({ expected }) => expected));
	});
});
