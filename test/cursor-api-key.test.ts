import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CURSOR_API_KEY_CONFIG_VALUE,
	resolveCursorApiKey,
	resolveCursorRuntimeApiKey,
} from "../src/cursor-api-key.js";

describe("cursor-api-key helpers", () => {
	const originalEnv = process.env;
	const originalArgv = process.argv;

	beforeEach(() => {
		process.env = { ...originalEnv };
		delete process.env.CURSOR_API_KEY;
		process.argv = ["node", "vitest"];
	});

	afterEach(() => {
		process.env = originalEnv;
		process.argv = originalArgv;
	});

	it.each(["CURSOR_API_KEY", "$CURSOR_API_KEY", "${CURSOR_API_KEY}", CURSOR_API_KEY_CONFIG_VALUE])(
		"resolves placeholder %s through env only",
		(placeholder) => {
			expect(resolveCursorApiKey(placeholder)).toBeUndefined();
			process.env.CURSOR_API_KEY = "env-key-123";
			expect(resolveCursorApiKey(placeholder)).toBe("env-key-123");
		},
	);

	it("prefers a host-provided key over CURSOR_API_KEY", () => {
		process.env.CURSOR_API_KEY = "env-key-123";
		expect(resolveCursorRuntimeApiKey("host-key-123")).toBe("host-key-123");
	});

	it("ignores every process argv form and falls back to env when host key is absent", () => {
		process.argv = [
			"node", "pi", "--model", "anthropic/first", "--api-key", "first-key",
			"--MODEL", "cursor/case", "--API-KEY", "case-key",
			"--model=cursor/unsupported", "--api-key=equals-key",
			"--models", "cursor/list-like", "--provider", "cursor",
			"--model", "cursor/final", "--api-key", "last-key",
		];
		expect(resolveCursorRuntimeApiKey()).toBeUndefined();

		process.env.CURSOR_API_KEY = "env-key-123";
		expect(resolveCursorRuntimeApiKey()).toBe("env-key-123");
	});

	it("resolves host placeholders through env", () => {
		process.env.CURSOR_API_KEY = "env-key-123";
		expect(resolveCursorRuntimeApiKey(CURSOR_API_KEY_CONFIG_VALUE)).toBe("env-key-123");
	});

	it("returns undefined when host and env keys are missing", () => {
		expect(resolveCursorRuntimeApiKey()).toBeUndefined();
		expect(resolveCursorRuntimeApiKey("   ")).toBeUndefined();
	});
});
