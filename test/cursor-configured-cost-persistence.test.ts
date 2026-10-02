import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { asMockCursorRun, mockCreatedAgent, resetCursorProviderTestState, type CursorDeltaHandler } from "./helpers/cursor-provider-harness.js";
import cursorExtension from "../src/index.js";

describe("configured Cursor cost through Pi composition and persistence", () => {
	beforeEach(resetCursorProviderTestState);
	afterEach(() => vi.unstubAllEnvs());

	it.each([
		{ name: "default zero rates", cost: undefined, expectedCost: 0 },
		{ name: "configured rates", cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }, expectedCost: 0.0071 },
		{
			name: "native request-wide tier",
			cost: {
				input: 1, output: 1, cacheRead: 1, cacheWrite: 1,
				tiers: [{ inputTokensAbove: 9999, input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }],
			},
			expectedCost: 0.0071,
		},
	])("persists $name from the registered extension provider", async ({ cost, expectedCost }) => {
		const cwd = mkdtempSync(join(tmpdir(), "cursor-cost-"));
		const agentDir = join(cwd, "agent");
		mkdirSync(agentDir);
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("PI_OFFLINE", "1");
		vi.stubEnv("CURSOR_API_KEY", "");
		vi.stubEnv("PI_CURSOR_SETTING_SOURCES", "none");
		vi.stubEnv("PI_CURSOR_PI_TOOL_BRIDGE", "0");
		writeFileSync(join(agentDir, "models.json"), JSON.stringify({
			providers: cost ? { cursor: { modelOverrides: { "grok-4.6": { cost } } } } : {},
		}));
		const send = vi.fn(async (_message: unknown, options: { onDelta: CursorDeltaHandler }) => {
			options.onDelta({ update: { type: "text-delta", text: "OK" } });
			options.onDelta({ update: { type: "turn-ended", usage: {
				inputTokens: 10000, outputTokens: 100, cacheReadTokens: 8000, cacheWriteTokens: 1000,
			} } });
			return asMockCursorRun({ id: "run-cost", agentId: "agent-cost", status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-cost", status: "finished", result: "OK" }),
			});
		});
		mockCreatedAgent({ agentId: "agent-cost", send });
		let session: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;
		try {
			const services = await createAgentSessionServices({
				cwd, agentDir,
				settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
				resourceLoaderOptions: {
					noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
					systemPromptOverride: () => "", extensionFactories: [cursorExtension],
				},
			});
			await services.modelRuntime.setRuntimeApiKey("cursor", "offline-cost-fixture");
			const model = services.modelRuntime.getModel("cursor", "grok-4.6");
			expect(model).toBeDefined();
			if (!model) throw new Error("Cursor extension did not register the model");
			expect(model.cost).toMatchObject(cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
			const manager = SessionManager.create(cwd, join(cwd, "sessions"));
			({ session } = await createAgentSessionFromServices({ services, sessionManager: manager, model, noTools: "all" }));
			await session.bindExtensions({ mode: "json" });
			await session.prompt("Cost fixture");
			expect(send, JSON.stringify(session.messages)).toHaveBeenCalledOnce();
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Pi did not create a session journal");
			const assistants = SessionManager.open(sessionFile).getEntries()
				.flatMap((entry) => entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : []);
			expect(assistants).toHaveLength(1);
			expect(assistants[0]).toMatchObject({ provider: "cursor", model: "grok-4.6", stopReason: "stop", usage: {
				input: 1000, output: 100, cacheRead: 8000, cacheWrite: 1000, totalTokens: 10100,
			} });
			expect(assistants[0]?.usage.cost.total).toBeCloseTo(expectedCost, 10);
			expect(session.getSessionStats().cost).toBeCloseTo(expectedCost, 10);
			expect(session.getSessionStats().tokens).toMatchObject({ input: 1000, output: 100, cacheRead: 8000, cacheWrite: 1000 });
		} finally {
			await session?.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
			session?.dispose();
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
