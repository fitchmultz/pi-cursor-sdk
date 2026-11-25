import { isCursorModel } from "./cursor-model.js";
import { registerCursorModelLifecycle, type CursorModelLifecycleExtensionApi } from "./cursor-model-lifecycle.js";
import { resolveEffectiveCursorConfigForContext } from "./cursor-runtime-state.js";
import { filterCursorAgentsContextFiles, resolveCursorFacingSystemPrompt } from "./cursor-agents-context.js";

export type CursorAgentsContextExtensionApi = CursorModelLifecycleExtensionApi;

export function registerCursorAgentsContextDedup(pi: CursorAgentsContextExtensionApi): void {
	registerCursorModelLifecycle(pi, {
		beforeAgentStart: (event, ctx) => {
			if (!isCursorModel(ctx.model)) return undefined;
			const runtime = resolveEffectiveCursorConfigForContext(ctx).runtime.value;
			const options = event.systemPromptOptions;
			if (options && options.forceSystemPrompt === undefined) {
				const filtered = filterCursorAgentsContextFiles(
					ctx.model,
					options.contextFiles ?? [],
					undefined,
					undefined,
					runtime,
				);
				if (filtered) {
					options.contextFiles = filtered;
				}
				return undefined;
			}
			const resolved = resolveCursorFacingSystemPrompt(
				event.systemPrompt,
				ctx.model,
				options,
				undefined,
				undefined,
				runtime,
			);
			if (resolved === event.systemPrompt) return undefined;
			return { systemPrompt: resolved };
		},
	});
}
