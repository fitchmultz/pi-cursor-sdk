import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ModelListItem } from "@cursor/sdk";
import { parseEnvBoolean } from "./cursor-env-boolean.js";
import { asRecord } from "./cursor-record-utils.js";

const MODEL_LIST_CACHE_FILE = "cursor-sdk-model-list.json";
const MODEL_LIST_CACHE_VERSION = 1;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE_CLOCK_SKEW_MS = 5 * 60 * 1000;
const DISABLE_ENV_VAR = "PI_CURSOR_SDK_DISABLE_MODEL_CACHE";
const TTL_ENV_VAR = "PI_CURSOR_SDK_MODEL_CACHE_TTL_MS";

interface ModelListCacheFile {
	version: number;
	fetchedAt: number;
	keyFingerprint: string;
	models: ModelListItem[];
}

export interface CachedModelList {
	fetchedAt: number;
	models: ModelListItem[];
}

function getCachePath(): string {
	return join(getAgentDir(), MODEL_LIST_CACHE_FILE);
}

export function isModelCacheDisabled(): boolean {
	return parseEnvBoolean(process.env[DISABLE_ENV_VAR], false);
}

export function getModelCacheTtlMs(): number {
	const raw = process.env[TTL_ENV_VAR];
	if (raw === undefined) return DEFAULT_TTL_MS;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_TTL_MS;
	return parsed;
}

// Fingerprint the API key so a key change invalidates the cache, without ever
// persisting the key itself.
export function fingerprintApiKey(apiKey: string): string {
	return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isModelParameterValue(value: unknown): value is NonNullable<ModelListItem["variants"]>[number]["params"][number] {
	const record = asRecord(value);
	return record !== undefined && typeof record.id === "string" && typeof record.value === "string";
}

function isModelParameterDefinitionValue(value: unknown): value is NonNullable<ModelListItem["parameters"]>[number]["values"][number] {
	const record = asRecord(value);
	return record !== undefined && typeof record.value === "string" && (record.displayName === undefined || typeof record.displayName === "string");
}

function isModelParameterDefinition(value: unknown): value is NonNullable<ModelListItem["parameters"]>[number] {
	const record = asRecord(value);
	if (!record) return false;
	return (
		typeof record.id === "string" &&
		(record.displayName === undefined || typeof record.displayName === "string") &&
		Array.isArray(record.values) &&
		record.values.every(isModelParameterDefinitionValue)
	);
}

function isModelVariant(value: unknown): value is NonNullable<ModelListItem["variants"]>[number] {
	const record = asRecord(value);
	if (!record) return false;
	return (
		Array.isArray(record.params) &&
		record.params.every(isModelParameterValue) &&
		typeof record.displayName === "string" &&
		(record.description === undefined || typeof record.description === "string") &&
		(record.isDefault === undefined || typeof record.isDefault === "boolean")
	);
}

function isModelListItem(value: unknown): value is ModelListItem {
	const record = asRecord(value);
	if (!record) return false;
	return (
		typeof record.id === "string" &&
		typeof record.displayName === "string" &&
		(record.description === undefined || typeof record.description === "string") &&
		(record.aliases === undefined || isStringArray(record.aliases)) &&
		(record.parameters === undefined || (Array.isArray(record.parameters) && record.parameters.every(isModelParameterDefinition))) &&
		(record.variants === undefined || (Array.isArray(record.variants) && record.variants.every(isModelVariant)))
	);
}

function isValidFetchedAt(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= Date.now() + MAX_CACHE_CLOCK_SKEW_MS;
}

function parseModelListCacheFile(value: unknown): ModelListCacheFile | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	if (
		record.version !== MODEL_LIST_CACHE_VERSION ||
		!isValidFetchedAt(record.fetchedAt) ||
		typeof record.keyFingerprint !== "string" ||
		!Array.isArray(record.models) ||
		!record.models.every(isModelListItem)
	) {
		return undefined;
	}
	return {
		version: record.version,
		fetchedAt: record.fetchedAt,
		keyFingerprint: record.keyFingerprint,
		models: record.models,
	};
}

function readCacheFile(): ModelListCacheFile | undefined {
	const path = getCachePath();
	if (!existsSync(path)) return undefined;
	try {
		return parseModelListCacheFile(JSON.parse(readFileSync(path, "utf-8")));
	} catch {
		return undefined;
	}
}

// Return cached models only when caching is enabled, the key matches, and the
// entry is within the TTL. Used on the hot startup path to skip the network.
export function loadFreshCachedModels(keyFingerprint: string, now: number = Date.now()): ModelListItem[] | undefined {
	if (isModelCacheDisabled()) return undefined;
	const ttlMs = getModelCacheTtlMs();
	if (ttlMs <= 0) return undefined;
	const cache = readCacheFile();
	if (!cache || cache.keyFingerprint !== keyFingerprint) return undefined;
	if (now - cache.fetchedAt > ttlMs) return undefined;
	return cache.models;
}

// Return cached models regardless of age, as long as the key matches. Used as a
// resilience fallback when a live discovery request fails.
export function loadAnyCachedModelCatalog(keyFingerprint: string): CachedModelList | undefined {
	if (isModelCacheDisabled()) return undefined;
	const cache = readCacheFile();
	if (!cache || cache.keyFingerprint !== keyFingerprint) return undefined;
	return { fetchedAt: cache.fetchedAt, models: cache.models };
}

export function saveModelListCache(keyFingerprint: string, models: ModelListItem[]): boolean {
	if (isModelCacheDisabled()) return false;
	try {
		const path = getCachePath();
		mkdirSync(dirname(path), { recursive: true });
		const data: ModelListCacheFile = {
			version: MODEL_LIST_CACHE_VERSION,
			fetchedAt: Date.now(),
			keyFingerprint,
			models,
		};
		writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
		chmodSync(path, 0o600);
		return true;
	} catch {
		return false;
	}
}

/** Delete only our valid regular-file catalog, never a user link or other data. */
export function clearModelListCache(): void {
	try {
		const path = getCachePath();
		if (lstatSync(path).isFile() && readCacheFile()) unlinkSync(path);
	} catch {
		// Cache cleanup is best-effort; it must not break native logout.
	}
}

export const __testUtils = {
	getCachePath,
	DEFAULT_TTL_MS,
	DISABLE_ENV_VAR,
	TTL_ENV_VAR,
};
