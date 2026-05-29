import type {
	ModelListItem,
	ModelParameterDefinition,
	ModelParameterValue,
	ModelSelection,
} from "@cursor/sdk";
import { AuthStorage, type ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { loadContextWindowCache } from "./context-window-cache.js";
import { loadCursorSdk } from "./cursor-sdk-runtime.js";
import { CURSOR_API_KEY_ENV_VAR, resolveCursorApiKey } from "./cursor-api-key.js";
import { FALLBACK_MODEL_ITEMS } from "./cursor-fallback-models.generated.js";
import {
	fingerprintApiKey,
	loadAnyCachedModelCatalog,
	loadFreshCachedModels,
	saveModelListCache,
} from "./model-list-cache.js";

const CURSOR_PROVIDER_ID = "cursor";
const FALLBACK_CONTEXT_WINDOW = 128000;
const FALLBACK_MAX_TOKENS = 16384;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const TEXT_AND_IMAGE_INPUT: ProviderModelConfig["input"] = ["text", "image"];
const AUTH_SETUP_HINT = "/login (Use an API key -> Cursor), CURSOR_API_KEY, or --api-key with a Cursor SDK API key; Cursor Agent CLI/Desktop login is not reused";
const CATALOG_REFRESH_HINT =
	"After adding auth to an already-started pi session, run /cursor-refresh-models to refresh the full live Cursor model catalog without restarting pi.";

export type CursorModelFallbackReason = "missing-api-key" | "discovery-failed" | "empty-model-list" | "cached-after-error";

export interface CursorModelFallbackIssue {
	reason: CursorModelFallbackReason;
	message: string;
	errorMessage?: string;
}

export interface DiscoverModelsOptions {
	onFallback?: (issue: CursorModelFallbackIssue) => void;
	// Bypass the on-disk model cache and always hit the live catalog. Used by the
	// /cursor-refresh-models command; the startup path leaves this false so warm
	// boots skip the slow network round-trip.
	forceRefresh?: boolean;
}

function getCliApiKeyFromArgv(argv: string[] = process.argv): string | undefined {
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--api-key") {
			const value = argv[index + 1];
			if (!value || value.startsWith("--")) return undefined;
			const trimmed = value.trim();
			return trimmed || undefined;
		}
		const prefix = "--api-key=";
		if (arg.startsWith(prefix)) {
			const trimmed = arg.slice(prefix.length).trim();
			return trimmed || undefined;
		}
	}
	return undefined;
}

async function getStoredCursorApiKey(): Promise<string | undefined> {
	try {
		return resolveCursorApiKey(await AuthStorage.create().getApiKey(CURSOR_PROVIDER_ID, { includeFallback: false }));
	} catch {
		return undefined;
	}
}

async function getDiscoveryApiKey(): Promise<string | undefined> {
	const cliApiKey = resolveCursorApiKey(getCliApiKeyFromArgv());
	if (cliApiKey) return cliApiKey;

	const storedApiKey = await getStoredCursorApiKey();
	if (storedApiKey) return storedApiKey;

	return resolveCursorApiKey(process.env.CURSOR_API_KEY);
}

export interface CursorModelMetadata {
	piModelId: string;
	baseModelId: string;
	selectionModelId: string;
	displayName: string;
	defaultParams: ModelParameterValue[];
	context?: string;
	contextWindow: number;
	supportsFast: boolean;
	defaultFast: boolean;
	supportsReasoning: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	parameterIds: {
		context: boolean;
		reasoning: boolean;
		effort: boolean;
		thinking: boolean;
		fast: boolean;
	};
}

const metadataByPiModelId = new Map<string, CursorModelMetadata>();

function cloneParams(params: ModelParameterValue[]): ModelParameterValue[] {
	return params.map((param) => ({ ...param }));
}

function getParameter(item: ModelListItem, id: string): ModelParameterDefinition | undefined {
	return item.parameters?.find((parameter) => parameter.id === id);
}

function hasBooleanValues(parameter: ModelParameterDefinition | undefined): boolean {
	const values = new Set((parameter?.values ?? []).map((value) => value.value.toLowerCase()));
	return values.has("false") && values.has("true");
}

function getParameterValue(parameter: ModelParameterDefinition | undefined, lowerValue: string): string | null {
	const value = parameter?.values.find((candidate) => candidate.value.toLowerCase() === lowerValue);
	return value?.value ?? null;
}

function getPreferredParameterValue(
	parameter: ModelParameterDefinition | undefined,
	lowerValues: string[],
): string | null {
	for (const value of lowerValues) {
		const candidate = getParameterValue(parameter, value);
		if (candidate) return candidate;
	}
	return null;
}

