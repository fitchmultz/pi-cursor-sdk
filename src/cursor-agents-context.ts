import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	BuildSystemPromptOptions,
	ExtensionAPI,
	ExtensionContext,
	ExtensionHandler,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseEnvBoolean } from "./cursor-env-boolean.js";
import { isCursorModel } from "./cursor-model.js";
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
const PI_PROJECT_CONTEXT_OPEN = "\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n";
const PI_PROJECT_CONTEXT_CLOSE = "</project_context>\n";

function normalizeContextPath(filePath: string): string {
	return filePath.replace(/\\/g, "/");
}

function normalizeDirPath(dirPath: string): string {
	const normalized = normalizeContextPath(dirPath).replace(/\/+$/, "");
	return normalized || "/";
}

export type PiAgentsContextFile = {
	path: string;
	content: string;
};

/** Overlap classes for pi context files that Cursor also loads via `settingSources`. */
export type PiAgentsContextOverlap = "none" | "cursor-user-agents" | "cursor-project-rules";

/** Pi context filenames that can overlap Cursor project/user ambient rules. */
const CURSOR_OVERLAPPING_CONTEXT_BASE_NAMES = new Set(["agents.md", "claude.md"]);

export function getAgentsContextFileBaseName(filePath: string): string {
	const normalized = normalizeContextPath(filePath);
	return normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
}

/** Actual pi agent dir `AGENTS.md` — overlaps Cursor `user` setting source (global agent instructions). */
export function isPiAgentDirAgentsMdPath(filePath: string, agentDir: string = getAgentDir()): boolean {
	const normalized = normalizeContextPath(filePath);
	const agentsMdPath = `${normalizeDirPath(agentDir)}/agents.md`;
	return normalized.toLowerCase() === agentsMdPath.toLowerCase();
}

/** Actual pi agent dir `CLAUDE.md` — kept because Cursor user rules use `~/.claude/CLAUDE.md`. */
export function isPiAgentDirClaudeMdPath(filePath: string, agentDir: string = getAgentDir()): boolean {
	const normalized = normalizeContextPath(filePath);
	const claudeMdPath = `${normalizeDirPath(agentDir)}/claude.md`;
	return normalized.toLowerCase() === claudeMdPath.toLowerCase();
}

/**
 * Classify whether a pi-loaded context file overlaps Cursor ambient rules.
 * Project/repo `AGENTS.md` and `CLAUDE.md` overlap Cursor `project` sources.
 * Only the actual pi agent dir `AGENTS.md` overlaps Cursor `user`; agent-dir `CLAUDE.md` is kept
 * because Cursor user rules use `~/.claude/CLAUDE.md`, not pi's agent dir path.
 */
export function classifyContextFileOverlap(
	filePath: string,
	agentDir: string = getAgentDir(),
): PiAgentsContextOverlap {
	const base = getAgentsContextFileBaseName(filePath);
	if (!CURSOR_OVERLAPPING_CONTEXT_BASE_NAMES.has(base)) return "none";
	if (base === "agents.md" && isPiAgentDirAgentsMdPath(filePath, agentDir)) return "cursor-user-agents";
	if (base === "claude.md" && isPiAgentDirClaudeMdPath(filePath, agentDir)) return "none";
	return "cursor-project-rules";
}

export function shouldRemovePiAgentsContextFile(
	file: PiAgentsContextFile,
	settingSources: SettingSource[] | undefined,
	agentDir?: string,
): boolean {
	switch (classifyContextFileOverlap(file.path, agentDir)) {
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
	agentDir?: string,
): boolean {
	if (!isCursorModel(model)) return false;
	if (parseEnvBoolean(process.env[CURSOR_PRESERVE_PI_AGENTS_MD_ENV], false)) return false;
	if (contextFiles.length === 0) return false;
	return contextFiles.some((file) => shouldRemovePiAgentsContextFile(file, settingSources, agentDir));
}

/** Exact pi `buildSystemPrompt()` serialization for one context file block (including trailing blank line). */
export function serializePiProjectInstructionsBlock(file: PiAgentsContextFile): string {
	return `${PI_PROJECT_INSTRUCTIONS_OPEN_PREFIX}${file.path}">\n${file.content}\n${PI_PROJECT_INSTRUCTIONS_CLOSE}\n\n`;
}

/** Exact pi `buildSystemPrompt()` serialization for the full project context section. */
export function serializePiProjectContextSection(contextFiles: readonly PiAgentsContextFile[]): string {
	if (contextFiles.length === 0) return "";
	return `${PI_PROJECT_CONTEXT_OPEN}${contextFiles.map(serializePiProjectInstructionsBlock).join("")}${PI_PROJECT_CONTEXT_CLOSE}`;
}

/** Remove pi context blocks that overlap Cursor setting sources. */
export function removePiAgentsContextFromSystemPrompt(
	systemPrompt: string,
	contextFiles: readonly PiAgentsContextFile[],
	settingSources: SettingSource[] | undefined,
	agentDir?: string,
): string {
	const retainedContextFiles: PiAgentsContextFile[] = [];
	let removedAny = false;
	for (const file of contextFiles) {
		if (shouldRemovePiAgentsContextFile(file, settingSources, agentDir)) {
			removedAny = true;
			continue;
		}
		retainedContextFiles.push(file);
	}
	if (!removedAny) return systemPrompt;

	const originalSection = serializePiProjectContextSection(contextFiles);
	const start = systemPrompt.indexOf(originalSection);
	if (start < 0) return systemPrompt;

	const replacementSection = serializePiProjectContextSection(retainedContextFiles);
	return systemPrompt.slice(0, start) + replacementSection + systemPrompt.slice(start + originalSection.length);
}

export function resolveCursorFacingSystemPrompt(
	systemPrompt: string,
	model: ExtensionContext["model"],
	systemPromptOptions?: BuildSystemPromptOptions,
	settingSourcesRaw?: string,
	agentDir?: string,
): string {
	if (!systemPromptOptions) return systemPrompt;
	const contextFiles = systemPromptOptions.contextFiles ?? [];
	const settingSources = getEffectiveCursorSettingSources(settingSourcesRaw);
	if (!shouldSuppressPiAgentsContext(model, contextFiles, settingSources, agentDir)) {
		return systemPrompt;
	}
	return removePiAgentsContextFromSystemPrompt(systemPrompt, contextFiles, settingSources, agentDir);
}

type CursorAgentsContextExtensionApi = Pick<ExtensionAPI, "on">;

export function registerCursorAgentsContextDedup(pi: CursorAgentsContextExtensionApi): void {
	const handler: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult> = (event, ctx) => {
		const resolved = resolveCursorFacingSystemPrompt(
			event.systemPrompt,
			ctx.model,
			event.systemPromptOptions,
		);
		if (resolved === event.systemPrompt) return;
		return { systemPrompt: resolved };
	};
	pi.on("before_agent_start", handler);
}
