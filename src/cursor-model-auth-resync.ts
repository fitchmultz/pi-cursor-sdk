import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { resolveCursorApiKey, resolveCursorRuntimeApiKey } from "./cursor-api-key.js";
import { discoverModels, type CursorModelFallbackIssue } from "./model-discovery.js";
import { clearModelListCache, fingerprintApiKey } from "./model-list-cache.js";

export interface CursorCatalogResult {
	models: ProviderModelConfig[];
	issue: CursorModelFallbackIssue | undefined;
}

/** One serialized catalog owner per ExtensionAPI; shutdown never transfers it to a sibling. */
export function createCursorModelAuthResync(apply: (result: CursorCatalogResult) => void) {
	let closed = false;
	let revision = 0;
	let initialized = false;
	let lastRuntimeFingerprint: string | undefined;
	let retryNeeded = false;
	let queue: Promise<unknown> = Promise.resolve();

	function refresh(options: { force?: boolean; resolveCommandKey?: () => Promise<string | undefined> } = {}): Promise<CursorCatalogResult | undefined> {
		const requestedRevision = ++revision;
		const isCurrent = () => !closed && requestedRevision === revision;
		const operation = queue.then(async () => {
			if (!isCurrent()) return;
			const runtimeKey = await resolveCursorRuntimeApiKey();
			if (!isCurrent()) return;
			const fingerprint = runtimeKey ? fingerprintApiKey(runtimeKey) : undefined;
			const changed = initialized && fingerprint !== lastRuntimeFingerprint;
			if (initialized && !changed && !retryNeeded && !options.force) return;
			const forceRefresh = options.force || (initialized && retryNeeded);
			retryNeeded = true;
			const commandKey = options.resolveCommandKey ? await options.resolveCommandKey() : undefined;
			if (!isCurrent()) return;
			const apiKey = resolveCursorApiKey(commandKey) ?? runtimeKey;
			// Cache readers remain fingerprint-bound even when removal is unavailable.
			if (changed || !apiKey) clearModelListCache();
			let issue: CursorModelFallbackIssue | undefined;
			const models = await discoverModels({
				apiKey: apiKey ?? null,
				forceRefresh,
				isCurrent,
				onFallback: (nextIssue) => {
				issue = nextIssue;
			},
			});
			if (!isCurrent()) return;
			const result = { models, issue };
			apply(result);
			lastRuntimeFingerprint = fingerprint;
			initialized = true;
			retryNeeded = issue !== undefined && issue.reason !== "missing-api-key";
			return result;
		});
		queue = operation.catch(() => undefined);
		return operation;
	}

	return {
		refresh,
		close: () => {
			closed = true;
			revision += 1;
		},
	};
}
