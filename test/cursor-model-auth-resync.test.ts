import { describe, it, expect } from "vitest";
import { fingerprintApiKey } from "../src/model-list-cache.js";
import { hasCursorAuthChanged, resolveCursorKeyFingerprint } from "../src/cursor-model-auth-resync.js";

describe("cursor-model-auth-resync", () => {
	it("fingerprints the resolved key without exposing it", async () => {
		const fingerprint = await resolveCursorKeyFingerprint(async () => "live-key");
		expect(fingerprint).toBe(fingerprintApiKey("live-key"));
		expect(fingerprint).not.toContain("live-key");
	});

	it("resolves undefined when no Cursor auth is configured", async () => {
		await expect(resolveCursorKeyFingerprint(async () => undefined)).resolves.toBeUndefined();
	});

	it("detects logout, login, and rotation but not steady state", () => {
		const fp = fingerprintApiKey("key-a");
		expect(hasCursorAuthChanged(fp, undefined)).toBe(true);
		expect(hasCursorAuthChanged(undefined, fp)).toBe(true);
		expect(hasCursorAuthChanged(fp, fingerprintApiKey("key-b"))).toBe(true);
		expect(hasCursorAuthChanged(fp, fp)).toBe(false);
		expect(hasCursorAuthChanged(undefined, undefined)).toBe(false);
	});
});
