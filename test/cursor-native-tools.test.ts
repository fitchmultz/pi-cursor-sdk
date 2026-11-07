import { describe, expect, it, vi } from "vitest";
import type { SDKAgent } from "@cursor/sdk";
import { Type } from "typebox";
import { assertCursorNativeToolsRuntime, resolveCursorNativeToolsEnabled } from "../src/cursor-native-tools.js";
import { acquireSessionCursorAgent, __testUtils as sessionAgentTestUtils } from "../src/cursor-session-agent.js";
import { __testUtils as sessionScopeTestUtils } from "../src/cursor-session-scope.js";
import { __testUtils as bridgeTestUtils } from "../src/cursor-pi-tool-bridge.js";
import { createBridgePiHarness, createBuiltinToolInfo } from "./helpers/pi-harness.js";
import { installCursorSessionStoreMock } from "./helpers/cursor-session-store.js";

describe("native tool surface environment", () => {
	it.each([undefined, "", "  ", "unknown", "1", "TRUE", "on", "yes", "enabled"])("preserves the legacy default for %s", value => {
		expect(resolveCursorNativeToolsEnabled({ PI_CURSOR_LEAN: "0", PI_CURSOR_NATIVE_TOOLS: value })).toBe(true);
	});
	it.each(["0", "false", " OFF ", "none", "no", "disabled"])("selects legacy MCP-only for %s", value => {
		expect(resolveCursorNativeToolsEnabled({ PI_CURSOR_LEAN: "0", PI_CURSOR_NATIVE_TOOLS: value })).toBe(false);
	});
	it.each([undefined, "1", "true", "unknown"])("disables native tools in lean mode regardless of the native flag (lean=%s)", lean => {
		for (const native of [undefined, "1", "0"]) {
			expect(resolveCursorNativeToolsEnabled({ PI_CURSOR_LEAN: lean, PI_CURSOR_NATIVE_TOOLS: native })).toBe(false);
		}
	});
	it("uses the supplied lean snapshot rather than re-resolving it", () => {
		expect(resolveCursorNativeToolsEnabled({ PI_CURSOR_LEAN: "1" }, false)).toBe(true);
		expect(resolveCursorNativeToolsEnabled({ PI_CURSOR_LEAN: "0", PI_CURSOR_NATIVE_TOOLS: "1" }, true)).toBe(false);
	});
	it.each([false, true])("uses effective bridge/builtin flags in pooled identities (lean=%s)", async leanEnabled => {
		installCursorSessionStoreMock();
		sessionScopeTestUtils.reset();
		sessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/native-tools-flags.jsonl");
		const schema = Type.Object({});
		const pi = createBridgePiHarness({ active: ["read"], tools: [createBuiltinToolInfo("read", schema)] });
		const env = { PI_CURSOR_LEAN: leanEnabled ? "1" : "0" };
		const disabled = bridgeTestUtils.createRegistry(pi, { ...env, PI_CURSOR_PI_TOOL_BRIDGE: "0", PI_CURSOR_EXPOSE_BUILTIN_TOOLS: "0" });
		const enabled = bridgeTestUtils.createRegistry(pi, { ...env, PI_CURSOR_PI_TOOL_BRIDGE: "1", PI_CURSOR_EXPOSE_BUILTIN_TOOLS: "1" });
		const createAgent = vi.fn(async () => ({ agentId: `agent-flags-${createAgent.mock.calls.length}`, [Symbol.asyncDispose]: async () => {} }) as SDKAgent);
		const params = { apiKey: "test-key", agentMode: "agent" as const, cwd: "/tmp/project", modelSelection: { id: "fixture" },
			leanEnabled, nativeToolsEnabled: !leanEnabled, bridgeDeclaredTools: [{ name: "read", description: "read", parameters: schema }], createAgent };
		try {
			const first = await acquireSessionCursorAgent({ ...params, bridge: disabled });
			const second = await acquireSessionCursorAgent({ ...params, bridge: enabled });
			if (leanEnabled) {
				expect(second.poolKey).toBe(first.poolKey);
				expect(second.agent).toBe(first.agent);
				expect(createAgent).toHaveBeenCalledTimes(1);
			} else {
				expect(second.poolKey).not.toBe(first.poolKey);
				expect(second.agent).not.toBe(first.agent);
				expect(createAgent).toHaveBeenCalledTimes(2);
			}
		} finally {
			await sessionAgentTestUtils.disposeAllSessionCursorAgents();
			await Promise.all([disabled.disposeAll(), enabled.disposeAll()]);
			sessionScopeTestUtils.reset();
		}
	});
	it("allows both tool policies locally, but rejects restricted Cloud with the relevant flag", () => {
		expect(() => assertCursorNativeToolsRuntime("local", false, true)).not.toThrow();
		expect(() => assertCursorNativeToolsRuntime("local", false, false)).not.toThrow();
		expect(() => assertCursorNativeToolsRuntime("cloud", true, false)).not.toThrow();
		expect(() => assertCursorNativeToolsRuntime("cloud", false, false)).toThrow("PI_CURSOR_NATIVE_TOOLS=0 requires local runtime");
		expect(() => assertCursorNativeToolsRuntime("cloud", false, true)).toThrow("PI_CURSOR_LEAN requires local runtime");
	});
});
