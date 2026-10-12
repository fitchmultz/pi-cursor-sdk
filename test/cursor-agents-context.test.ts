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
import * as piAi from "@earendil-works/pi-ai";
import {
	CURSOR_PRESERVE_PI_AGENTS_MD_ENV,
	PI_PROJECT_INSTRUCTIONS_OPEN_PREFIX,
	removePiAgentsContextFromSystemPrompt,
	resolveCursorFacingSystemPrompt,
	serializePiProjectContextSection,
	serializePiProjectInstructionsBlock,
} from "../src/cursor-agents-context.js";
import { registerCursorAgentsContextDedup } from "../src/cursor-agents-context-registration.js";
import { buildCursorPrompt } from "../src/context.js";
import { CURSOR_SETTING_SOURCES_ENV } from "../src/cursor-setting-sources.js";
import { createEventHarness, makeModel } from "./helpers/pi-harness.js";
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
	delete process.env.PI_CURSOR_RUNTIME;
});

describe("installed Pi context deduplication", () => {
	it.each([
		[GLOBAL_AGENTS_PATH, "all", DEFAULT_AGENT_DIR, true],
		[GLOBAL_AGENTS_PATH, "user", DEFAULT_AGENT_DIR, true],
		[GLOBAL_AGENTS_PATH, "project", DEFAULT_AGENT_DIR, false],
		[PROJECT_AGENTS_PATH, "all", DEFAULT_AGENT_DIR, true],
		[PROJECT_AGENTS_PATH, "project", DEFAULT_AGENT_DIR, true],
		[PROJECT_AGENTS_PATH, "user", DEFAULT_AGENT_DIR, false],
		[PROJECT_CLAUDE_PATH, "all", DEFAULT_AGENT_DIR, true],
		[PROJECT_CLAUDE_PATH, "project", DEFAULT_AGENT_DIR, true],
		[PROJECT_CLAUDE_PATH, "user", DEFAULT_AGENT_DIR, false],
		[GLOBAL_CLAUDE_PATH, "all", DEFAULT_AGENT_DIR, false],
		[`${CUSTOM_AGENT_DIR}/AGENTS.md`, "user", CUSTOM_AGENT_DIR, true],
		[`${CUSTOM_AGENT_DIR}/AGENTS.md`, "project", CUSTOM_AGENT_DIR, false],
		[`${CUSTOM_AGENT_DIR}/CLAUDE.md`, "all", CUSTOM_AGENT_DIR, false],
		[`${CUSTOM_AGENT_DIR}/projects/foo/AGENTS.md`, "project", CUSTOM_AGENT_DIR, true],
		[`${CUSTOM_AGENT_DIR}/projects/foo/AGENTS.md`, "user", CUSTOM_AGENT_DIR, false],
		[GLOBAL_AGENTS_PATH, "project", CUSTOM_AGENT_DIR, true],
		[GLOBAL_AGENTS_PATH, "user", CUSTOM_AGENT_DIR, false],
		[NESTED_UNDER_AGENT_AGENTS_PATH, "project", DEFAULT_AGENT_DIR, true],
		[NESTED_UNDER_AGENT_AGENTS_PATH, "user", DEFAULT_AGENT_DIR, false],
		[NESTED_UNDER_AGENT_CLAUDE_PATH, "project", DEFAULT_AGENT_DIR, true],
		[NESTED_UNDER_AGENT_CLAUDE_PATH, "user", DEFAULT_AGENT_DIR, false],
		["/repo/AGENTS.MD", "all", DEFAULT_AGENT_DIR, true],
		["/repo/CLAUDE.MD", "all", DEFAULT_AGENT_DIR, true],
	] as const)("deduplicates path=%s sources=%s agentDir=%s (remove=%s)", (path, sources, agentDir, remove) => {
		const files = [
			{ path, content: "RULE_TO_CHECK" },
			{ path: "/repo/NOTES.md", content: "NEIGHBOR_TO_PRESERVE" },
		];
		const options = makeSystemPromptOptions(files);
		const prompt = loadInstalledPiBuildSystemPrompt()(options);
		expect(prompt).toContain("RULE_TO_CHECK");
		const resolved = resolveCursorFacingSystemPrompt(prompt, makeModel("composer-2.5"), options, sources, agentDir);
		expect(resolved.includes("RULE_TO_CHECK")).toBe(!remove);
		expect(resolved).toContain("NEIGHBOR_TO_PRESERVE");
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

	it("serializes the self-contained transcript project_context section", () => {
		expect(serializePiProjectContextSection([PROJECT_FILE], "transcript")).toBe(
			'<project_context>\nProject-specific instructions and guidelines:\n\n<project_instructions path="/repo/AGENTS.md">\nProject guidance\n</project_instructions>\n</project_context>',
		);
	});

	it("matches installed pi buildSystemPrompt project_context output", () => {
		const prompt = loadInstalledPiBuildSystemPrompt()({
			cwd: "/repo",
			contextFiles: [GLOBAL_FILE, PROJECT_FILE],
			selectedTools: [],
		});
		const format = "getCurrentSystemPrompt" in piAi ? "transcript" : "legacy";
		expect(getProjectContextSection(prompt).trim()).toBe(serializePiProjectContextSection([GLOBAL_FILE, PROJECT_FILE], format).trim());
	});
});

describe("removePiAgentsContextFromSystemPrompt with pi project_context fixtures", () => {
	it("keeps global AGENTS.md when only project setting source is enabled", () => {
		const prompt = buildPiSystemPromptWithContextFiles([GLOBAL_FILE, PROJECT_FILE]);
		const stripped = removePiAgentsContextFromSystemPrompt(prompt, [GLOBAL_FILE, PROJECT_FILE], ["project"]);
		expect(stripped).toContain("Global guidance");
		expect(stripped).not.toContain("Project guidance");
		expect(stripped).toContain(PI_PROJECT_INSTRUCTIONS_OPEN_PREFIX);
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

describe("registerCursorAgentsContextDedup", () => {
	const cursorModelOverrides = { model: makeModel("composer-2.5") };

	it("preserves project instructions through registration in cloud runtime", async () => {
		process.env.PI_CURSOR_RUNTIME = "cloud";
		process.env[CURSOR_SETTING_SOURCES_ENV] = "all";
		const pi = createEventHarness();
		registerCursorAgentsContextDedup(pi);
		const prompt = buildPiSystemPromptWithContextFiles([PROJECT_FILE]);

		const event = {
			type: "before_agent_start",
			messageType: "user",
			prompt: "hello",
			systemPrompt: prompt,
			systemPromptOptions: makeSystemPromptOptions([PROJECT_FILE]),
		} satisfies BeforeAgentStartEvent & { messageType: "user" };
		const result = await pi.invokeEvent("before_agent_start", event, cursorModelOverrides);

		expect(result).toBeUndefined();
		expect(prompt).toContain("Project guidance");
	});

	it("ignores invalid Cursor runtime overrides for non-Cursor models", async () => {
		process.env.PI_CURSOR_RUNTIME = "remote";
		const pi = createEventHarness();
		registerCursorAgentsContextDedup(pi);
		const prompt = buildPiSystemPromptWithContextFiles([PROJECT_FILE]);

		const event = {
			type: "before_agent_start",
			messageType: "user",
			prompt: "hello",
			systemPrompt: prompt,
			systemPromptOptions: makeSystemPromptOptions([PROJECT_FILE]),
		} satisfies BeforeAgentStartEvent & { messageType: "user" };
		const result = await pi.invokeEvent(
			"before_agent_start",
			event,
			{ model: { provider: "anthropic", id: "claude-sonnet-4-5" } as ExtensionContext["model"] },
		);

		expect(result).toBeUndefined();
	});

	it("does not modify prompt when no context files are supplied", async () => {
		const pi = createEventHarness();
		registerCursorAgentsContextDedup(pi);

		const prompt = buildPiSystemPromptWithContextFiles([PROJECT_FILE]);
		const event = {
			type: "before_agent_start",
			messageType: "user",
			prompt: "hello",
			systemPrompt: prompt,
			systemPromptOptions: makeSystemPromptOptions([]),
		} satisfies BeforeAgentStartEvent & { messageType: "user" };
		const result = await pi.invokeEvent("before_agent_start", event, cursorModelOverrides);

		expect(result).toBeUndefined();
	});

	it("does not modify project prompt when setting sources omit project", async () => {
		process.env[CURSOR_SETTING_SOURCES_ENV] = "plugins,user";
		const pi = createEventHarness();
		registerCursorAgentsContextDedup(pi);

		const prompt = buildPiSystemPromptWithContextFiles([PROJECT_FILE]);
		const event = {
			type: "before_agent_start",
			messageType: "user",
			prompt: "hello",
			systemPrompt: prompt,
			systemPromptOptions: makeSystemPromptOptions([PROJECT_FILE]),
		} satisfies BeforeAgentStartEvent & { messageType: "user" };
		const result = await pi.invokeEvent("before_agent_start", event, cursorModelOverrides);

		expect(result).toBeUndefined();
	});

	it("does not modify prompt when setting sources are none", async () => {
		process.env[CURSOR_SETTING_SOURCES_ENV] = "none";
		const pi = createEventHarness();
		registerCursorAgentsContextDedup(pi);

		const prompt = buildPiSystemPromptWithContextFiles([PROJECT_FILE]);
		const event = {
			type: "before_agent_start",
			messageType: "user",
			prompt: "hello",
			systemPrompt: prompt,
			systemPromptOptions: makeSystemPromptOptions([PROJECT_FILE]),
		} satisfies BeforeAgentStartEvent & { messageType: "user" };
		const result = await pi.invokeEvent("before_agent_start", event, cursorModelOverrides);

		expect(result).toBeUndefined();
	});

	it("feeds deduped system prompt from before_agent_start into buildCursorPrompt", async () => {
		process.env[CURSOR_SETTING_SOURCES_ENV] = "all";
		const pi = createEventHarness();
		registerCursorAgentsContextDedup(pi);

		const prompt = buildPiSystemPromptWithContextFiles([PROJECT_FILE]);
		const event = {
			type: "before_agent_start",
			messageType: "user",
			prompt: "hello",
			systemPrompt: prompt,
			systemPromptOptions: makeSystemPromptOptions([PROJECT_FILE]),
		} satisfies BeforeAgentStartEvent & { messageType: "user" };
		const hookResult = await pi.invokeEvent("before_agent_start", event, cursorModelOverrides);

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
