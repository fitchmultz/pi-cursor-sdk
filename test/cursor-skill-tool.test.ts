import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import type { BeforeAgentStartEvent, ExtensionContext, Skill } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_ACTIVATE_SKILL_MCP_NAME,
	CURSOR_ACTIVATE_SKILL_TOOL_NAME,
	formatCursorSkillsForPrompt,
	registerCursorSkillTool,
	resolveCursorSkillSystemPrompt,
} from "../src/cursor-skill-tool.js";
import { buildCursorPiToolBridgeSnapshot } from "../src/cursor-pi-tool-bridge.js";
import { buildCursorPrompt } from "../src/context.js";
import {
	createDefaultSystemPromptOptions,
	createExtensionTestContext,
	createPiHarness,
	getHarnessRegisteredTool,
	makeModel,
} from "./helpers/pi-harness.js";

afterEach(() => {
	delete process.env.PI_CURSOR_RUNTIME;
});

function makeSkill(overrides: Partial<Skill> & Pick<Skill, "name" | "filePath">): Skill {
	return {
		description: `${overrides.name} description`,
		baseDir: overrides.filePath.slice(0, overrides.filePath.lastIndexOf("/")),
		sourceInfo: {
			source: "test",
			path: overrides.filePath,
			scope: "user",
			origin: "top-level",
		},
		disableModelInvocation: false,
		...overrides,
	};
}

describe("formatCursorSkillsForPrompt", () => {
	it("builds a Cursor-safe pi skill catalog and excludes explicit-only skills", () => {
		const prompt = formatCursorSkillsForPrompt([
			makeSkill({ name: "global-skill", description: "Use for global work", filePath: "/Users/me/.pi/agent/skills/global-skill/SKILL.md" }),
			makeSkill({ name: "manual-only", description: "Manual", filePath: "/skills/manual-only/SKILL.md", disableModelInvocation: true }),
		]);

		expect(prompt).toContain(CURSOR_ACTIVATE_SKILL_MCP_NAME);
		expect(prompt).toContain("<name>global-skill</name>");
		expect(prompt).toContain("/Users/me/.pi/agent/skills/global-skill/SKILL.md");
		expect(prompt).not.toContain("manual-only");
	});
});

describe("resolveCursorSkillSystemPrompt", () => {
	const cursorModel = makeModel("composer-2.5");
	const otherModel = { provider: "anthropic", id: "claude-sonnet-4-5" } as ReturnType<typeof makeModel>;
	const skill = makeSkill({ name: "global-skill", description: "Global pi skill", filePath: "/Users/me/.pi/agent/skills/global-skill/SKILL.md" });
	const piSkillSection = [
		"System prompt before skills.",
		"",
		"The following skills provide specialized instructions for specific tasks.",
		"Use the read tool to load a skill's file when the task matches its description.",
		"",
		"<available_skills>",
		"  <skill>",
		"    <name>global-skill</name>",
		"    <description>Global pi skill</description>",
		"    <location>/Users/me/.pi/agent/skills/global-skill/SKILL.md</location>",
		"  </skill>",
		"</available_skills>",
	].join("\n");

	it("does not change prompts for non-Cursor models", () => {
		expect(
			resolveCursorSkillSystemPrompt(piSkillSection, otherModel, { ...createDefaultSystemPromptOptions("/repo"), skills: [skill] }),
		).toBe(piSkillSection);
	});

	it("replaces pi's raw read-based skill wording and preserves the catalog through prompt sanitization", () => {
		const resolved = resolveCursorSkillSystemPrompt(
			piSkillSection,
			cursorModel,
			{ ...createDefaultSystemPromptOptions("/repo"), skills: [skill] },
		);
		expect(resolved).toContain(CURSOR_ACTIVATE_SKILL_MCP_NAME);
		expect(resolved).toContain("<name>global-skill</name>");
		expect(resolved).not.toContain("Use the read tool to load a skill's file");
		const prompt = buildCursorPrompt({ systemPrompt: resolved, messages: [] });

		expect(prompt.text).toContain(CURSOR_ACTIVATE_SKILL_MCP_NAME);
		expect(prompt.text).toContain("global-skill");
	});
});

