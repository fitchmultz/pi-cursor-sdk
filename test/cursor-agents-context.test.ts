import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_PRESERVE_PI_AGENTS_MD_ENV,
	registerCursorAgentsContextDedup,
	resolveCursorFacingSystemPrompt,
	stripPiAgentsContextFromSystemPrompt,
} from "../src/cursor-agents-context.js";

const SAMPLE_SYSTEM_PROMPT = [
	"You are an expert coding assistant.",
	"",
	"<project_context>",
	"",
	"Project-specific instructions and guidelines:",
	"",
	'<project_instructions path="/Users/me/.pi/agent/AGENTS.md">',
	"Global guidance",
	"</project_instructions>",
	"",
	'<project_instructions path="/repo/AGENTS.md">',
	"Project guidance",
	"</project_instructions>",
	"",
	"</project_context>",
	"",
	"Current date: 2026-05-24",
].join("\n");

describe("stripPiAgentsContextFromSystemPrompt", () => {
	it("removes global and project AGENTS blocks", () => {
		const stripped = stripPiAgentsContextFromSystemPrompt(SAMPLE_SYSTEM_PROMPT);
		expect(stripped).toContain("You are an expert coding assistant.");
		expect(stripped).toContain("Current date: 2026-05-24");
		expect(stripped).not.toContain("<project_context>");
		expect(stripped).not.toContain("Global guidance");
		expect(stripped).not.toContain("Project guidance");
	});

	it("is idempotent", () => {
		const once = stripPiAgentsContextFromSystemPrompt(SAMPLE_SYSTEM_PROMPT);
		expect(stripPiAgentsContextFromSystemPrompt(once)).toBe(once);
	});
});

describe("resolveCursorFacingSystemPrompt", () => {
	const cursorModel = { provider: "cursor", id: "composer-2.5" } as ExtensionContext["model"];
	const otherModel = { provider: "anthropic", id: "claude-sonnet-4-5" } as ExtensionContext["model"];

	afterEach(() => {
		delete process.env[CURSOR_PRESERVE_PI_AGENTS_MD_ENV];
	});

	it("strips for cursor models when pi loaded context files", () => {
		const resolved = resolveCursorFacingSystemPrompt(SAMPLE_SYSTEM_PROMPT, cursorModel, {
			contextFiles: [{ path: "/repo/AGENTS.md", content: "Project guidance" }],
		});
		expect(resolved).not.toContain("<project_context>");
	});

	it("leaves prompt unchanged for non-cursor models", () => {
		expect(resolveCursorFacingSystemPrompt(SAMPLE_SYSTEM_PROMPT, otherModel, {
			contextFiles: [{ path: "/repo/AGENTS.md", content: "Project guidance" }],
		})).toBe(SAMPLE_SYSTEM_PROMPT);
	});

	it("leaves prompt unchanged when pi did not load context files (-nc)", () => {
		expect(resolveCursorFacingSystemPrompt(SAMPLE_SYSTEM_PROMPT, cursorModel, { contextFiles: [] })).toBe(
			SAMPLE_SYSTEM_PROMPT,
		);
	});

	it("honors PI_CURSOR_PRESERVE_PI_AGENTS_MD=1", () => {
		process.env[CURSOR_PRESERVE_PI_AGENTS_MD_ENV] = "1";
		expect(resolveCursorFacingSystemPrompt(SAMPLE_SYSTEM_PROMPT, cursorModel, {
			contextFiles: [{ path: "/repo/AGENTS.md", content: "Project guidance" }],
		})).toBe(SAMPLE_SYSTEM_PROMPT);
	});
});

describe("registerCursorAgentsContextDedup", () => {
	it("registers before_agent_start", () => {
		const pi = { on: vi.fn() };
		registerCursorAgentsContextDedup(pi);
		expect(pi.on).toHaveBeenCalledWith("before_agent_start", expect.any(Function));
	});
});
