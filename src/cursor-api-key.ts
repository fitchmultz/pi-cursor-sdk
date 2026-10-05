import { envApiKeyAuth, type ApiKeyAuth, type ApiKeyCredential } from "@earendil-works/pi-ai";
import { parseEnvBoolean } from "./cursor-env-boolean.js";

export const CURSOR_API_KEY_ENV_VAR = "CURSOR_API_KEY";

// Legacy no-auth availability policy only; never a configured models.json key.
export const CURSOR_API_KEY_CONFIG_VALUE = "pi-cursor-sdk-cursor-api-key-placeholder";

const CURSOR_API_KEY_PLACEHOLDERS = new Set([
	CURSOR_API_KEY_ENV_VAR,
	`$${CURSOR_API_KEY_ENV_VAR}`,
	`\${${CURSOR_API_KEY_ENV_VAR}}`,
	CURSOR_API_KEY_CONFIG_VALUE,
]);

export function resolveCursorApiKey(apiKey?: string): string | undefined {
	return normalizeCursorApiKey(apiKey) ?? (apiKey && CURSOR_API_KEY_PLACEHOLDERS.has(apiKey.trim())
		? normalizeCursorApiKey(process.env.CURSOR_API_KEY) : undefined);
}

export function normalizeCursorApiKey(apiKey?: string): string | undefined {
	const trimmed = apiKey?.trim();
	if (!trimmed || CURSOR_API_KEY_PLACEHOLDERS.has(trimmed)) return undefined;
	return trimmed;
}

export async function resolveCursorCredentialApiKey(
	credential: ApiKeyCredential | undefined,
	environment: () => Promise<string | undefined>,
): Promise<string | undefined> {
	return normalizeCursorApiKey(credential?.key)
		?? normalizeCursorApiKey(credential?.env?.CURSOR_API_KEY)
		?? normalizeCursorApiKey(await environment());
}

export function cursorApiKeyAuth(): ApiKeyAuth {
	const standard = envApiKeyAuth("Cursor API key", [CURSOR_API_KEY_ENV_VAR]);
	const auth: ApiKeyAuth = {
		name: standard.name,
		login: standard.login,
		async check(input) {
			const resolved = await auth.resolve(input);
			return resolved ? { type: "api_key", source: resolved.source } : undefined;
		},
		async resolve({ ctx, credential, signal }) {
			signal.throwIfAborted();
			const key = await resolveCursorCredentialApiKey(credential, () => ctx.env(CURSOR_API_KEY_ENV_VAR));
			signal.throwIfAborted();
			if (key) return { auth: { apiKey: key }, env: credential?.env, source: credential ? "stored credential" : CURSOR_API_KEY_ENV_VAR };
			if (!parseEnvBoolean(process.env.PI_CURSOR_HIDE_MODELS_WHEN_LOGGED_OUT, false)) {
				return { auth: { apiKey: CURSOR_API_KEY_CONFIG_VALUE }, source: "fallback" };
			}
			return undefined;
		},
	};
	return auth;
}
