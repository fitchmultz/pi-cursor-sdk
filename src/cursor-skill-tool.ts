import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type {
	BuildSystemPromptOptions,
	ExtensionAPI,
	ExtensionContext,
	Skill,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { arePiToolsDisabled } from "./cursor-active-tools.js";
import type { CursorRuntime } from "./cursor-config.js";
import { isCursorModel } from "./cursor-model.js";
import { registerCursorModelLifecycle, type CursorModelLifecycleExtensionApi } from "./cursor-model-lifecycle.js";
import { resolveCursorPiToolBridgeEnabled } from "./cursor-pi-tool-bridge-env.js";
import { resolveEffectiveCursorConfigForContext } from "./cursor-runtime-state.js";

export const CURSOR_ACTIVATE_SKILL_TOOL_NAME = "cursor_activate_skill";
export const CURSOR_ACTIVATE_SKILL_MCP_NAME = "pi__cursor_activate_skill";

const AVAILABLE_SKILLS_SECTION_PATTERN = /\n\nThe following skills provide specialized instructions for specific tasks\.[\s\S]*?<\/available_skills>/;
const MAX_SKILL_RESOURCES = 80;
const RESOURCE_DIR_NAMES = ["scripts", "references", "assets"] as const;

type CursorSkillToolExtensionApi = Pick<ExtensionAPI, "getActiveTools" | "registerTool" | "setActiveTools"> & CursorModelLifecycleExtensionApi;

type CursorActivateSkillParams = {
	name?: string;
};

interface CursorSkillActivationDetails {
	name?: string;
	filePath?: string;
	baseDir?: string;
	resources: string[];
	availableSkillNames: string[];
}

let currentSkillsByName = new Map<string, Skill>();

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function getVisibleSkills(skills: readonly Skill[] | undefined): Skill[] {
	return (skills ?? []).filter((skill) => !skill.disableModelInvocation);
}

function setCurrentSkills(skills: readonly Skill[] | undefined): void {
	currentSkillsByName = new Map(getVisibleSkills(skills).map((skill) => [skill.name, skill]));
}

function getAvailableSkillNames(): string[] {
	return [...currentSkillsByName.keys()].sort();
}

function resolveEffectiveRuntimeForSkillLifecycle(
	cursorModel: boolean,
	ctx: Pick<ExtensionContext, "cwd"> & Partial<Pick<ExtensionContext, "isProjectTrusted">>,
): CursorRuntime {
	return cursorModel ? resolveEffectiveCursorConfigForContext(ctx).runtime.value : "local";
}

function shouldExposeSkillTool(model: ExtensionContext["model"], runtime: CursorRuntime): boolean {
	return runtime === "local" && isCursorModel(model) && resolveCursorPiToolBridgeEnabled() && currentSkillsByName.size > 0;
}

function syncCursorSkillToolForModel(
	pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">,
	model: ExtensionContext["model"],
	runtime: CursorRuntime,
): void {
	const activeToolNames = new Set(pi.getActiveTools());
	const shouldBeActive = !arePiToolsDisabled(pi) && shouldExposeSkillTool(model, runtime);
	const alreadyActive = activeToolNames.has(CURSOR_ACTIVATE_SKILL_TOOL_NAME);
	if (shouldBeActive === alreadyActive) return;
	if (shouldBeActive) {
		activeToolNames.add(CURSOR_ACTIVATE_SKILL_TOOL_NAME);
	} else {
		activeToolNames.delete(CURSOR_ACTIVATE_SKILL_TOOL_NAME);
	}
	pi.setActiveTools([...activeToolNames]);
}

export function formatCursorSkillsForPrompt(skills: readonly Skill[]): string {
	const visibleSkills = getVisibleSkills(skills);
	if (visibleSkills.length === 0) return "";

	const lines = [
		"\n\nThe following skills provide specialized instructions for specific tasks.",
		`When a task matches a skill's description, call ${CURSOR_ACTIVATE_SKILL_MCP_NAME} with the skill name to load its full SKILL.md instructions before proceeding.`,
		"If the pi bridge is disabled and the activation tool is unavailable, use Cursor's file-read capability on the listed SKILL.md location instead.",
		"When a skill references relative paths, resolve them against the skill directory (the parent of SKILL.md / dirname of the path) and use absolute paths in tool calls.",
		"",
		"<available_skills>",
	];
	for (const skill of visibleSkills) {
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(`    <description>${escapeXml(skill.description)}</description>`);
		lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
		lines.push("  </skill>");
	}
	lines.push("</available_skills>");
	return lines.join("\n");
}

export function resolveCursorSkillSystemPrompt(
	systemPrompt: string,
	model: ExtensionContext["model"],
	systemPromptOptions?: BuildSystemPromptOptions,
	runtime: CursorRuntime = "local",
): string {
	if (!isCursorModel(model)) return systemPrompt;
	if (runtime === "cloud") return systemPrompt.replace(AVAILABLE_SKILLS_SECTION_PATTERN, "");
	const skills = getVisibleSkills(systemPromptOptions?.skills);
	if (skills.length === 0) return systemPrompt;
	const replacement = formatCursorSkillsForPrompt(skills);
	if (AVAILABLE_SKILLS_SECTION_PATTERN.test(systemPrompt)) {
		return systemPrompt.replace(AVAILABLE_SKILLS_SECTION_PATTERN, replacement);
	}
	return `${systemPrompt}${replacement}`;
}

async function collectResourcePaths(root: string, absoluteDir: string, output: string[]): Promise<void> {
	if (output.length >= MAX_SKILL_RESOURCES) return;
	let entries: Dirent[];
	try {
		entries = await readdir(absoluteDir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (output.length >= MAX_SKILL_RESOURCES) return;
		const absolutePath = join(absoluteDir, entry.name);
		if (entry.isSymbolicLink()) continue;
		if (entry.isDirectory()) {
			await collectResourcePaths(root, absolutePath, output);
			continue;
		}
		if (!entry.isFile()) continue;
		output.push(relative(root, absolutePath).replace(/\\/g, "/"));
	}
}

async function listSkillResourcePaths(baseDir: string): Promise<string[]> {
	const resources: string[] = [];
	for (const resourceDirName of RESOURCE_DIR_NAMES) {
		await collectResourcePaths(baseDir, join(baseDir, resourceDirName), resources);
		if (resources.length >= MAX_SKILL_RESOURCES) break;
	}
	return resources;
}

function buildActivationDetails(skill: Skill | undefined, resources: string[] = []): CursorSkillActivationDetails {
	return {
		name: skill?.name,
		filePath: skill?.filePath,
		baseDir: skill ? dirname(skill.filePath) : undefined,
		resources,
		availableSkillNames: getAvailableSkillNames(),
	};
}

function formatSkillResources(resources: readonly string[]): string {
	if (resources.length === 0) return "<skill_resources />";
	return [
		"<skill_resources>",
		...resources.map((resource) => `  <file>${escapeXml(resource)}</file>`),
		"</skill_resources>",
	].join("\n");
}

function wrapSkillContent(skill: Skill, content: string, resources: readonly string[]): string {
	const baseDir = dirname(skill.filePath);
	return [
		`<skill_content name=\"${escapeXml(skill.name)}\">`,
		content.trim(),
		"",
		`Skill directory: ${baseDir}`,
		"Relative paths in this skill are relative to the skill directory.",
		formatSkillResources(resources),
		"</skill_content>",
	].join("\n");
}

export function registerCursorSkillTool(pi: CursorSkillToolExtensionApi): void {
	pi.registerTool({
		name: CURSOR_ACTIVATE_SKILL_TOOL_NAME,
		label: "Cursor skill",
		description: "Load full pi Agent Skill instructions for Cursor. Use with a skill name from the current <available_skills> catalog before applying that skill.",
		parameters: Type.Object({
			name: Type.String({ description: "Skill name from the current <available_skills> catalog" }),
		}),
		async execute(_toolCallId, params) {
			const requestedName = (params as CursorActivateSkillParams).name?.trim();
			if (!requestedName) {
				throw new Error("No skill name was provided.");
			}
			const skill = currentSkillsByName.get(requestedName);
			if (!skill) {
				throw new Error(
					`Skill not available: ${requestedName}. Available skills: ${getAvailableSkillNames().join(", ") || "none"}.`,
				);
			}

			try {
				const [content, resources] = await Promise.all([
					readFile(skill.filePath, "utf8"),
					listSkillResourcePaths(dirname(skill.filePath)),
				]);
				return {
					content: [{ type: "text" as const, text: wrapSkillContent(skill, content, resources) }],
					details: buildActivationDetails(skill, resources),
				};
			} catch (error) {
				throw new Error(
					`Failed to load skill ${requestedName} from ${skill.filePath}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		},
	});

	const clearSkillsAndSync = (model: ExtensionContext["model"], runtime: CursorRuntime = "local"): void => {
		setCurrentSkills([]);
		syncCursorSkillToolForModel(pi, model, runtime);
	};

	registerCursorModelLifecycle(pi, {
		sessionStart: (_event, ctx) => {
			clearSkillsAndSync(ctx.model);
		},
		modelSelect: (event) => {
			clearSkillsAndSync(event.model);
		},
		turnStart: (_event, ctx) => {
			const cursorModel = isCursorModel(ctx.model);
			const runtime = resolveEffectiveRuntimeForSkillLifecycle(cursorModel, ctx);
			if (!cursorModel || runtime === "cloud") setCurrentSkills([]);
			syncCursorSkillToolForModel(pi, ctx.model, runtime);
		},
		beforeAgentStart: (event, ctx) => {
			const cursorModel = isCursorModel(ctx.model);
			const runtime = resolveEffectiveRuntimeForSkillLifecycle(cursorModel, ctx);
			if (cursorModel && runtime === "local") {
				setCurrentSkills(event.systemPromptOptions?.skills);
			} else {
				setCurrentSkills([]);
			}
			syncCursorSkillToolForModel(pi, ctx.model, runtime);
			const resolved = resolveCursorSkillSystemPrompt(event.systemPrompt, ctx.model, event.systemPromptOptions, runtime);
			if (resolved === event.systemPrompt) return undefined;
			return { systemPrompt: resolved };
		},
	});
}

export const __testUtils = {
	AVAILABLE_SKILLS_SECTION_PATTERN,
	buildActivationDetails,
	setCurrentSkills,
	listSkillResourcePaths,
	wrapSkillContent,
};
