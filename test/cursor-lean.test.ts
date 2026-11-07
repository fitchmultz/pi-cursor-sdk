import { afterEach, describe, expect, it, vi } from "vitest";
import { getEffectiveCursorSettingSources } from "../src/cursor-setting-sources.js";
import { resolveCursorPiToolBridgeBuiltinsEnabled, resolveCursorPiToolBridgeEnabled } from "../src/cursor-pi-tool-bridge-env.js";
import { acquireSessionCursorAgent, buildCursorLocalAgentOptions, __testUtils as sessionAgentTestUtils } from "../src/cursor-session-agent.js";
import { __testUtils as scopeTestUtils } from "../src/cursor-session-scope.js";
import { installCursorSessionStoreMock } from "./helpers/cursor-session-store.js";
import { resolveCursorSkillSystemPrompt } from "../src/cursor-skill-tool.js";
import { makeModel, makeContext, createPiHarness, createExtensionTestContext, createBuiltinToolInfo } from "./helpers/pi-harness.js";
import { Type } from "typebox";
import { buildCursorPrompt, getCursorToolTailGuardText } from "../src/context.js";
import { registerCursorRuntimeControls } from "../src/cursor-state.js";
import { registerCursorSessionScope } from "../src/cursor-session-scope.js";
import { buildCursorToolManifestText } from "../src/cursor-tool-manifest.js";

afterEach(() => vi.unstubAllEnvs());

describe("lean tool policy", () => {
	it.each([undefined, "1"])("overrides ambient settings and bridge opt-outs (lean=%s)", (lean) => {
		vi.stubEnv("PI_CURSOR_LEAN", lean);
		vi.stubEnv("PI_CURSOR_SETTING_SOURCES", "all");
		vi.stubEnv("PI_CURSOR_PI_TOOL_BRIDGE", "0");
		vi.stubEnv("PI_CURSOR_EXPOSE_BUILTIN_TOOLS", "0");
		expect(getEffectiveCursorSettingSources()).toEqual([]);
		expect(resolveCursorPiToolBridgeEnabled()).toBe(true);
		expect(resolveCursorPiToolBridgeBuiltinsEnabled()).toBe(true);
		expect(buildCursorLocalAgentOptions({ cwd: "/tmp", settingSources: ["all"] }).settingSources).toEqual([]);
		expect(buildCursorToolManifestText()).toContain("Cursor native tools and ambient MCP: disabled");
		expect(buildCursorToolManifestText()).not.toContain("do not disable Cursor");
		expect(resolveCursorSkillSystemPrompt("Pi skill instructions", makeModel(), {
			cwd: "/tmp",
			skills: [{ name: "example", description: "Example", filePath: "/tmp/SKILL.md", baseDir: "/tmp", sourceInfo: { source: "test", path: "/tmp/SKILL.md", scope: "user", origin: "top-level" }, disableModelInvocation: false }],
		})).toBe("Pi skill instructions");
	});

	it("keeps bootstrap, incremental guidance, and tool diagnostics consistent with lean mode", async () => {
		vi.stubEnv("PI_CURSOR_LEAN", "1");
		const prompt = buildCursorPrompt(makeContext(), { agentMode: "plan" }).text;
		expect(prompt).toContain("Only exposed pi__* tools are callable");
		expect(prompt).not.toContain("Cursor-native subagents only when");
		expect(prompt).not.toContain("pi__cursor_ask_question");
		expect(getCursorToolTailGuardText()).toContain("Only exposed pi__* tools are callable");
		const pi = createPiHarness({ activeTools: ["read"], initialTools: [createBuiltinToolInfo("read", Type.Object({}))] });
		registerCursorSessionScope(pi);
		registerCursorRuntimeControls(pi);
		const ctx = createExtensionTestContext();
		await pi.runCommand("cursor-tools", "", { ui: ctx.ui, hasUI: true });
		const report = vi.mocked(ctx.ui.notify).mock.calls[0][0];
		expect(report).toContain("PI_CURSOR_SETTING_SOURCES: none (PI_CURSOR_LEAN=1)");
		expect(report).toContain("pi__read");
		expect(report).toContain("Cursor native tools and ambient MCP: disabled");
		expect(report).not.toContain("do not disable Cursor");
	});

	it("separates lean and normal pooled agents and persisted resume identities", async () => {
		installCursorSessionStoreMock();
		scopeTestUtils.reset();
		scopeTestUtils.set("/tmp", "/tmp/sessions/lean.jsonl");
		const createAgent = vi.fn().mockImplementation(async () => ({
			agentId: `agent-${createAgent.mock.calls.length}`,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		}));
		const params = { apiKey: "test-key", agentMode: "agent" as const, cwd: "/tmp", modelSelection: { id: "test" }, createAgent, bridge: undefined };
		try {
			vi.stubEnv("PI_CURSOR_LEAN", "0");
			const normal = await acquireSessionCursorAgent(params);
			vi.stubEnv("PI_CURSOR_LEAN", "1");
			const lean = await acquireSessionCursorAgent(params);
			expect(lean.poolKey).not.toBe(normal.poolKey);
			expect(lean.agent).not.toBe(normal.agent);
			expect(createAgent).toHaveBeenCalledTimes(2);
		} finally {
			await sessionAgentTestUtils.disposeAllSessionCursorAgents();
			scopeTestUtils.reset();
		}
	});

	it("preserves the normal defaults when disabled", () => {
		vi.stubEnv("PI_CURSOR_LEAN", "0");
		expect(resolveCursorPiToolBridgeBuiltinsEnabled({ PI_CURSOR_LEAN: "0" })).toBe(false);
		expect(resolveCursorPiToolBridgeEnabled({})).toBe(true);
		expect(getEffectiveCursorSettingSources("all")).toEqual(["all"]);
		expect(buildCursorLocalAgentOptions({ cwd: "/tmp", settingSources: ["all"] }).settingSources).toEqual(["all"]);
	});
});
