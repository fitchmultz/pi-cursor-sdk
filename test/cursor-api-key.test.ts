import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CURSOR_API_KEY_CONFIG_VALUE,
	resolveCursorApiKey,
} from "../src/cursor-api-key.js";

describe("cursor-api-key helpers", () => {
	const originalEnv = process.env;

	beforeEach(() => {
		process.env = { ...originalEnv };
		delete process.env.CURSOR_API_KEY;
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	it.each(["CURSOR_API_KEY", "$CURSOR_API_KEY", "${CURSOR_API_KEY}", CURSOR_API_KEY_CONFIG_VALUE])(
		"resolves placeholder %s through env only",
		(placeholder) => {
			expect(resolveCursorApiKey(placeholder)).toBeUndefined();
			process.env.CURSOR_API_KEY = "env-key-123";
			expect(resolveCursorApiKey(placeholder)).toBe("env-key-123");
		},
	);
});
