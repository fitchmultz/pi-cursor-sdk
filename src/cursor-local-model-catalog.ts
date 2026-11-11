import type { ModelListItem, ModelSelection, ModelVariant } from "@cursor/sdk";
import { fingerprintApiKey, loadFreshCachedModels } from "./model-list-cache.js";

/** Installed SDK LOCAL create/resume/send model validation reads this instead of fetching `GET /v1/models`. */
export const CURSOR_SDK_LOCAL_MODEL_CATALOG_ENV = "CURSOR_SDK_LOCAL_MODEL_CATALOG_JSON";

type LocalValidationModel = Pick<ModelListItem, "id" | "aliases"> & {
	variants?: Array<Pick<ModelVariant, "params" | "isMaxMode">>;
};

let ownedValue: string | undefined;

/**
 * Keep only what SDK validation reads: id/aliases for lookup, and variants only when one is max mode.
 * The env var is inherited by every child process, so the full catalog (~90 KB) is not passed.
 */
export function projectCursorModelsForLocalValidation(models: readonly ModelListItem[]): LocalValidationModel[] {
	return models.map(({ id, aliases, variants }) => ({
		id,
		...(aliases?.length ? { aliases } : {}),
		...(variants?.some((variant) => variant.isMaxMode === true)
			? { variants: variants.map(({ params, isMaxMode }) => ({ params, ...(isMaxMode === true ? { isMaxMode } : {}) })) }
			: {}),
	}));
}

/**
 * Serve the SDK's per-process LOCAL model validation from the fresh cached catalog when it contains the
 * selected model; otherwise clear our value so the SDK validates live. A value we did not set is left untouched.
 */
export function syncCursorSdkLocalModelCatalog(apiKey: string, selection: ModelSelection): void {
	const current = process.env[CURSOR_SDK_LOCAL_MODEL_CATALOG_ENV];
	if (current !== undefined && current !== ownedValue) return;
	const models = loadFreshCachedModels(fingerprintApiKey(apiKey));
	const selected = models?.some((model) => model.id === selection.id || model.aliases?.includes(selection.id) === true);
	const next = models && selected ? JSON.stringify(projectCursorModelsForLocalValidation(models)) : undefined;
	if (next === undefined) delete process.env[CURSOR_SDK_LOCAL_MODEL_CATALOG_ENV];
	else process.env[CURSOR_SDK_LOCAL_MODEL_CATALOG_ENV] = next;
	ownedValue = next;
}
