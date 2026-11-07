import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BuildSystemPromptOptions, NormalizedBuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { createDefaultSystemPromptOptions } from "./context-fixtures.js";
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
): NormalizedBuildSystemPromptOptions {
	return { ...createDefaultSystemPromptOptions(cwd), contextFiles, selectedTools: [] };
}

type PiBuildSystemPrompt = (options: BuildSystemPromptOptions) => string;
let cachedBuildSystemPrompt: PiBuildSystemPrompt | undefined;

/** The installed Pi host's prompt builder: a serialization contract fixture, not an extension runtime dependency. */
export function loadInstalledPiBuildSystemPrompt(): PiBuildSystemPrompt {
	if (cachedBuildSystemPrompt) return cachedBuildSystemPrompt;
	const piMain = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	const require = createRequire(piMain);
	cachedBuildSystemPrompt = require(join(dirname(dirname(piMain)), "dist/core/system-prompt.js")).buildSystemPrompt as PiBuildSystemPrompt;
	return cachedBuildSystemPrompt;
}

/** The installed Pi system prompt for these context files, with no tools. */
export function buildPiSystemPromptWithContextFiles(
	contextFiles: PiAgentsContextFile[],
	cwd = "/repo",
): string {
	return loadInstalledPiBuildSystemPrompt()(makeSystemPromptOptions(contextFiles, cwd));
}