function mapComparableLevel(
	parameter: ModelParameterDefinition | undefined,
	level: Exclude<ModelThinkingLevel, "off">,
): string | null {
	if (level === "xhigh") {
		return getPreferredParameterValue(parameter, ["xhigh", "max", "extra-high"]);
	}
	return getParameterValue(parameter, level);
}

function getThinkingLevelMap(item: ModelListItem): ThinkingLevelMap | undefined {
	const reasoningParameter = getParameter(item, "reasoning");
	const effortParameter = getParameter(item, "effort");
	const thinkingParameter = getParameter(item, "thinking");
	const valueParameter = effortParameter ?? reasoningParameter ?? thinkingParameter;
	if (!valueParameter) return undefined;

	if (valueParameter.id === "thinking" && hasBooleanValues(valueParameter)) {
		return {
			off: getParameterValue(valueParameter, "false"),
			minimal: null,
			low: null,
			medium: null,
			high: getParameterValue(valueParameter, "true"),
			xhigh: null,
		};
	}

	return {
		off:
			getParameterValue(reasoningParameter, "none") ??
			getParameterValue(reasoningParameter, "off") ??
			getParameterValue(thinkingParameter, "false"),
		minimal: mapComparableLevel(valueParameter, "minimal"),
		low: mapComparableLevel(valueParameter, "low"),
		medium: mapComparableLevel(valueParameter, "medium"),
		high: mapComparableLevel(valueParameter, "high"),
		xhigh: mapComparableLevel(valueParameter, "xhigh"),
	};
}

function parseContextWindow(value: string): number | undefined {
	const match = /^(\d+(?:\.\d+)?)([km])$/i.exec(value.trim());
	if (!match) return undefined;
	const amount = Number(match[1]);
	const unit = match[2]?.toLowerCase();
	if (!Number.isFinite(amount)) return undefined;
	return Math.round(amount * (unit === "m" ? 1000000 : 1000));
}

function getDefaultParams(item: ModelListItem): ModelParameterValue[] {
	if (!item.variants?.length) return [];
	const defaultVariant = item.variants.find((variant) => variant.isDefault) ?? item.variants[0];
	return cloneParams(defaultVariant?.params ?? []);
}

function replaceParam(
	params: ModelParameterValue[],
	id: string,
	value: string,
): ModelParameterValue[] {
	let replaced = false;
	const next = params.map((param) => {
		if (param.id !== id) return { ...param };
		replaced = true;
		return { id, value };
	});
	if (!replaced) next.push({ id, value });
	return next;
}

function getParamValue(params: ModelParameterValue[], id: string): string | undefined {
	return params.find((param) => param.id === id)?.value;
}

function encodePiModelId(modelId: string, context?: string): string {
	return context ? `${modelId}@${context}` : modelId;
}

function getModelName(item: ModelListItem, context?: string, alias?: string): string {
	const displayName = item.displayName || item.id;
	const baseName = alias ? `${displayName} (${alias})` : displayName;
	return context ? `${baseName} @ ${context}` : baseName;
}

function getContextWindow(contextWindowCache: Map<string, number>, piModelId: string, context?: string, baseModelId?: string): number {
	return (
		contextWindowCache.get(piModelId) ??
		(context ? parseContextWindow(context) : undefined) ??
		(baseModelId ? contextWindowCache.get(baseModelId) : undefined) ??
		contextWindowCache.get("default") ??
		FALLBACK_CONTEXT_WINDOW
	);
}

function toMetadata(
	item: ModelListItem,
	piModelId: string,
	selectionModelId: string,
	defaultParams: ModelParameterValue[],
	context: string | undefined,
	contextWindowCache: Map<string, number>,
): CursorModelMetadata {
	const thinkingLevelMap = getThinkingLevelMap(item);
	const fastValue = getParamValue(defaultParams, "fast")?.toLowerCase();
	return {
		piModelId,
		baseModelId: item.id,
		selectionModelId,
		displayName: item.displayName || item.id,
		defaultParams: cloneParams(defaultParams),
		...(context ? { context } : {}),
		contextWindow: getContextWindow(contextWindowCache, piModelId, context, item.id),
		supportsFast: getParameter(item, "fast") !== undefined,
		defaultFast: fastValue === "true",
		supportsReasoning: thinkingLevelMap !== undefined,
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
		parameterIds: {
			context: getParameter(item, "context") !== undefined,
			reasoning: getParameter(item, "reasoning") !== undefined,
			effort: getParameter(item, "effort") !== undefined,
			thinking: getParameter(item, "thinking") !== undefined,
			fast: getParameter(item, "fast") !== undefined,
		},
	};
}

