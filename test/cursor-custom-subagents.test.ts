import { readFileSync } from "node:fs";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { buildCursorCloudAgentOptions } from "../src/cursor-cloud-options.js";
import { parseCursorSdkConfig, resolveCursorSdkConfig } from "../src/cursor-config.js";
import { parseCursorCustomSubagents } from "../src/cursor-custom-subagents.js";
import { buildCursorCustomSubagentDefinitions } from "../src/cursor-custom-subagent-definitions.js";
import { buildCursorModelSelection, __testUtils as modelDiscoveryTestUtils } from "../src/model-discovery.js";
import {
	acquireSessionCursorAgent,
	__testUtils as sessionAgentTestUtils,
} from "../src/cursor-session-agent.js";
import { __testUtils as cursorSessionScopeTestUtils } from "../src/cursor-session-scope.js";
import { installCursorSessionStoreMock } from "./helpers/cursor-session-store.js";
import { cursorModelItems } from "./helpers/cursor-provider-harness.js";

const REVIEWER = {
	description: "Reviews diffs.",
	prompt: "You review diffs.",
	model: "gpt-5.5@272k",
	thinking: "high",
} as const;

const SDK_DIST = new URL("../node_modules/@cursor/sdk/dist/esm/", import.meta.url);

describe("Cursor custom subagents", () => {
	beforeEach(() => {
		modelDiscoveryTestUtils.registerModelItems(cursorModelItems);
	});

	it("tracks the installed SDK custom subagent option contract", () => {
		const options = readFileSync(new URL("options.d.ts", SDK_DIST), "utf8");

		expect(options).toMatch(/export interface AgentDefinition \{/);
		expect(options).toMatch(/model\?: ModelSelection \| "inherit";/);
		expect(options).toMatch(/agents\?: Record<string, AgentDefinition>;/);
	});

	it("tracks the installed SDK local-runtime subagent model downgrade", () => {
		// Local runs narrow subagents to RuntimeCustomSubagentDefinition, whose model is a plain id, so pi
		// documents thinking/fast/context as cloud-only. This fails if a future SDK keeps local params.
		const runtimeTypes = readFileSync(new URL("run-store-public-types.d.ts", SDK_DIST), "utf8");
		const conversion = readFileSync(new URL("subagent-conversion.d.ts", SDK_DIST), "utf8");

		expect(runtimeTypes, "installed SDK local subagent model is no longer a plain id").toMatch(
			/export interface RuntimeCustomSubagentDefinition \{[\s\S]*?readonly model: string;/,
		);
		expect(conversion, "installed SDK local converter no longer narrows to RuntimeCustomSubagentDefinition").toMatch(
			/convertAgentDefinitionsToRuntimeCustomSubagents\(agents: Record<string, AgentDefinition> \| undefined\): RuntimeCustomSubagentDefinition\[\]/,
		);
		expect(conversion, "installed SDK cloud/local subagent model shapes converged").toMatch(
			/interface SDKCustomSubagentDefinition \{[\s\S]*?model: ModelSelection \| "inherit";/,
		);
	});

	it("parses usable subagent entries and drops unusable ones", () => {
		expect(
			parseCursorCustomSubagents({
				reviewer: REVIEWER,
				"bad name": REVIEWER,
				"1leading-digit": REVIEWER,
				missingPrompt: { description: "No prompt." },
				missingDescription: { prompt: "No description." },
				blank: { description: "   ", prompt: "   " },
				notAnObject: "reviewer",
			}),
		).toEqual({ reviewer: { description: "Reviews diffs.", prompt: "You review diffs.", model: "gpt-5.5@272k", thinking: "high" } });
	});

	it("treats an empty or fully invalid block as absent so it cannot shadow a lower layer", () => {
		expect(parseCursorCustomSubagents({})).toBeUndefined();
		expect(parseCursorCustomSubagents({ "bad name": REVIEWER })).toBeUndefined();
		expect(
			resolveCursorSdkConfig({
				env: {},
				user: { subagents: { reviewer: { description: "User.", prompt: "User." } } },
				project: parseCursorSdkConfig({ subagents: {} }),
			}).subagents,
		).toMatchObject({ source: "user" });
	});

	it("keeps fast and ignores an unsupported thinking level", () => {
		expect(
			parseCursorCustomSubagents({
				explorer: { description: "Explores.", prompt: "You explore.", model: "gpt-5.5@1m", thinking: "turbo", fast: true },
			}),
		).toEqual({ explorer: { description: "Explores.", prompt: "You explore.", model: "gpt-5.5@1m", fast: true } });
	});

	it("builds SDK agent definitions from real Cursor model metadata", () => {
		const definitions = buildCursorCustomSubagentDefinitions({
			reviewer: REVIEWER,
			inheriting: { description: "Inherits.", prompt: "You inherit.", model: "inherit" },
			defaulted: { description: "Defaults.", prompt: "You default." },
			slowed: { description: "Slow.", prompt: "You are slow.", model: "gpt-5.5@1m", fast: false },
		});

		expect(definitions).toEqual({
			reviewer: {
				description: "Reviews diffs.",
				prompt: "You review diffs.",
				model: buildCursorModelSelection("gpt-5.5@272k", "high"),
			},
			inheriting: { description: "Inherits.", prompt: "You inherit.", model: "inherit" },
			defaulted: { description: "Defaults.", prompt: "You default." },
			slowed: {
				description: "Slow.",
				prompt: "You are slow.",
				model: buildCursorModelSelection("gpt-5.5@1m", "off", false),
			},
		});
		// The reviewer selection must carry the requested context variant and thinking parameter.
		expect(definitions?.reviewer?.model).toMatchObject({
			id: "gpt-5.5",
			params: expect.arrayContaining([
				{ id: "context", value: "272k" },
				{ id: "reasoning", value: "high" },
			]),
		});
		expect(definitions?.slowed?.model).toMatchObject({ params: expect.arrayContaining([{ id: "fast", value: "false" }]) });
	});

	it("resolves pi model id aliases and passes unknown ids through unchanged", () => {
		modelDiscoveryTestUtils.registerModelItems([
			{
				id: "composer-2.5",
				displayName: "Composer 2.5",
				aliases: ["composer-2-5"],
				parameters: [{ id: "fast", displayName: "Fast", values: [{ value: "false" }, { value: "true" }] }],
				variants: [{ params: [{ id: "fast", value: "true" }], displayName: "Composer 2.5", isDefault: true }],
			},
		]);
		const definitions = buildCursorCustomSubagentDefinitions({
			aliased: { description: "Aliased.", prompt: "Aliased.", model: "composer-2-5" },
			typo: { description: "Typo.", prompt: "Typo.", model: "composer-2-5-typo" },
		});

		expect(definitions?.aliased?.model).toMatchObject({ id: "composer-2-5" });
		expect(definitions?.typo?.model).toEqual({ id: "composer-2-5-typo" });
	});

	it("returns no definitions when nothing is configured", () => {
		expect(buildCursorCustomSubagentDefinitions(undefined)).toBeUndefined();
		expect(buildCursorCustomSubagentDefinitions({})).toBeUndefined();
	});

	it("keys the agent pool on bounded definition content, not declaration order", () => {
		const poolKey = sessionAgentTestUtils.buildCustomSubagentsPoolKey;
		const first = buildCursorCustomSubagentDefinitions({ a: REVIEWER, b: { description: "B.", prompt: "B." } });
		const reordered = buildCursorCustomSubagentDefinitions({ b: { description: "B.", prompt: "B." }, a: REVIEWER });
		const changed = buildCursorCustomSubagentDefinitions({ a: { ...REVIEWER, prompt: "You review carefully." }, b: { description: "B.", prompt: "B." } });

		expect(poolKey(first)).toBe(poolKey(reordered));
		expect(poolKey(changed)).not.toBe(poolKey(first));
		expect(poolKey(first)).toMatch(/^subagents:[0-9a-f]{16}$/);
		expect(poolKey(undefined)).toBe("subagents:none");
	});

	it("parses subagents from Cursor SDK config files", () => {
		expect(parseCursorSdkConfig({ subagents: { reviewer: REVIEWER, "bad name": REVIEWER } })).toEqual({
			subagents: { reviewer: { description: "Reviews diffs.", prompt: "You review diffs.", model: "gpt-5.5@272k", thinking: "high" } },
		});
	});

	it("resolves subagents from trusted project, then user, then builtin", () => {
		const user = { subagents: { reviewer: { description: "User.", prompt: "User." } } };
		const project = { subagents: { reviewer: { description: "Project.", prompt: "Project." } } };

		expect(resolveCursorSdkConfig({ env: {} }).subagents).toMatchObject({ value: {}, source: "builtin" });
		expect(resolveCursorSdkConfig({ env: {}, user }).subagents).toMatchObject({ value: user.subagents, source: "user" });
		expect(resolveCursorSdkConfig({ env: {}, user, project }).subagents).toMatchObject({
			value: project.subagents,
			source: "project",
			trustLevel: "trusted-project",
		});
	});

	it("passes custom subagents to cloud Agent options only when configured", () => {
		const resolvedConfig = resolveCursorSdkConfig({ env: {}, cli: { runtime: "cloud", cloud: { acknowledged: true } } });
		const customSubagents = buildCursorCustomSubagentDefinitions({ reviewer: REVIEWER });

		expect(
			buildCursorCloudAgentOptions({ apiKey: "test-key", modelSelection: { id: "gpt-5.5" }, agentMode: "agent", resolvedConfig, customSubagents }).agents,
		).toEqual(customSubagents);
		expect(
			buildCursorCloudAgentOptions({ apiKey: "test-key", modelSelection: { id: "gpt-5.5" }, agentMode: "agent", resolvedConfig }),
		).not.toHaveProperty("agents");
	});
});

describe("Cursor custom subagents in local session agents", () => {
	beforeEach(async () => {
		installCursorSessionStoreMock();
		cursorSessionScopeTestUtils.reset();
		await sessionAgentTestUtils.disposeAllSessionCursorAgents();
		vi.clearAllMocks();
	});

	it("passes custom subagents to Agent.create and repools when they change", async () => {
		const createAgent = vi.fn().mockImplementation(async () => ({
			agentId: `agent-${createAgent.mock.calls.length}`,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		}));
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/subagents.jsonl");
		const params = {
			apiKey: "test-key",
			agentMode: "agent" as const,
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			createAgent,
		};
		const reviewer = { reviewer: { description: "Reviews diffs.", prompt: "You review diffs.", model: { id: "grok-4.5" } } };

		const first = await acquireSessionCursorAgent({ ...params, customSubagents: reviewer });
		const reused = await acquireSessionCursorAgent({ ...params, customSubagents: reviewer });
		const changed = await acquireSessionCursorAgent({
			...params,
			customSubagents: { reviewer: { ...reviewer.reviewer, model: { id: "composer-2.5" } } },
		});

		expect(createAgent.mock.calls[0][0].agents).toEqual(reviewer);
		expect(reused.agent).toBe(first.agent);
		expect(changed.agent).not.toBe(first.agent);
		expect(createAgent).toHaveBeenCalledTimes(2);
	});

	it("omits agents from Agent.create when no subagents are configured", async () => {
		const createAgent = vi.fn().mockResolvedValue({
			agentId: "agent-plain",
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/no-subagents.jsonl");

		await acquireSessionCursorAgent({
			apiKey: "test-key",
			agentMode: "agent",
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			createAgent,
		});

		expect(createAgent.mock.calls[0][0]).not.toHaveProperty("agents");
	});
});
