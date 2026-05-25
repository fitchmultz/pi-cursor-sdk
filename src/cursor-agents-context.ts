import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	BuildSystemPromptOptions,
	ExtensionAPI,
	ExtensionContext,
	ExtensionHandler,
} from "@earendil-works/pi-coding-agent";
import { parseEnvBoolean } from "./cursor-env-boolean.js";
import {
	cursorSettingSourcesLoadProjectAgentsRules,
	cursorSettingSourcesLoadUserAgentsRules,
	getEffectiveCursorSettingSources,
} from "./cursor-setting-sources.js";
import type { SettingSource } from "@cursor/sdk";

export const CURSOR_PRESERVE_PI_AGENTS_MD_ENV = "PI_CURSOR_PRESERVE_PI_AGENTS_MD";

/** Opening tag prefix pi `buildSystemPrompt()` uses for each context file (path attribute only). */
export const PI_PROJECT_INSTRUCTIONS_OPEN_PREFIX = '<project_instructions path="';
const PI_PROJECT_INSTRUCTIONS_CLOSE = "</project_instructions>";

// Matches pi `buildSystemPrompt()` English `<project_context>` wrapper; tests use real buildSystemPrompt() fixtures.
const PROJECT_CONTEXT_WRAPPER_PATTERN =
	/\n*<project_context>\n*\n*Project-specific instructions and guidelines:\n*\n*<\/project_context>\n*/;

function normalizeContextPath(filePath: string): string {
	return filePath.replace(/\\/g, "/");
}

export type PiAgentsContextFile = {
	path: string;
	content: string;
};

/**
 * Overlap classes for pi context files that Cursor also loads via `settingSources`.
 * @see https://cursor.com/docs/rules — Cursor reads project `CLAUDE.md` like `AGENTS.md`.
 */
export type PiAgentsContextOverlap = "none" | "cursor-user-agents" | "cursor-project-rules";

/** Pi context filenames that can overlap Cursor project/user ambient rules. */
const CURSOR_OVERLAPPING_CONTEXT_BASE_NAMES = new Set(["agents.md", "claude.md"]);

export function getAgentsContextFileBaseName(filePath: string): string {
	const normalized = normalizeContextPath(filePath);
	return normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
}

export function isPiAgentDirContextPath(filePath: string): boolean {
	return /\/\.pi\/agent\//i.test(normalizeContextPath(filePath));
}

/** `~/.pi/agent/AGENTS.md` — overlaps Cursor `user` setting source (global agent instructions). */
export function isPiAgentDirAgentsMdPath(filePath: string): boolean {
	return /\/\.pi\/agent\/agents\.md$/i.test(normalizeContextPath(filePath));
}

/**
 * Classify whether a pi-loaded context file overlaps Cursor ambient rules.
 * Project/repo `AGENTS.md` and `CLAUDE.md` overlap Cursor `project` sources.
 * Only `~/.pi/agent/AGENTS.md` overlaps Cursor `user`; `~/.pi/agent/CLAUDE.md` is kept
 * because Cursor user rules use `~/.claude/CLAUDE.md`, not pi's agent dir path.
 */
export function classifyContextFileOverlap(filePath: string): PiAgentsContextOverlap {
	const base = getAgentsContextFileBaseName(filePath);
	if (!CURSOR_OVERLAPPING_CONTEXT_BASE_NAMES.has(base)) return "none";
	if (base === "agents.md" && isPiAgentDirAgentsMdPath(filePath)) return "cursor-user-agents";
	if (!isPiAgentDirContextPath(filePath)) return "cursor-project-rules";
	return "none";
}

export function shouldRemovePiAgentsContextFile(
	file: PiAgentsContextFile,
	settingSources: SettingSource[] | undefined,
): boolean {
	switch (classifyContextFileOverlap(file.path)) {
		case "cursor-user-agents":
			return cursorSettingSourcesLoadUserAgentsRules(settingSources);
		case "cursor-project-rules":
			return cursorSettingSourcesLoadProjectAgentsRules(settingSources);
		default:
			return false;
	}
}

export function shouldSuppressPiAgentsContext(
	model: ExtensionContext["model"],
	contextFiles: readonly PiAgentsContextFile[],
	settingSources: SettingSource[] | undefined,
): boolean {
	if (model?.provider !== "cursor") return false;
	if (parseEnvBoolean(process.env[CURSOR_PRESERVE_PI_AGENTS_MD_ENV], false)) return false;
	if (contextFiles.length === 0) return false;
	return contextFiles.some((file) => shouldRemovePiAgentsContextFile(file, settingSources));
}

/** Remove one pi `<project_instructions path="...">` block by path (content-agnostic). */
export function removePiProjectInstructionsBlockByPath(systemPrompt: string, filePath: string): string {
	const openTag = `${PI_PROJECT_INSTRUCTIONS_OPEN_PREFIX}${filePath}">`;
	const start = systemPrompt.indexOf(openTag);
	if (start < 0) return systemPrompt;
	const closeStart = systemPrompt.indexOf(PI_PROJECT_INSTRUCTIONS_CLOSE, start);
	if (closeStart < 0) return systemPrompt;
	let end = closeStart + PI_PROJECT_INSTRUCTIONS_CLOSE.length;
	while (end < systemPrompt.length && systemPrompt[end] === "\n") end += 1;
	return systemPrompt.slice(0, start) + systemPrompt.slice(end);
}

function cleanupProjectContextWrapper(systemPrompt: string): string {
	if (systemPrompt.includes(PI_PROJECT_INSTRUCTIONS_OPEN_PREFIX)) {
		return systemPrompt.replace(/\n{3,}/g, "\n\n").trim();
	}
	return systemPrompt.replace(PROJECT_CONTEXT_WRAPPER_PATTERN, "\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Remove pi context blocks that overlap Cursor setting sources. */
export function removePiAgentsContextFromSystemPrompt(
	systemPrompt: string,
	contextFiles: readonly PiAgentsContextFile[],
	settingSources: SettingSource[] | undefined,
): string {
	let result = systemPrompt;
	let removedAny = false;
	for (const file of contextFiles) {
		if (!shouldRemovePiAgentsContextFile(file, settingSources)) continue;
		const next = removePiProjectInstructionsBlockByPath(result, file.path);
		if (next === result) continue;
		result = next;
		removedAny = true;
	}
	if (!removedAny) return systemPrompt;
	return cleanupProjectContextWrapper(result);
}

export function resolveCursorFacingSystemPrompt(
	systemPrompt: string,
	model: ExtensionContext["model"],
	systemPromptOptions: BuildSystemPromptOptions,
	settingSourcesRaw?: string,
): string {
	const contextFiles = systemPromptOptions.contextFiles ?? [];
	const settingSources = getEffectiveCursorSettingSources(settingSourcesRaw);
	if (!shouldSuppressPiAgentsContext(model, contextFiles, settingSources)) {
		return systemPrompt;
	}
	return removePiAgentsContextFromSystemPrompt(systemPrompt, contextFiles, settingSources);
}

type CursorAgentsContextExtensionApi = Pick<ExtensionAPI, "on">;

export function registerCursorAgentsContextDedup(pi: CursorAgentsContextExtensionApi): void {
	const handler: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult> = (event, ctx) => {
		const resolved = resolveCursorFacingSystemPrompt(event.systemPrompt, ctx.model, event.systemPromptOptions);
		if (resolved === event.systemPrompt) return;
		return { systemPrompt: resolved };
	};
	pi.on("before_agent_start", handler);
}