function toModelConfig(metadata: CursorModelMetadata, name: string): ProviderModelConfig {
	return {
		id: metadata.piModelId,
		name,
		reasoning: metadata.supportsReasoning,
		...(metadata.thinkingLevelMap ? { thinkingLevelMap: metadata.thinkingLevelMap } : {}),
		input: [...TEXT_AND_IMAGE_INPUT],
		cost: { ...ZERO_COST },
		contextWindow: metadata.contextWindow,
		maxTokens: FALLBACK_MAX_TOKENS,
	};
}

function getContextValues(item: ModelListItem): string[] {
	return getParameter(item, "context")?.values.map((value) => value.value) ?? [];
}

function getAmbiguousAliases(items: ModelListItem[]): Set<string> {
	const aliasOwners = new Map<string, Set<string>>();
	for (const item of items) {
		for (const rawAlias of item.aliases ?? []) {
			const alias = rawAlias.trim();
			if (!alias || alias === item.id) continue;
			const owners = aliasOwners.get(alias) ?? new Set<string>();
			owners.add(item.id);
			aliasOwners.set(alias, owners);
		}
	}
	return new Set([...aliasOwners.entries()].filter(([, owners]) => owners.size > 1).map(([alias]) => alias));
}

function getModelIds(item: ModelListItem, reservedBaseModelIds: Set<string>, ambiguousAliases: Set<string>): string[] {
	const ids = [item.id];
	for (const rawAlias of item.aliases ?? []) {
		const alias = rawAlias.trim();
		if (!alias || alias === item.id || ids.includes(alias) || reservedBaseModelIds.has(alias) || ambiguousAliases.has(alias)) continue;
		ids.push(alias);
	}
	return ids;
}

function toModelConfigs(
	item: ModelListItem,
	usedPiModelIds: Set<string>,
	reservedBaseModelIds: Set<string>,
	ambiguousAliases: Set<string>,
	contextWindowCache: Map<string, number>,
): ProviderModelConfig[] {
	const defaultParams = getDefaultParams(item);
	const contextValues = getContextValues(item);
	const contexts = contextValues.length > 0 ? contextValues : [undefined];
	const configs: ProviderModelConfig[] = [];

	for (const selectionModelId of getModelIds(item, reservedBaseModelIds, ambiguousAliases)) {
		const alias = selectionModelId === item.id ? undefined : selectionModelId;
		for (const context of contexts) {
			const params = context ? replaceParam(defaultParams, "context", context) : defaultParams;
			const piModelId = encodePiModelId(selectionModelId, context);
			if (usedPiModelIds.has(piModelId)) continue;
			usedPiModelIds.add(piModelId);
			const metadata = toMetadata(item, piModelId, selectionModelId, params, context, contextWindowCache);
			metadataByPiModelId.set(piModelId, metadata);
			configs.push(toModelConfig(metadata, getModelName(item, context, alias)));
		}
	}

	return configs;
}

function sortModelsByBaseId(items: ModelListItem[]): ModelListItem[] {
	return [...items].sort((a, b) => a.id.localeCompare(b.id));
}

function registerModelItems(items: ModelListItem[]): ProviderModelConfig[] {
	metadataByPiModelId.clear();
	const usedPiModelIds = new Set<string>();
	const reservedBaseModelIds = new Set(items.map((item) => item.id));
	const ambiguousAliases = getAmbiguousAliases(items);
	const contextWindowCache = loadContextWindowCache();
	return sortModelsByBaseId(items).flatMap((item) => toModelConfigs(item, usedPiModelIds, reservedBaseModelIds, ambiguousAliases, contextWindowCache));
}

export function getCursorModelMetadata(modelId: string): CursorModelMetadata | undefined {
	return metadataByPiModelId.get(modelId);
}

export function getCursorModelMetadataEntries(): CursorModelMetadata[] {
	return [...metadataByPiModelId.values()].map((metadata) => ({
		...metadata,
		defaultParams: cloneParams(metadata.defaultParams),
		...(metadata.thinkingLevelMap ? { thinkingLevelMap: { ...metadata.thinkingLevelMap } } : {}),
		parameterIds: { ...metadata.parameterIds },
	}));
}

function setParam(params: ModelParameterValue[], id: string, value: string): void {
	const existing = params.find((param) => param.id === id);
	if (existing) {
		existing.value = value;
	} else {
		params.push({ id, value });
	}
}

function deleteParam(params: ModelParameterValue[], id: string): void {
	const index = params.findIndex((param) => param.id === id);
	if (index >= 0) params.splice(index, 1);
}

