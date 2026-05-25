import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BeforeAgentStartEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Context } from "@earendil-works/pi-ai";
import {
	classifyContextFileOverlap,
	CURSOR_PRESERVE_PI_AGENTS_MD_ENV,
	getAgentsContextFileBaseName,
	isPiAgentDirAgentsMdPath,
	PI_PROJECT_INSTRUCTIONS_OPEN_PREFIX,
	registerCursorAgentsContextDedup,
	removePiAgentsContextFromSystemPrompt,
	removePiProjectInstructionsBlockByPath,
	resolveCursorFacingSystemPrompt,
	shouldRemovePiAgentsContextFile,
	shouldSuppressPiAgentsContext,
} from "../src/cursor-agents-context.js";
import { buildCursorPrompt } from "../src/context.js";
import { CURSOR_SETTING_SOURCES_ENV } from "../src/cursor-setting-sources.js";
import { buildPiSystemPromptWithContextFiles } from "./helpers/pi-system-prompt.js";

const GLOBAL_AGENTS_PATH = "/Users/me/.pi/agent/AGENTS.md";
const GLOBAL_CLAUDE_PATH = "/Users/me/.pi/agent/CLAUDE.md";
const PROJECT_AGENTS_PATH = "/repo/AGENTS.md";
const PROJECT_CLAUDE_PATH = "/repo/CLAUDE.md";

const GLOBAL_FILE = { path: GLOBAL_AGENTS_PATH, content: "Global guidance" };
const GLOBAL_CLAUDE_FILE = { path: GLOBAL_CLAUDE_PATH, content: "Global claude guidance" };
const PROJECT_FILE = { path: PROJECT_AGENTS_PATH, content: "Project guidance" };
const PROJECT_CLAUDE_FILE = { path: PROJECT_CLAUDE_PATH, content: "Project claude guidance" };

beforeEach(() => {
	delete process.env[CURSOR_PRESERVE_PI_AGENTS_MD_ENV];
	delete process.env[CURSOR_SETTING_SOURCES_ENV];
});

describe("classifyContextFileOverlap", () => {
	it("classifies AGENTS.md and project CLAUDE.md overlaps", () => {
		expect(classifyContextFileOverlap(GLOBAL_AGENTS_PATH)).toBe("cursor-user-agents");
		expect(classifyContextFileOverlap(PROJECT_AGENTS_PATH)).toBe("cursor-project-rules");
		expect(classifyContextFileOverlap(PROJECT_CLAUDE_PATH)).toBe("cursor-project-rules");
		expect(classifyContextFileOverlap(GLOBAL_CLAUDE_PATH)).toBe("none");
		expect(getAgentsContextFileBaseName("/repo/AGENTS.MD")).toBe("agents.md");
		expect(getAgentsContextFileBaseName("/repo/CLAUDE.MD")).toBe("claude.md");
		expect(isPiAgentDirAgentsMdPath(GLOBAL_AGENTS_PATH)).toBe(true);
		expect(isPiAgentDirAgentsMdPath(PROJECT_AGENTS_PATH)).toBe(false);
	});
});

describe("shouldRemovePiAgentsContextFile", () => {
	it("maps overlap to Cursor user/project layers only", () => {
		expect(shouldRemovePiAgentsContextFile(GLOBAL_FILE, ["all"])).toBe(true);
		expect(shouldRemovePiAgentsContextFile(PROJECT_FILE, ["all"])).toBe(true);
		expect(shouldRemovePiAgentsContextFile(PROJECT_CLAUDE_FILE, ["all"])).toBe(true);
		expect(shouldRemovePiAgentsContextFile(GLOBAL_CLAUDE_FILE, ["all"])).toBe(false);
		expect(shouldRemovePiAgentsContextFile(PROJECT_CLAUDE_FILE, ["user"])).toBe(false);
		expect(shouldRemovePiAgentsContextFile(GLOBAL_FILE, ["project"])).toBe(false);
		expect(shouldRemovePiAgentsContextFile(PROJECT_FILE, ["project"])).toBe(true);
		expect(shouldRemovePiAgentsContextFile(PROJECT_FILE, undefined)).toBe(false);
	});
});

