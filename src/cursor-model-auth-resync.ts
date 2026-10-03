import { fingerprintApiKey } from "./model-list-cache.js";
import { resolveCursorRuntimeApiKey } from "./cursor-api-key.js";

export type CursorKeyResolver = () => Promise<string | undefined>;

async function defaultKeyResolver(): Promise<string | undefined> {
	return resolveCursorRuntimeApiKey();
}

// Resolve the fingerprint of the currently configured Cursor API key without
// ever exposing the key itself. Undefined means no Cursor auth is configured
// (logged out, key removed). Reads live pi auth state on every call so a
// /logout between sessions is observed.
export async function resolveCursorKeyFingerprint(
	resolver: CursorKeyResolver = defaultKeyResolver,
): Promise<string | undefined> {
	const apiKey = await resolver();
	if (!apiKey) return undefined;
	return fingerprintApiKey(apiKey);
}

// True when the auth state moved between configured/unconfigured or the key
// itself was rotated. Fingerprints (not keys) are compared.
export function hasCursorAuthChanged(previous: string | undefined, current: string | undefined): boolean {
	return previous !== current;
}
