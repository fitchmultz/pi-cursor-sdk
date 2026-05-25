import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BeforeAgentStartEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	buildProjectInstructionsBlock,
	CURSOR_PRESERVE_PI_AGENTS_MD_ENV,
	isPiGlobalAgentsContextFile,
	registerCursorAgentsContextDedup,
	removePiAgentsContextFromSystemPrompt,
	resolveCursorFacingSystemPrompt,
	shouldRemovePiAgentsContextFile,
	shouldSuppressPiAgentsContext,
} from "../src/cursor-agents-context.js";
import { CURSOR_SETTING_SOURCES_ENV } from "../src/cursor-setting-sources.js";

const GLOBAL_AGENTS_PATH = "/Users/me/.pi/agent/AGENTS.md";
const PROJECT_AGENTS_PATH = "/repo/AGENTS.md";

const GLOBAL_FILE = { path: GLOBAL_AGENTS_PATH, content: "Global guidance" };
const PROJECT_FILE = { path: PROJECT_AGENTS_PATH, content: "Project guidance" };

beforeEach(() => {
	delete process.env[CURSOR_PRESERVE_PI_AGENTS_MD_ENV];
	delete process.env[CURSOR_SETTING_SOURCES_ENV];
});

function buildSampleSystemPrompt(contextFiles: Array<{ path: string; content: string }>): string {
	let prompt = "You are an expert coding assistant.\n\n";
	if (contextFiles.length > 0) {
		prompt += "<project_context>\n\n";
		prompt += "Project-specific instructions and guidelines:\n\n";
		for (const file of contextFiles) {
			prompt += buildProjectInstructionsBlock(file.path, file.content);
		}
		prompt += "</project_context>\n";
	}
	prompt += "\nCurrent date: 2026-05-24";
	return prompt;
}

describe("isPiGlobalAgentsContextFile", () => {
	it("detects ~/.pi/agent AGENTS.md", () => {
		expect(isPiGlobalAgentsContextFile(GLOBAL_AGENTS_PATH)).toBe(true);
		expect(isPiGlobalAgentsContextFile(PROJECT_AGENTS_PATH)).toBe(false);
	});
});

describe("shouldRemovePiAgentsContextFile", () => {
	it("maps global files to user layer and project files to project layer", () => {
		expect(shouldRemovePiAgentsContextFile(GLOBAL_FILE, ["all"])).toBe(true);
		expect(shouldRemovePiAgentsContextFile(PROJECT_FILE, ["all"])).toBe(true);
		expect(shouldRemovePiAgentsContextFile(GLOBAL_FILE, ["user"])).toBe(true);
		expect(shouldRemovePiAgentsContextFile(PROJECT_FILE, ["user"])).toBe(false);
		expect(shouldRemovePiAgentsContextFile(GLOBAL_FILE, ["project"])).toBe(false);
		expect(shouldRemovePiAgentsContextFile(PROJECT_FILE, ["project"])).toBe(true);
		expect(shouldRemovePiAgentsContextFile(GLOBAL_FILE, ["plugins"])).toBe(false);
		expect(shouldRemovePiAgentsContextFile(PROJECT_FILE, undefined)).toBe(false);
	});
});

describe("removePiAgentsContextFromSystemPrompt", () => {
	it("removes only blocks Cursor will load under all", () => {
		const prompt = buildSampleSystemPrompt([GLOBAL_FILE, PROJECT_FILE]);
		const stripped = removePiAgentsContextFromSystemPrompt(prompt, [GLOBAL_FILE, PROJECT_FILE], ["all"]);
		expect(stripped).not.toContain("Global guidance");
		expect(stripped).not.toContain("Project guidance");
		expect(stripped).not.toContain("<project_context>");
	});

	it("keeps global guidance when only project setting source is enabled", () => {
		const prompt = buildSampleSystemPrompt([GLOBAL_FILE, PROJECT_FILE]);
		const stripped = removePiAgentsContextFromSystemPrompt(prompt, [GLOBAL_FILE, PROJECT_FILE], ["project"]);
		expect(stripped).toContain("Global guidance");
		expect(stripped).not.toContain("Project guidance");
		expect(stripped).toContain("<project_instructions");
	});

	it("does not strip when setting sources are disabled", () => {
		const prompt = buildSampleSystemPrompt([GLOBAL_FILE, PROJECT_FILE]);
		expect(removePiAgentsContextFromSystemPrompt(prompt, [GLOBAL_FILE, PROJECT_FILE], undefined)).toBe(prompt);
	});

	it("does not break when AGENTS content contains a literal closing tag", () => {
		const trickyFile = {
			path: PROJECT_AGENTS_PATH,
			content: "Use </project_context> only in docs, not as markup.",
		};
		const prompt = buildSampleSystemPrompt([trickyFile]);
		const stripped = removePiAgentsContextFromSystemPrompt(prompt, [trickyFile], ["all"]);
		expect(stripped).not.toContain("Use </project_context> only in docs");
		expect(stripped).not.toContain("<project_context>");
	});
});