describe("removePiAgentsContextFromSystemPrompt with real pi buildSystemPrompt output", () => {
	it("removes AGENTS.md blocks Cursor will load under all", () => {
		const prompt = buildPiSystemPromptWithContextFiles([GLOBAL_FILE, PROJECT_FILE]);
		expect(prompt).toContain(`${PI_PROJECT_INSTRUCTIONS_OPEN_PREFIX}${GLOBAL_AGENTS_PATH}">`);
		const stripped = removePiAgentsContextFromSystemPrompt(prompt, [GLOBAL_FILE, PROJECT_FILE], ["all"]);
		expect(stripped).not.toContain("Global guidance");
		expect(stripped).not.toContain("Project guidance");
		expect(stripped).not.toContain("<project_context>");
	});

	it("keeps global AGENTS.md when only project setting source is enabled", () => {
		const prompt = buildPiSystemPromptWithContextFiles([GLOBAL_FILE, PROJECT_FILE]);
		const stripped = removePiAgentsContextFromSystemPrompt(prompt, [GLOBAL_FILE, PROJECT_FILE], ["project"]);
		expect(stripped).toContain("Global guidance");
		expect(stripped).not.toContain("Project guidance");
		expect(stripped).toContain(PI_PROJECT_INSTRUCTIONS_OPEN_PREFIX);
	});

	it("does not strip when setting sources are disabled", () => {
		const prompt = buildPiSystemPromptWithContextFiles([GLOBAL_FILE, PROJECT_FILE]);
		expect(removePiAgentsContextFromSystemPrompt(prompt, [GLOBAL_FILE, PROJECT_FILE], undefined)).toBe(prompt);
	});

	it("removes project CLAUDE.md but keeps ~/.pi/agent/CLAUDE.md", () => {
		const prompt = buildPiSystemPromptWithContextFiles([GLOBAL_CLAUDE_FILE, PROJECT_CLAUDE_FILE]);
		const stripped = removePiAgentsContextFromSystemPrompt(
			prompt,
			[GLOBAL_CLAUDE_FILE, PROJECT_CLAUDE_FILE],
			["all"],
		);
		expect(stripped).not.toContain("Project claude guidance");
		expect(stripped).toContain("Global claude guidance");
	});

	it("removes project AGENTS.md and CLAUDE.md together under all", () => {
		const prompt = buildPiSystemPromptWithContextFiles([PROJECT_FILE, PROJECT_CLAUDE_FILE]);
		const stripped = removePiAgentsContextFromSystemPrompt(prompt, [PROJECT_FILE, PROJECT_CLAUDE_FILE], ["all"]);
		expect(stripped).not.toContain("Project guidance");
		expect(stripped).not.toContain("Project claude guidance");
	});

	it("does not break when AGENTS content contains a literal closing tag", () => {
		const trickyFile = {
			path: PROJECT_AGENTS_PATH,
			content: "Use </project_context> only in docs, not as markup.",
		};
		const prompt = buildPiSystemPromptWithContextFiles([trickyFile]);
		const stripped = removePiAgentsContextFromSystemPrompt(prompt, [trickyFile], ["all"]);
		expect(stripped).not.toContain("Use </project_context> only in docs");
		expect(stripped).not.toContain("<project_context>");
	});
});

describe("removePiProjectInstructionsBlockByPath", () => {
	it("removes by path without matching serialized content", () => {
		const prompt = buildPiSystemPromptWithContextFiles([PROJECT_FILE]);
		const mutated = prompt.replace("Project guidance", "Changed guidance");
		const stripped = removePiProjectInstructionsBlockByPath(mutated, PROJECT_AGENTS_PATH);
		expect(stripped).not.toContain(PI_PROJECT_INSTRUCTIONS_OPEN_PREFIX);
		expect(stripped).not.toContain("Changed guidance");
	});
});