function applyThinkingLevel(
	metadata: CursorModelMetadata,
	params: ModelParameterValue[],
	level: ModelThinkingLevel,
): void {
	const mapped = metadata.thinkingLevelMap?.[level];
	if (mapped === undefined || mapped === null) return;

	if (level === "off") {
		if (metadata.parameterIds.thinking && mapped === "false") {
			setParam(params, "thinking", mapped);
			deleteParam(params, "effort");
			return;
		}
		if (metadata.parameterIds.reasoning) {
			setParam(params, "reasoning", mapped);
		}
		return;
	}

	if (metadata.parameterIds.effort) {
		if (metadata.parameterIds.thinking) setParam(params, "thinking", "true");
		setParam(params, "effort", mapped);
		return;
	}

	if (metadata.parameterIds.reasoning) {
		setParam(params, "reasoning", mapped);
		return;
	}

	if (metadata.parameterIds.thinking) {
		setParam(params, "thinking", mapped);
	}
}

export function buildCursorModelSelection(
	modelId: string,
	thinkingLevel: ModelThinkingLevel,
	fastEnabled?: boolean,
): ModelSelection {
	const metadata = getCursorModelMetadata(modelId);
	if (!metadata) return { id: modelId };

	const params = cloneParams(metadata.defaultParams);
	applyThinkingLevel(metadata, params, thinkingLevel);

	if (metadata.supportsFast && fastEnabled !== undefined) {
		setParam(params, "fast", fastEnabled ? "true" : "false");
	}

	return params.length > 0 ? { id: metadata.selectionModelId, params } : { id: metadata.selectionModelId };
}

function scrubDiscoveryErrorText(text: string, apiKey: string): string {
	let scrubbed = text.replace(new RegExp(apiKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "[redacted]");
	return scrubbed
		.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
		.replace(/((?:^|[\s,{])cookie["']?\s*[:=]\s*["']?)[^\n]+/gi, "$1[redacted]")
		.replace(
			/((?:authorization|api[_-]?key|apiKey|token|session(?:[_-]?id)?)["']?\s*[:=]\s*["']?)[^"'\s,;}]+/gi,
			"$1[redacted]",
		)
		.trim();
}

function sanitizeDiscoveryError(error: unknown, apiKey: string): string | undefined {
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
	const scrubbed = scrubDiscoveryErrorText(message, apiKey);
	return scrubbed || undefined;
}

function useFallbackModels(options: DiscoverModelsOptions, issue: CursorModelFallbackIssue): ProviderModelConfig[] {
	options.onFallback?.(issue);
	return registerModelItems(FALLBACK_MODEL_ITEMS);
}

export async function discoverModels(options: DiscoverModelsOptions = {}): Promise<ProviderModelConfig[]> {
	const apiKey = await getDiscoveryApiKey();
	if (!apiKey) {
		return useFallbackModels(options, {
			reason: "missing-api-key",
			message: `Cursor model discovery needs an API key from ${AUTH_SETUP_HINT}. Using fallback Cursor models so /login and model selection still work; fallback models can run once auth exists. ${CATALOG_REFRESH_HINT}`,
		});
	}

	const keyFingerprint = fingerprintApiKey(apiKey);

	if (!options.forceRefresh) {
		const cachedModels = loadFreshCachedModels(keyFingerprint);
		if (cachedModels && cachedModels.length > 0) {
			return registerModelItems(cachedModels);
		}
	}

	try {
		const { Cursor } = await loadCursorSdk();
		const models = await Cursor.models.list({ apiKey });
		if (models.length > 0) {
			saveModelListCache(keyFingerprint, models);
			return registerModelItems(models);
		}
		return useFallbackModels(options, {
			reason: "empty-model-list",
			message: `Cursor model discovery returned no models. Using fallback Cursor models; verify ${AUTH_SETUP_HINT}. ${CATALOG_REFRESH_HINT}`,
		});
	} catch (error) {
		const errorMessage = sanitizeDiscoveryError(error, apiKey);
		// Prefer a previously cached catalog over the generic bundled fallback when
		// a live refresh fails (e.g. transient network/auth errors), but keep the
		// provenance visible so refresh commands do not claim a live refresh worked.
		const cachedCatalog = loadAnyCachedModelCatalog(keyFingerprint);
		if (cachedCatalog && cachedCatalog.models.length > 0) {
			options.onFallback?.({
				reason: "cached-after-error",
				message: `Cursor model discovery failed; using cached Cursor model catalog from ${new Date(cachedCatalog.fetchedAt).toISOString()}. ${errorMessage}`,
				errorMessage,
			});
			return registerModelItems(cachedCatalog.models);
		}
		return useFallbackModels(options, {
			reason: "discovery-failed",
			message: `Cursor model discovery failed${errorMessage ? `: ${errorMessage}` : ""}. Using fallback Cursor models; verify ${AUTH_SETUP_HINT}. ${CATALOG_REFRESH_HINT}`,
			...(errorMessage ? { errorMessage } : {}),
		});
	}
}

export const __testUtils = {
	parseContextWindow,
	registerModelItems,
	getCliApiKeyFromArgv,
	normalizeApiKey: resolveCursorApiKey,
};
