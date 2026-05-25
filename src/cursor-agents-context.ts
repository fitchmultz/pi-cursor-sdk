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

export type PiAgentsContextFile = {
	path: string;
	content: string;
};

const PROJECT_CONTEXT_WRAPPER_PATTERN =
	/\n*<project_context>\n*\n*Project-specific instructions and guidelines:\n*\n*<\/project_context>\n*/;

/** Matches pi `buildSystemPrompt()` project-instruction blocks. */
export function buildProjectInstructionsBlock(filePath: string, content: string): string {
	return `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
}

export function isPiGlobalAgentsContextFile(filePath: string): boolean {
	const normalized = filePath.replace(/\\/g, "/");
	return /\/\.pi\/agent\/(AGENTS\.md|AGENTS\.MD|CLAUDE\.md|CLAUDE\.MD)$/i.test(normalized);
}

export function shouldRemovePiAgentsContextFile(
	file: PiAgentsContextFile,
	settingSources: SettingSource[] | undefined,
): boolean {
	if (isPiGlobalAgentsContextFile(file.path)) {
		return cursorSettingSourcesLoadUserAgentsRules(settingSources);
	}
	return cursorSettingSourcesLoadProjectAgentsRules(settingSources);
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

function cleanupProjectContextWrapper(systemPrompt: string): string {
	if (systemPrompt.includes("<project_instructions")) {
		return systemPrompt.replace(/\n{3,}/g, "\n\n").trim();
	}
	return systemPrompt.replace(PROJECT_CONTEXT_WRAPPER_PATTERN, "\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Remove only pi-generated instruction blocks listed in `contextFiles` that Cursor setting sources replace. */
export function removePiAgentsContextFromSystemPrompt(
	systemPrompt: string,
	contextFiles: readonly PiAgentsContextFile[],
	settingSources: SettingSource[] | undefined,
): string {
	let result = systemPrompt;
	let removedAny = false;
	for (const file of contextFiles) {
		if (!shouldRemovePiAgentsContextFile(file, settingSources)) continue;
		const block = buildProjectInstructionsBlock(file.path, file.content);
		if (!result.includes(block)) continue;
		result = result.replace(block, "");
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
