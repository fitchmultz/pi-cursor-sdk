import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
	return {
		...actual,
		getAgentDir: () => "/Users/me/.pi/agent",
	};
});

import type { BeforeAgentStartEvent, BuildSystemPromptOptions, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Context } from "@earendil-works/pi-ai";
import {
	classifyContextFileOverlap,
	CURSOR_PRESERVE_PI_AGENTS_MD_ENV,
	getAgentsContextFileBaseName,
	isPiAgentDirAgentsMdPath,
	PI_PROJECT_INSTRUCTIONS_OPEN_PREFIX,
	registerCursorAgentsContextDedup,
	removePiAgentsContextFromSystemPrompt,
	resolveCursorFacingSystemPrompt,
	serializePiProjectContextSection,
	serializePiProjectInstructionsBlock,
	shouldRemovePiAgentsContextFile,
	shouldSuppressPiAgentsContext,
} from "../src/cursor-agents-context.js";
import { buildCursorPrompt } from "../src/context.js";
import { CURSOR_SETTING_SOURCES_ENV } from "../src/cursor-setting-sources.js";
import { buildPiSystemPromptWithContextFiles, makeSystemPromptOptions } from "./helpers/pi-system-prompt.js";

const GLOBAL_AGENTS_PATH = "/Users/me/.pi/agent/AGENTS.md";
const GLOBAL_CLAUDE_PATH = "/Users/me/.pi/agent/CLAUDE.md";
const PROJECT_AGENTS_PATH = "/repo/AGENTS.md";
const PROJECT_CLAUDE_PATH = "/repo/CLAUDE.md";
const DEFAULT_AGENT_DIR = "/Users/me/.pi/agent";
const CUSTOM_AGENT_DIR = "/custom/pi-agent";
const NESTED_UNDER_AGENT_AGENTS_PATH = `${DEFAULT_AGENT_DIR}/my-project/AGENTS.md`;
const NESTED_UNDER_AGENT_CLAUDE_PATH = `${DEFAULT_AGENT_DIR}/my-project/CLAUDE.md`;

const GLOBAL_FILE = { path: GLOBAL_AGENTS_PATH, content: "Global guidance" };
const GLOBAL_CLAUDE_FILE = { path: GLOBAL_CLAUDE_PATH, content: "Global claude guidance" };
const PROJECT_FILE = { path: PROJECT_AGENTS_PATH, content: "Project guidance" };
const PROJECT_CLAUDE_FILE = { path: PROJECT_CLAUDE_PATH, content: "Project claude guidance" };

type PiBuildSystemPrompt = (options: BuildSystemPromptOptions) => string;
let cachedBuildSystemPrompt: PiBuildSystemPrompt | undefined;

function loadInstalledPiBuildSystemPrompt(): PiBuildSystemPrompt {
	if (cachedBuildSystemPrompt) return cachedBuildSystemPrompt;
	const piMain = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	const piPackageRoot = dirname(dirname(piMain));
	const require = createRequire(piMain);
	cachedBuildSystemPrompt = require(join(piPackageRoot, "dist/core/system-prompt.js")).buildSystemPrompt as PiBuildSystemPrompt;
	return cachedBuildSystemPrompt;
}

function getProjectContextSection(systemPrompt: string): string {
	const start = systemPrompt.indexOf("\n\n<project_context>");
	const close = "</project_context>\n";
	const end = systemPrompt.indexOf(close, start) + close.length;
	return systemPrompt.slice(start, end);
}

beforeEach(() => {
	delete process.env[CURSOR_PRESERVE_PI_AGENTS_MD_ENV];
	delete process.env[CURSOR_SETTING_SOURCES_ENV];
});

