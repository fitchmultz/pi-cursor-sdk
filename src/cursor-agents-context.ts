import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	BuildSystemPromptOptions,
	ExtensionAPI,
	ExtensionContext,
	ExtensionHandler,
} from "@earendil-works/pi-coding-agent";
import { parseEnvBoolean } from "./cursor-env-boolean.js";

export const CURSOR_PRESERVE_PI_AGENTS_MD_ENV = "PI_CURSOR_PRESERVE_PI_AGENTS_MD";

const PROJECT_CONTEXT_BLOCK_PATTERN = /\n*<project_context>[\s\S]*?<\/project_context>\n*/g;

export function stripPiAgentsContextFromSystemPrompt(systemPrompt: string): string {
	return systemPrompt.replace(PROJECT_CONTEXT_BLOCK_PATTERN, "\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

function hasLoadedAgentsContextFiles(systemPromptOptions: BuildSystemPromptOptions): boolean {
	return (systemPromptOptions.contextFiles?.length ?? 0) > 0;
}

function shouldSuppressPiAgentsContextForCursor(model: ExtensionContext["model"]): boolean {
	if (model?.provider !== "cursor") return false;
	if (parseEnvBoolean(process.env[CURSOR_PRESERVE_PI_AGENTS_MD_ENV], false)) return false;
	return true;
}

export function resolveCursorFacingSystemPrompt(
	systemPrompt: string,
	model: ExtensionContext["model"],
	systemPromptOptions: BuildSystemPromptOptions,
): string {
	if (!shouldSuppressPiAgentsContextForCursor(model)) return systemPrompt;
	if (!hasLoadedAgentsContextFiles(systemPromptOptions)) return systemPrompt;
	return stripPiAgentsContextFromSystemPrompt(systemPrompt);
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
