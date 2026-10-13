import "./helpers/cursor-provider-harness.js";
import type { SDKAgent } from "@cursor/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareCursorSessionForCompaction } from "../src/cursor-session-compaction-prep.js";
import { cursorLiveRuns } from "../src/cursor-provider-live-run-drain.js";
import { __testUtils as cursorProviderTestUtils } from "../src/cursor-provider.js";
import { acquireSessionCursorAgent, __testUtils as sessionAgentTestUtils } from "../src/cursor-session-agent.js";
import { __testUtils as cursorSessionScopeTestUtils } from "../src/cursor-session-scope.js";
import { resetCursorProviderTestState } from "./helpers/cursor-provider-harness.js";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Type } from "typebox";
import { registerCursorPiToolBridge } from "../src/cursor-pi-tool-bridge.js";
import { createBridgePiHarness, createTestToolInfo, getCursorPiBridgeMcpUrl } from "./helpers/pi-harness.js";

describe("prepareCursorSessionForCompaction", () => {
	beforeEach(resetCursorProviderTestState);

	it("releases scoped live runs before disposing the pooled agent", async () => {
		const cleanupOrder: string[] = [];
		const mockDispose = vi.fn(async () => { cleanupOrder.push("dispose"); });
		const agent = {
			agentId: "agent-1",
			send: vi.fn(),
			[Symbol.asyncDispose]: mockDispose,
		} as unknown as SDKAgent;
		const createAgent = vi.fn().mockResolvedValue(agent);

		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/test.jsonl");
		const scopeKey = "/tmp/sessions/test.jsonl";
		const requests: import("../src/cursor-pi-tool-bridge.js").CursorPiBridgeToolRequest[] = [];
		const bridge = registerCursorPiToolBridge(createBridgePiHarness({
			active: ["slow_tool"], tools: [createTestToolInfo("slow_tool", Type.Object({}), "Slow tool")],
		}));
		const acquireParams = {
			apiKey: "test-key",
			agentMode: "agent" as const,
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			createAgent,
			bridge,
			onBridgeToolRequest: (request: import("../src/cursor-pi-tool-bridge.js").CursorPiBridgeToolRequest) => requests.push(request),
		};
		const lease = await acquireSessionCursorAgent(acquireParams);
		const bridgeRun = lease.bridgeRun!;
		const liveRun = cursorLiveRuns.start({
			id: "cursor-replay-test",
			agent,
			bridgeRun,
			sessionBridgeRun: bridgeRun,
			sessionAgentScopeKey: scopeKey,
			promptInputTokens: 0,
		});
		const sdkCancel = vi.fn(async () => { cleanupOrder.push("cancel"); });
		cursorLiveRuns.attachSdkRun(liveRun, { cancel: sdkCancel });
		const client = new Client({ name: "compaction-pending-bridge", version: "1" });
		const transport = new StreamableHTTPClientTransport(new URL(getCursorPiBridgeMcpUrl(bridgeRun)));
		try {
			await client.connect(transport);
			const call = client.callTool({ name: "pi__slow_tool", arguments: {} }).catch(error => error);
			await vi.waitFor(() => expect(requests).toHaveLength(1), { interval: 1 });
			cursorLiveRuns.requestIdleDispose(liveRun);
			expect(bridgeRun.hasPendingToolCalls()).toBe(true);
			await prepareCursorSessionForCompaction(scopeKey);
			await prepareCursorSessionForCompaction(scopeKey);
			expect(await call).toBeInstanceOf(Error);
			expect(bridgeRun.hasPendingToolCalls()).toBe(false);
			expect(liveRun.disposed).toBe(true);
			expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(0);
			expect(sessionAgentTestUtils.sessionAgentsByScope.has(scopeKey)).toBe(false);
			expect(sdkCancel).toHaveBeenCalledOnce();
			expect(mockDispose).toHaveBeenCalledTimes(1);
			expect(cleanupOrder).toEqual(["cancel", "dispose"]);

			await acquireSessionCursorAgent(acquireParams);
			expect(sessionAgentTestUtils.sessionAgentsByScope.has(scopeKey)).toBe(true);
			await prepareCursorSessionForCompaction(scopeKey);
			expect(sessionAgentTestUtils.sessionAgentsByScope.has(scopeKey)).toBe(false);
			expect(mockDispose).toHaveBeenCalledTimes(2);
		} finally {
			await client.close();
			await transport.close();
			await prepareCursorSessionForCompaction(scopeKey);
		}
	});

});