describe("registerCursorSkillTool", () => {
	it("adds a bridgeable activation tool for Cursor runs with visible pi skills", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-cursor-skill-"));
		onTestFinished(() => rm(dir, { recursive: true, force: true }));
		const skillDir = join(dir, "global-skill");
		await mkdir(join(skillDir, "references"), { recursive: true });
		const skillPath = join(skillDir, "SKILL.md");
		await writeFile(skillPath, "---\nname: global-skill\ndescription: Global skill\n---\n# Global Skill\nFollow this skill.");
		await writeFile(join(skillDir, "references", "guide.md"), "Reference details");
		const skill = makeSkill({ name: "global-skill", description: "Global skill", filePath: skillPath });
		const pi = createPiHarness({ activeTools: ["read"] });
		registerCursorSkillTool(pi);

		const event = {
			type: "before_agent_start",
			messageType: "user",
			prompt: "hello",
			systemPrompt: "System prompt.",
			systemPromptOptions: { ...createDefaultSystemPromptOptions(dir), skills: [skill] },
		} satisfies BeforeAgentStartEvent & { messageType: "user" };
		const result = await pi.invokeEvent("before_agent_start", event, { model: makeModel("composer-2.5"), cwd: dir });

		expect(result?.systemPrompt).toContain(CURSOR_ACTIVATE_SKILL_MCP_NAME);
		expect(pi._activeToolNames()).toContain(CURSOR_ACTIVATE_SKILL_TOOL_NAME);
		expect(buildCursorPiToolBridgeSnapshot(pi).piToolNameToMcpToolName.get(CURSOR_ACTIVATE_SKILL_TOOL_NAME)).toBe(CURSOR_ACTIVATE_SKILL_MCP_NAME);

		const tool = getHarnessRegisteredTool(pi._tools, CURSOR_ACTIVATE_SKILL_TOOL_NAME);
		const toolResult = await tool.execute("call-1", { name: "global-skill" }, undefined, undefined, createExtensionTestContext({ model: makeModel("composer-2.5"), cwd: dir }));
		const text = toolResult.content?.[0]?.type === "text" ? toolResult.content[0].text : "";

		expect(toolResult).not.toMatchObject({ isError: true });
		expect(text).toContain("<skill_content name=\"global-skill\">");
		expect(text).toContain("# Global Skill");
		expect(text).toContain("references/guide.md");
	});

	it("keeps the activation tool inactive and omits the catalog in cloud runtime", async () => {
		process.env.PI_CURSOR_RUNTIME = "cloud";
		const skill = makeSkill({ name: "global-skill", description: "Global skill", filePath: "/repo/global-skill/SKILL.md" });
		const pi = createPiHarness({ activeTools: ["read"] });
		registerCursorSkillTool(pi);

		const event = {
			type: "before_agent_start",
			messageType: "user",
			prompt: "hello",
			systemPrompt: [
				"System prompt.",
				"",
				"The following skills provide specialized instructions for specific tasks.",
				"<available_skills><skill><name>global-skill</name><location>/repo/global-skill/SKILL.md</location></skill></available_skills>",
			].join("\n"),
			systemPromptOptions: { ...createDefaultSystemPromptOptions("/repo"), skills: [skill] },
		} satisfies BeforeAgentStartEvent & { messageType: "user" };
		const result = await pi.invokeEvent("before_agent_start", event, { model: makeModel("composer-2.5"), cwd: "/repo" });

		expect(result?.systemPrompt).toContain("System prompt.");
		expect(result?.systemPrompt).not.toContain("<available_skills>");
		expect(result?.systemPrompt).not.toContain("/repo/global-skill/SKILL.md");
		expect(result?.systemPrompt).not.toContain(CURSOR_ACTIVATE_SKILL_MCP_NAME);
		expect(pi._activeToolNames()).not.toContain(CURSOR_ACTIVATE_SKILL_TOOL_NAME);
	});

	it("ignores invalid Cursor runtime overrides for non-Cursor models", async () => {
		process.env.PI_CURSOR_RUNTIME = "remote";
		const pi = createPiHarness({ activeTools: ["read"] });
		registerCursorSkillTool(pi);
		const model = { provider: "anthropic", id: "claude-sonnet-4-5" } as ExtensionContext["model"];

		const event = {
			type: "before_agent_start",
			messageType: "user",
			prompt: "hello",
			systemPrompt: "System prompt.",
			systemPromptOptions: createDefaultSystemPromptOptions("/repo"),
		} satisfies BeforeAgentStartEvent & { messageType: "user" };
		const result = await pi.invokeEvent("before_agent_start", event, { model, cwd: "/repo" });

		expect(result).toBeUndefined();
		expect(pi._activeToolNames()).not.toContain(CURSOR_ACTIVATE_SKILL_TOOL_NAME);
	});

	it("does not expose the activation tool when no visible skills are available", async () => {
		const pi = createPiHarness({ activeTools: ["read"] });
		registerCursorSkillTool(pi);
		const event = {
			type: "before_agent_start",
			messageType: "user",
			prompt: "hello",
			systemPrompt: "System prompt.",
			systemPromptOptions: createDefaultSystemPromptOptions("/repo"),
		} satisfies BeforeAgentStartEvent & { messageType: "user" };
		await pi.invokeEvent("before_agent_start", event, { model: makeModel("composer-2.5"), cwd: "/repo" });

		expect(pi._activeToolNames()).not.toContain(CURSOR_ACTIVATE_SKILL_TOOL_NAME);
	});
});