describe("resolveCursorFacingSystemPrompt", () => {
	const cursorModel = { provider: "cursor", id: "composer-2.5" } as ExtensionContext["model"];
	const otherModel = { provider: "anthropic", id: "claude-sonnet-4-5" } as ExtensionContext["model"];

	it("strips for cursor models when Cursor loads overlapping rules", () => {
		const prompt = buildSampleSystemPrompt([PROJECT_FILE]);
		const resolved = resolveCursorFacingSystemPrompt(
			prompt,
			cursorModel,
			{ contextFiles: [PROJECT_FILE] },
			"all",
		);
		expect(resolved).not.toContain("Project guidance");
	});

	it("leaves prompt unchanged for non-cursor models", () => {
		const prompt = buildSampleSystemPrompt([PROJECT_FILE]);
		expect(
			resolveCursorFacingSystemPrompt(prompt, otherModel, { contextFiles: [PROJECT_FILE] }, "all"),
		).toBe(prompt);
	});

	it("leaves prompt unchanged when pi did not load context files (-nc)", () => {
		const prompt = buildSampleSystemPrompt([PROJECT_FILE]);
		expect(
			resolveCursorFacingSystemPrompt(prompt, cursorModel, { contextFiles: [] }, "all"),
		).toBe(prompt);
	});

	it("leaves prompt unchanged when PI_CURSOR_SETTING_SOURCES=none", () => {
		const prompt = buildSampleSystemPrompt([GLOBAL_FILE, PROJECT_FILE]);
		expect(
			resolveCursorFacingSystemPrompt(prompt, cursorModel, { contextFiles: [GLOBAL_FILE, PROJECT_FILE] }, "none"),
		).toBe(prompt);
	});

	it("leaves prompt unchanged for plugins-only setting sources", () => {
		const prompt = buildSampleSystemPrompt([GLOBAL_FILE, PROJECT_FILE]);
		expect(
			resolveCursorFacingSystemPrompt(prompt, cursorModel, { contextFiles: [GLOBAL_FILE, PROJECT_FILE] }, "plugins"),
		).toBe(prompt);
	});

	it("removes only project rules for project,user sources", () => {
		const prompt = buildSampleSystemPrompt([GLOBAL_FILE, PROJECT_FILE]);
		const resolved = resolveCursorFacingSystemPrompt(
			prompt,
			cursorModel,
			{ contextFiles: [GLOBAL_FILE, PROJECT_FILE] },
			"project,user",
		);
		expect(resolved).not.toContain("Project guidance");
		expect(resolved).not.toContain("Global guidance");
	});

	it("honors PI_CURSOR_PRESERVE_PI_AGENTS_MD=1", () => {
		process.env[CURSOR_PRESERVE_PI_AGENTS_MD_ENV] = "1";
		const prompt = buildSampleSystemPrompt([PROJECT_FILE]);
		expect(
			resolveCursorFacingSystemPrompt(prompt, cursorModel, { contextFiles: [PROJECT_FILE] }, "all"),
		).toBe(prompt);
	});
});

describe("shouldSuppressPiAgentsContext", () => {
	const cursorModel = { provider: "cursor", id: "composer-2.5" } as ExtensionContext["model"];

	it("is false when no Cursor layer will replace pi context", () => {
		expect(shouldSuppressPiAgentsContext(cursorModel, [GLOBAL_FILE, PROJECT_FILE], undefined)).toBe(false);
		expect(shouldSuppressPiAgentsContext(cursorModel, [GLOBAL_FILE, PROJECT_FILE], ["plugins"])).toBe(false);
	});

	it("is true when at least one loaded file is covered", () => {
		expect(shouldSuppressPiAgentsContext(cursorModel, [PROJECT_FILE], ["project"])).toBe(true);
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

		const prompt = buildSampleSystemPrompt([PROJECT_FILE]);
		const handler = handlers.get("before_agent_start");
		expect(handler).toBeTypeOf("function");

		const result = await handler?.(
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

		const prompt = buildSampleSystemPrompt([PROJECT_FILE]);
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
});
