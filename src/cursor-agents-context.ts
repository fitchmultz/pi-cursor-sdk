import type {
	BuildSystemPromptOptions,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseEnvBoolean } from "./cursor-env-boolean.js";
import { isCursorModel } from "./cursor-model.js";
import {
	cursorSettingSourcesIncludes,
	getEffectiveCursorSettingSources,
	resolveCursorSettingSources,
} from "./cursor-setting-sources.js";
import type { SettingSource } from "@cursor/sdk";
import type { CursorRuntime } from "./cursor-config.js";
export const CURSOR_PRESERVE_PI_AGENTS_MD_ENV = "PI_CURSOR_PRESERVE_PI_AGENTS_MD";

/** Opening tag prefix pi `buildSystemPrompt()` uses for each context file (path attribute only). */
export const PI_PROJECT_INSTRUCTIONS_OPEN_PREFIX = '<project_instructions path="';
const PI_PROJECT_INSTRUCTIONS_CLOSE = "</project_instructions>";

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

function getAgentsContextFileBaseName(filePath: string): string {
	const normalized = normalizeContextPath(filePath);
	return normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
}

function isPiAgentDirContextFilePath(
	filePath: string,
	fileName: "agents.md" | "claude.md",
	agentDir: string = getAgentDir(),
): boolean {
	const normalized = normalizeContextPath(filePath);
	const expectedPath = `${normalizeDirPath(agentDir)}/${fileName}`;
	return normalized.toLowerCase() === expectedPath.toLowerCase();
}

/** Actual pi agent dir `AGENTS.md` — overlaps Cursor `user` setting source (global agent instructions). */
function isPiAgentDirAgentsMdPath(filePath: string, agentDir: string = getAgentDir()): boolean {
	return isPiAgentDirContextFilePath(filePath, "agents.md", agentDir);
}

/** Actual pi agent dir `CLAUDE.md` — kept because Cursor user rules use `~/.claude/CLAUDE.md`. */
function isPiAgentDirClaudeMdPath(filePath: string, agentDir: string = getAgentDir()): boolean {
	return isPiAgentDirContextFilePath(filePath, "claude.md", agentDir);
}

/**
 * Classify whether a pi-loaded context file overlaps Cursor ambient rules.
 * Project/repo `AGENTS.md` and `CLAUDE.md` overlap Cursor `project` sources.
 * Only the actual pi agent dir `AGENTS.md` overlaps Cursor `user`; agent-dir `CLAUDE.md` is kept
 * because Cursor user rules use `~/.claude/CLAUDE.md`, not pi's agent dir path.
 */
function classifyContextFileOverlap(
	filePath: string,
	agentDir: string = getAgentDir(),
): PiAgentsContextOverlap {
	const base = getAgentsContextFileBaseName(filePath);
	if (!CURSOR_OVERLAPPING_CONTEXT_BASE_NAMES.has(base)) return "none";
	if (base === "agents.md" && isPiAgentDirAgentsMdPath(filePath, agentDir)) return "cursor-user-agents";
	if (base === "claude.md" && isPiAgentDirClaudeMdPath(filePath, agentDir)) return "none";
	return "cursor-project-rules";
}

function shouldRemovePiAgentsContextFile(
	file: PiAgentsContextFile,
	settingSources: SettingSource[] | undefined,
	agentDir?: string,
): boolean {
	switch (classifyContextFileOverlap(file.path, agentDir)) {
		case "cursor-user-agents":
			return cursorSettingSourcesIncludes(settingSources, "user");
		case "cursor-project-rules":
			return cursorSettingSourcesIncludes(settingSources, "project");
		default:
			return false;
	}
}

function shouldSuppressPiAgentsContext(
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

/** Exact pi `buildSystemPrompt()` serialization for one context file block. */
export function serializePiProjectInstructionsBlock(file: PiAgentsContextFile): string {
	return `${PI_PROJECT_INSTRUCTIONS_OPEN_PREFIX}${file.path}">\n${file.content}\n${PI_PROJECT_INSTRUCTIONS_CLOSE}`;
}

/** Exact pi `buildSystemPrompt()` serialization for the project_context section. */
export function serializePiProjectContextSection(contextFiles: readonly PiAgentsContextFile[]): string {
	if (contextFiles.length === 0) return "";
	return [
		"<project_context>",
		"Project-specific instructions and guidelines:",
		"",
		contextFiles.map(serializePiProjectInstructionsBlock).join("\n\n"),
		"</project_context>",
	].join("\n");
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

	// Match only the exact known files; never strip arbitrary user-authored XML
	// or neighboring custom sections.
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
	runtime: CursorRuntime = "local",
): string {
	if (runtime === "cloud" || !systemPromptOptions) return systemPrompt;
	const contextFiles = systemPromptOptions.contextFiles ?? [];
	const settingSources =
		settingSourcesRaw === undefined
			? getEffectiveCursorSettingSources()
			: resolveCursorSettingSources(settingSourcesRaw);
	if (!shouldSuppressPiAgentsContext(model, contextFiles, settingSources, agentDir)) {
		return systemPrompt;
	}
	return removePiAgentsContextFromSystemPrompt(systemPrompt, contextFiles, settingSources, agentDir);
}