describe("resolveCursorFacingSystemPrompt", () => {
	const cursorModel = { provider: "cursor", id: "composer-2.5" } as ExtensionContext["model"];
	const otherModel = { provider: "anthropic", id: "claude-sonnet-4-5" } as ExtensionContext["model"];

	it("strips for cursor models when Cursor loads overlapping rules", () => {
		const prompt = buildPiSystemPromptWithContextFiles([PROJECT_FILE]);
		const resolved = resolveCursorFacingSystemPrompt(
			prompt,
			cursorModel,
			{ contextFiles: [PROJECT_FILE] },
			"all",
		);
		expect(resolved).not.toContain("Project guidance");
	});

	it("leaves prompt unchanged for non-cursor models", () => {
		const prompt = buildPiSystemPromptWithContextFiles([PROJECT_FILE]);
		expect(
			resolveCursorFacingSystemPrompt(prompt, otherModel, { contextFiles: [PROJECT_FILE] }, "all"),
		).toBe(prompt);
	});

	it("leaves prompt unchanged when pi did not load context files (-nc)", () => {
		const prompt = buildPiSystemPromptWithContextFiles([PROJECT_FILE]);
		expect(
			resolveCursorFacingSystemPrompt(prompt, cursorModel, { contextFiles: [] }, "all"),
		).toBe(prompt);
	});

	it("leaves prompt unchanged when PI_CURSOR_SETTING_SOURCES=none", () => {
		const prompt = buildPiSystemPromptWithContextFiles([GLOBAL_FILE, PROJECT_FILE]);
		expect(
			resolveCursorFacingSystemPrompt(prompt, cursorModel, { contextFiles: [GLOBAL_FILE, PROJECT_FILE] }, "none"),
		).toBe(prompt);
	});

	it("leaves prompt unchanged for plugins-only setting sources", () => {
		const prompt = buildPiSystemPromptWithContextFiles([GLOBAL_FILE, PROJECT_FILE]);
		expect(
			resolveCursorFacingSystemPrompt(prompt, cursorModel, { contextFiles: [GLOBAL_FILE, PROJECT_FILE] }, "plugins"),
		).toBe(prompt);
	});

	it("removes project AGENTS.md and CLAUDE.md for project,user sources", () => {
		const prompt = buildPiSystemPromptWithContextFiles([GLOBAL_FILE, PROJECT_FILE, PROJECT_CLAUDE_FILE]);
		const resolved = resolveCursorFacingSystemPrompt(
			prompt,
			cursorModel,
			{ contextFiles: [GLOBAL_FILE, PROJECT_FILE, PROJECT_CLAUDE_FILE] },
			"project,user",
		);
		expect(resolved).not.toContain("Project guidance");
		expect(resolved).not.toContain("Project claude guidance");
		expect(resolved).not.toContain("Global guidance");
	});

	it("honors PI_CURSOR_PRESERVE_PI_AGENTS_MD=1", () => {
		process.env[CURSOR_PRESERVE_PI_AGENTS_MD_ENV] = "1";
		const prompt = buildPiSystemPromptWithContextFiles([PROJECT_FILE]);
		expect(
			resolveCursorFacingSystemPrompt(prompt, cursorModel, { contextFiles: [PROJECT_FILE] }, "all"),
		).toBe(prompt);
	});
});

