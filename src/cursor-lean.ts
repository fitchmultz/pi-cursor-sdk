import { parseEnvBoolean } from "./cursor-env-boolean.js";

export const CURSOR_LEAN_ENV = "PI_CURSOR_LEAN";

/** Default local runtime policy; set PI_CURSOR_LEAN=0 to restore native Cursor tools. */
export function isCursorLeanEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return parseEnvBoolean(env[CURSOR_LEAN_ENV], true);
}
