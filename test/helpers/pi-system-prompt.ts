import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";

type PiBuildSystemPrompt = (options: BuildSystemPromptOptions) => string;

let cachedBuildSystemPrompt: PiBuildSystemPrompt | undefined;

/** Load pi's real `buildSystemPrompt()` from installed package dist (not a public export). */
export function loadPiBuildSystemPrompt(): PiBuildSystemPrompt {
	if (cachedBuildSystemPrompt) return cachedBuildSystemPrompt;
	const piMain = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	const piPackageRoot = dirname(dirname(piMain));
	const require = createRequire(piMain);
	cachedBuildSystemPrompt = require(join(piPackageRoot, "dist/core/system-prompt.js")).buildSystemPrompt as PiBuildSystemPrompt;
	return cachedBuildSystemPrompt;
}

export function buildPiSystemPromptWithContextFiles(
	contextFiles: Array<{ path: string; content: string }>,
	cwd = "/repo",
): string {
	return loadPiBuildSystemPrompt()({
		cwd,
		contextFiles,
		selectedTools: [],
	});
}
