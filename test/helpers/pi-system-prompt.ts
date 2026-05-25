import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import {
	PI_PROJECT_INSTRUCTIONS_OPEN_PREFIX,
	serializePiProjectContextSection,
	serializePiProjectInstructionsBlock,
	type PiAgentsContextFile,
} from "../../src/cursor-agents-context.js";

export { PI_PROJECT_INSTRUCTIONS_OPEN_PREFIX, serializePiProjectContextSection, serializePiProjectInstructionsBlock };

export function makeSystemPromptOptions(
	contextFiles: PiAgentsContextFile[],
	cwd = "/repo",
): BuildSystemPromptOptions {
	return { cwd, contextFiles, selectedTools: [] };
}

/** Minimal pi-like system prompt containing only the project_context subset this feature owns. */
export function buildPiSystemPromptWithContextFiles(
	contextFiles: PiAgentsContextFile[],
	cwd = "/repo",
): string {
	let prompt =
		"You are an expert coding assistant operating inside pi, a coding agent harness.\n\nGuidelines:\n- Be concise in your responses";
	prompt += serializePiProjectContextSection(contextFiles);
	prompt += `\nCurrent date: 2026-01-01\nCurrent working directory: ${cwd}`;
	return prompt;
}