describe("shouldSuppressPiAgentsContext", () => {
	const cursorModel = { provider: "cursor", id: "composer-2.5" } as ExtensionContext["model"];

	it("is false when no Cursor layer will replace pi context", () => {
		expect(shouldSuppressPiAgentsContext(cursorModel, [GLOBAL_FILE, PROJECT_FILE], undefined)).toBe(false);
		expect(shouldSuppressPiAgentsContext(cursorModel, [GLOBAL_CLAUDE_FILE], ["all"])).toBe(false);
	});

	it("is true when at least one loaded file is covered", () => {
		expect(shouldSuppressPiAgentsContext(cursorModel, [PROJECT_FILE], ["project"])).toBe(true);
		expect(shouldSuppressPiAgentsContext(cursorModel, [PROJECT_CLAUDE_FILE], ["project"])).toBe(true);
	});
});

describe("registerCursorAgentsContextDedup", () => {
	it("strips via before_agent_start for cursor models with overlapping setting sources", async () => {
		const handlers = new Map<string, (event: BeforeAgentStartEvent, ctx: ExtensionContext) => unknown>();
		const pi = {
			on: vi.fn((event: string, handler: (event: BeforeAgentStartEvent, ctx: ExtensionContext) => unknown) => {
				handlers.set(event, handler);
			}),
		};
		registerCursorAgentsContextDedup(pi);

		const prompt = buildPiSystemPromptWithContextFiles([PROJECT_FILE]);
		const result = await handlers.get("before_agent_start")?.(
			{
				type: "before_agent_start",
				prompt: "hello",
				systemPrompt: prompt,
				systemPromptOptions: { contextFiles: [PROJECT_FILE] },
			},
			{ model: { provider: "cursor", id: "composer-2.5" } } as ExtensionContext,
		);

		expect(result?.systemPrompt).toBeTypeOf("string");
		expect(result?.systemPrompt).not.toContain("Project guidance");
	});

	it("does not modify prompt when setting sources are none", async () => {
		process.env[CURSOR_SETTING_SOURCES_ENV] = "none";
		const handlers = new Map<string, (event: BeforeAgentStartEvent, ctx: ExtensionContext) => unknown>();
		const pi = {
			on: vi.fn((event: string, handler: (event: BeforeAgentStartEvent, ctx: ExtensionContext) => unknown) => {
				handlers.set(event, handler);
			}),
		};
		registerCursorAgentsContextDedup(pi);

		const prompt = buildPiSystemPromptWithContextFiles([PROJECT_FILE]);
		const result = await handlers.get("before_agent_start")?.(
			{
				type: "before_agent_start",
				prompt: "hello",
				systemPrompt: prompt,
				systemPromptOptions: { contextFiles: [PROJECT_FILE] },
			},
			{ model: { provider: "cursor", id: "composer-2.5" } } as ExtensionContext,
		);

		expect(result).toBeUndefined();
	});

	it("feeds deduped system prompt from before_agent_start into buildCursorPrompt", async () => {
		const handlers = new Map<string, (event: BeforeAgentStartEvent, ctx: ExtensionContext) => unknown>();
		const pi = {
			on: vi.fn((event: string, handler: (event: BeforeAgentStartEvent, ctx: ExtensionContext) => unknown) => {
				handlers.set(event, handler);
			}),
		};
		registerCursorAgentsContextDedup(pi);

		const prompt = buildPiSystemPromptWithContextFiles([PROJECT_FILE]);
		const hookResult = await handlers.get("before_agent_start")?.(
			{
				type: "before_agent_start",
				prompt: "hello",
				systemPrompt: prompt,
				systemPromptOptions: { contextFiles: [PROJECT_FILE] },
			},
			{ model: { provider: "cursor", id: "composer-2.5" } } as ExtensionContext,
		);

		expect(hookResult?.systemPrompt).toBeTypeOf("string");
		expect(hookResult?.systemPrompt).not.toContain("Project guidance");

		const ctx: Context = {
			systemPrompt: hookResult?.systemPrompt ?? prompt,
			messages: [],
		};
		const result = buildCursorPrompt(ctx);
		expect(result.text).not.toContain("Project guidance");
		expect(result.text).not.toContain("<project_context>");
	});
});
