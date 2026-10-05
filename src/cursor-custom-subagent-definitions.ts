import type { AgentDefinition, ModelSelection } from "@cursor/sdk";
import type { CursorCustomSubagentConfig, CursorCustomSubagents } from "./cursor-custom-subagents.js";
import { buildCursorModelSelection } from "./model-discovery.js";

/** `AgentDefinition.model` sentinel accepted by the installed Cursor SDK for parent-model inheritance. */
const INHERIT_MODEL = "inherit";

export type CursorCustomSubagentDefinitions = Record<string, AgentDefinition>;

/**
 * Resolves one subagent's SDK model field. An omitted config `model` keeps the SDK default, `inherit`
 * passes through verbatim, and any other value resolves through Cursor model metadata. An id with no
 * registered metadata is passed through unchanged so Cursor reports it at delegation time instead of
 * pi silently rewriting it.
 *
 * `fast` is applied only when config states it: session fast state (`/cursor-fast`, `fastDefaults`) is
 * session-scoped user state for the selected model, and the cloud parent path omits `fast` entirely.
 */
function resolveSubagentModel(subagent: CursorCustomSubagentConfig): ModelSelection | typeof INHERIT_MODEL | undefined {
	if (subagent.model === undefined) return undefined;
	if (subagent.model === INHERIT_MODEL) return INHERIT_MODEL;
	return buildCursorModelSelection(subagent.model, subagent.thinking ?? "off", subagent.fast);
}

/** Maps configured subagents onto Cursor SDK `AgentOptions.agents`. */
export function buildCursorCustomSubagentDefinitions(
	subagents: CursorCustomSubagents | undefined,
): CursorCustomSubagentDefinitions | undefined {
	if (!subagents || Object.keys(subagents).length === 0) return undefined;
	const definitions: CursorCustomSubagentDefinitions = {};
	for (const [name, subagent] of Object.entries(subagents)) {
		const model = resolveSubagentModel(subagent);
		definitions[name] = {
			description: subagent.description,
			prompt: subagent.prompt,
			...(model === undefined ? {} : { model }),
		};
	}
	return definitions;
}