describe("classifyContextFileOverlap", () => {
	it("classifies AGENTS.md and project CLAUDE.md overlaps", () => {
		expect(classifyContextFileOverlap(GLOBAL_AGENTS_PATH, DEFAULT_AGENT_DIR)).toBe("cursor-user-agents");
		expect(classifyContextFileOverlap(PROJECT_AGENTS_PATH, DEFAULT_AGENT_DIR)).toBe("cursor-project-rules");
		expect(classifyContextFileOverlap(PROJECT_CLAUDE_PATH, DEFAULT_AGENT_DIR)).toBe("cursor-project-rules");
		expect(classifyContextFileOverlap(GLOBAL_CLAUDE_PATH, DEFAULT_AGENT_DIR)).toBe("none");
		expect(getAgentsContextFileBaseName("/repo/AGENTS.MD")).toBe("agents.md");
		expect(getAgentsContextFileBaseName("/repo/CLAUDE.MD")).toBe("claude.md");
		expect(isPiAgentDirAgentsMdPath(GLOBAL_AGENTS_PATH, DEFAULT_AGENT_DIR)).toBe(true);
		expect(isPiAgentDirAgentsMdPath(PROJECT_AGENTS_PATH, DEFAULT_AGENT_DIR)).toBe(false);
	});

	it("uses the actual pi agent dir instead of any /.pi/agent/ path", () => {
		const customAgentsPath = `${CUSTOM_AGENT_DIR}/AGENTS.md`;
		const customClaudePath = `${CUSTOM_AGENT_DIR}/CLAUDE.md`;
		const nestedCustomAgentsPath = `${CUSTOM_AGENT_DIR}/projects/foo/AGENTS.md`;

		expect(classifyContextFileOverlap(customAgentsPath, CUSTOM_AGENT_DIR)).toBe("cursor-user-agents");
		expect(classifyContextFileOverlap(customClaudePath, CUSTOM_AGENT_DIR)).toBe("none");
		expect(classifyContextFileOverlap(nestedCustomAgentsPath, CUSTOM_AGENT_DIR)).toBe("cursor-project-rules");
		expect(classifyContextFileOverlap(GLOBAL_AGENTS_PATH, CUSTOM_AGENT_DIR)).toBe("cursor-project-rules");
	});

	it("treats project paths nested under the agent dir as project rules", () => {
		expect(classifyContextFileOverlap(NESTED_UNDER_AGENT_AGENTS_PATH, DEFAULT_AGENT_DIR)).toBe("cursor-project-rules");
		expect(classifyContextFileOverlap(NESTED_UNDER_AGENT_CLAUDE_PATH, DEFAULT_AGENT_DIR)).toBe("cursor-project-rules");
		expect(classifyContextFileOverlap(GLOBAL_CLAUDE_PATH, DEFAULT_AGENT_DIR)).toBe("none");
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

	it("removes nested project AGENTS.md under the agent dir as project rules", () => {
		const nestedFile = { path: NESTED_UNDER_AGENT_AGENTS_PATH, content: "Nested project guidance" };
		expect(shouldRemovePiAgentsContextFile(nestedFile, ["project"], DEFAULT_AGENT_DIR)).toBe(true);
		expect(shouldRemovePiAgentsContextFile(nestedFile, ["user"], DEFAULT_AGENT_DIR)).toBe(false);
	});
});

describe("pi project_context serialization helpers", () => {
	it("serializes context blocks and sections in pi's project_context shape", () => {
		expect(serializePiProjectInstructionsBlock(PROJECT_FILE)).toBe(
			'<project_instructions path="/repo/AGENTS.md">\nProject guidance\n</project_instructions>\n\n',
		);
		expect(serializePiProjectContextSection([PROJECT_FILE])).toBe(
			'\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n<project_instructions path="/repo/AGENTS.md">\nProject guidance\n</project_instructions>\n\n</project_context>\n',
		);
	});

	it("matches installed pi buildSystemPrompt project_context output", () => {
		const prompt = loadInstalledPiBuildSystemPrompt()({
			cwd: "/repo",
			contextFiles: [GLOBAL_FILE, PROJECT_FILE],
			selectedTools: [],
		});
		expect(getProjectContextSection(prompt)).toBe(serializePiProjectContextSection([GLOBAL_FILE, PROJECT_FILE]));
	});
});

describe("removePiAgentsContextFromSystemPrompt with pi project_context fixtures", () => {
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

	it("does not break when AGENTS content contains a literal project_context close tag", () => {
		const trickyFile = {
			path: PROJECT_AGENTS_PATH,
			content: "Use </project_context> only in docs, not as markup.",
		};
		const prompt = buildPiSystemPromptWithContextFiles([trickyFile]);
		const stripped = removePiAgentsContextFromSystemPrompt(prompt, [trickyFile], ["all"]);
		expect(stripped).not.toContain("Use </project_context> only in docs");
		expect(stripped).not.toContain("<project_context>");
	});

	it("does not break when AGENTS content contains a literal project_instructions close tag", () => {
		const trickyFile = {
			path: PROJECT_AGENTS_PATH,
			content: "Document </project_instructions> as escaped text only.",
		};
		const prompt = buildPiSystemPromptWithContextFiles([trickyFile]);
		const stripped = removePiAgentsContextFromSystemPrompt(prompt, [trickyFile], ["all"]);
		expect(stripped).not.toContain("Document </project_instructions>");
		expect(stripped).not.toContain("<project_context>");
	});

	it("keeps non-overlapping context files while removing AGENTS overlap", () => {
		const customFile = { path: "/repo/CUSTOM.md", content: "Custom repo guidance stays." };
		const prompt = buildPiSystemPromptWithContextFiles([PROJECT_FILE, customFile]);
		const stripped = removePiAgentsContextFromSystemPrompt(prompt, [PROJECT_FILE, customFile], ["all"]);
		expect(stripped).not.toContain("Project guidance");
		expect(stripped).toContain("Custom repo guidance stays.");
		expect(stripped).toContain("<project_context>");
	});
});

describe("resolveCursorFacingSystemPrompt", () => {
	const cursorModel = { provider: "cursor", id: "composer-2.5" } as ExtensionContext["model"];
	const cursorSdkModel = { provider: "other", api: "cursor-sdk", id: "composer-2.5" } as ExtensionContext["model"];
	const otherModel = { provider: "anthropic", id: "claude-sonnet-4-5" } as ExtensionContext["model"];

	it("strips for cursor models when Cursor loads overlapping rules", () => {
		const prompt = buildPiSystemPromptWithContextFiles([PROJECT_FILE]);
		const resolved = resolveCursorFacingSystemPrompt(
			prompt,
			cursorModel,
			makeSystemPromptOptions([PROJECT_FILE]),
			"all",
		);
		expect(resolved).not.toContain("Project guidance");
	});

	it("strips for cursor-sdk api models when Cursor loads overlapping rules", () => {
		const prompt = buildPiSystemPromptWithContextFiles([PROJECT_FILE]);
		const resolved = resolveCursorFacingSystemPrompt(
			prompt,
			cursorSdkModel,
			makeSystemPromptOptions([PROJECT_FILE]),
			"all",
		);
		expect(resolved).not.toContain("Project guidance");
	});

	it("leaves prompt unchanged when systemPromptOptions is absent", () => {
		const prompt = buildPiSystemPromptWithContextFiles([PROJECT_FILE]);
		expect(resolveCursorFacingSystemPrompt(prompt, cursorModel, undefined, "all")).toBe(prompt);
	});

	it("leaves prompt unchanged for non-cursor models", () => {
		const prompt = buildPiSystemPromptWithContextFiles([PROJECT_FILE]);
		expect(
			resolveCursorFacingSystemPrompt(prompt, otherModel, makeSystemPromptOptions([PROJECT_FILE]), "all"),
		).toBe(prompt);
	});

	it("leaves prompt unchanged when pi did not load context files (-nc)", () => {
		const prompt = buildPiSystemPromptWithContextFiles([PROJECT_FILE]);
		expect(
			resolveCursorFacingSystemPrompt(prompt, cursorModel, makeSystemPromptOptions([]), "all"),
		).toBe(prompt);
	});

	it("leaves prompt unchanged when PI_CURSOR_SETTING_SOURCES=none", () => {
		const prompt = buildPiSystemPromptWithContextFiles([GLOBAL_FILE, PROJECT_FILE]);
		expect(
			resolveCursorFacingSystemPrompt(
				prompt,
				cursorModel,
				makeSystemPromptOptions([GLOBAL_FILE, PROJECT_FILE]),
				"none",
			),
		).toBe(prompt);
	});

	it("leaves prompt unchanged for plugins-only setting sources", () => {
		const prompt = buildPiSystemPromptWithContextFiles([GLOBAL_FILE, PROJECT_FILE]);
		expect(
			resolveCursorFacingSystemPrompt(
				prompt,
				cursorModel,
				makeSystemPromptOptions([GLOBAL_FILE, PROJECT_FILE]),
				"plugins",
			),
		).toBe(prompt);
	});

	it("removes project AGENTS.md and CLAUDE.md for project,user sources", () => {
		const prompt = buildPiSystemPromptWithContextFiles([GLOBAL_FILE, PROJECT_FILE, PROJECT_CLAUDE_FILE]);
		const resolved = resolveCursorFacingSystemPrompt(
			prompt,
			cursorModel,
			makeSystemPromptOptions([GLOBAL_FILE, PROJECT_FILE, PROJECT_CLAUDE_FILE]),
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
			resolveCursorFacingSystemPrompt(prompt, cursorModel, makeSystemPromptOptions([PROJECT_FILE]), "all"),
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
				systemPromptOptions: makeSystemPromptOptions([PROJECT_FILE]),
			},
			{ model: { provider: "cursor", id: "composer-2.5" } } as ExtensionContext,
		);

		expect(result?.systemPrompt).toBeTypeOf("string");
		expect(result?.systemPrompt).not.toContain("Project guidance");
	});

	it("does not modify prompt when systemPromptOptions is absent", async () => {
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
			} as BeforeAgentStartEvent,
			{ model: { provider: "cursor", id: "composer-2.5" } } as ExtensionContext,
		);

		expect(result).toBeUndefined();
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
				systemPromptOptions: makeSystemPromptOptions([PROJECT_FILE]),
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
				systemPromptOptions: makeSystemPromptOptions([PROJECT_FILE]),
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
