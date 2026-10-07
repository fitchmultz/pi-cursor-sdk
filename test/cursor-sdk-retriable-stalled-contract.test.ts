import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import ts from "@typescript/typescript6";
import { describe, expect, it } from "vitest";
import { isCursorSdkConnectionStalledError, sanitizeCursorProviderError } from "../src/cursor-provider-errors.js";
import { installedCursorModuleDeclarations, installedCursorModules } from "./helpers/cursor-sdk-installed-modules.js";
import { readInstalledPackageVersion } from "./helpers/installed-package.js";

const fixture = JSON.parse(readFileSync(
	new URL("./fixtures/cursor-sdk-retriable-stalled-1.0.37.json", import.meta.url), "utf8",
)) as {
	provenance: { sdkPackage: string; sdkVersion: string; sourceFile: string; sourceSha256: string };
	branches: Array<{
		transportErrorRetries: number | null;
		error: { name: string; kind: string; message: string; code: string; displayInfo: object };
	}>;
};

async function installedStallFactory() {
	const modules = await installedCursorModules();
	const source = modules.factorySource("./src/agent/local-executor.ts");
	// Retain the distinct synchronous stall-callback provenance guard, without
	// freezing minified names. This is a source contract, not a service recovery test.
	expect(source).toContain("reportStall(");
	expect(source).toContain("this.onStall?.()");
	expect(source).toMatch(/onStall:\(\)=>\{[\w$]+\("stall_detector",\{thresholdMs:[\w$]+,advisoryThresholdMs:[\w$]+\}\),[\w$]+\(\)\}/);
	const capturedSource = readFileSync(new URL(`../${fixture.provenance.sourceFile}`, import.meta.url), "utf8");
	expect(capturedSource).toContain(source);
	expect(createHash("sha256").update(capturedSource).digest("hex")).toBe(fixture.provenance.sourceSha256);
	const { declarations, execute } = installedCursorModuleDeclarations(source);
	const factories = [...declarations.values()].filter((node) => ts.isFunctionDeclaration(node) &&
		node.getText().includes('"Connection stalled repeatedly"'));
	if (factories.length !== 1) throw new Error("Installed stall factory changed");
	const factory = factories[0]!;
	return execute<(options: { cause: Error; requestId: string; connectCode: number; transportErrorRetries?: number }) =>
		Error & { kind: string; code: string; displayInfo: object; requestId: string }>(factory);
}

describe("installed Cursor SDK RetriableError connection-stalled contract", () => {
	it("executes installed stall/retry branches and preserves cause, request, display and classifier provenance", async () => {
		expect(fixture.provenance.sdkPackage).toBe("@cursor/sdk");
		expect(fixture.provenance.sdkVersion).toBe(readInstalledPackageVersion("@cursor/sdk"));
		const makeError = await installedStallFactory();
		const cause = new Error("offline stall cause");
		for (const branch of fixture.branches) {
			const error = makeError({ cause, requestId: "offline-request", connectCode: 1,
				transportErrorRetries: branch.transportErrorRetries ?? undefined });
			expect({ name: error.name, kind: error.kind, message: error.message, code: error.code, displayInfo: error.displayInfo }).toEqual(branch.error);
			expect(error.cause).toBe(cause);
			expect(error.requestId).toBe("offline-request");
			expect(error.stack).toMatch(/@cursor[\\/]sdk[\\/]dist[\\/]esm[\\/]/);
			expect(isCursorSdkConnectionStalledError(error)).toBe(true);
			const sanitized = sanitizeCursorProviderError(error, "test-key");
			expect(sanitized.toLowerCase()).toContain("network error");
			expect(sanitized).not.toMatch(/stalled(?: repeatedly)?/i);
		}
	});
});
