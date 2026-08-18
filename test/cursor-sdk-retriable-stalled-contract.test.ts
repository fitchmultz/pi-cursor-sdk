import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isCursorSdkConnectionStalledError, sanitizeCursorProviderError } from "../src/cursor-provider-errors.js";
import { readInstalledPackageVersion, resolveInstalledPackageRoot } from "./helpers/installed-package.js";

const sdkRoot = resolveInstalledPackageRoot("@cursor/sdk");
const installedSdkVersion = readInstalledPackageVersion("@cursor/sdk");

interface RetriableStalledContractFixture {
	provenance: {
		sdkPackage: string;
		sdkVersion: string;
		verified: string;
		sourceFile: string;
		issues: string[];
	};
	errorShape: {
		classKind: string;
		name: string;
		message: string;
		displayInfo: {
			title: string;
			detailTemplate: string;
			isRetryable: boolean;
		};
		alsoThrows: {
			message: string;
			when: string;
		};
	};
	sourceMarkers: string[];
	syntheticStackFrame: string;
}

function makeFixtureRetriableStalledError(
	fixture: RetriableStalledContractFixture,
	message: string,
): Error & { kind: string } {
	const error = new Error(message) as Error & { kind: string };
	error.name = fixture.errorShape.name;
	error.kind = fixture.errorShape.classKind;
	error.stack = `${fixture.errorShape.name}: ${message}\n    ${fixture.syntheticStackFrame}`;
	return error;
}

const fixture = JSON.parse(
	readFileSync(new URL("./fixtures/cursor-sdk-retriable-stalled-1.0.27.json", import.meta.url), "utf8"),
) as RetriableStalledContractFixture;

describe("installed Cursor SDK RetriableError connection-stalled contract", () => {
	it("matches installed @cursor/sdk 1.0.27 source markers and classifier shape", () => {
		expect(fixture.provenance.sdkPackage).toBe("@cursor/sdk");
		expect(fixture.provenance.sdkVersion).toBe(installedSdkVersion);
		expect(installedSdkVersion).toBe("1.0.27");

		const sourcePath = join(sdkRoot, "dist/esm/357.js");
		const source = readFileSync(sourcePath, "utf8");
		for (const marker of fixture.sourceMarkers) {
			expect(source).toContain(marker);
		}
		expect(source).toContain(fixture.errorShape.displayInfo.title);
		expect(source).toContain("Please check your network connection and try again.");
		expect(source).toContain(fixture.errorShape.alsoThrows.message);

		const messages = [fixture.errorShape.message, fixture.errorShape.alsoThrows.message] as const;
		for (const message of messages) {
			const error = makeFixtureRetriableStalledError(fixture, message);
			expect(error.name).toBe("RetriableError");
			expect(error.kind).toBe("RetriableError");
			expect(error.message).toBe(message);
			expect(isCursorSdkConnectionStalledError(error)).toBe(true);
			const sanitized = sanitizeCursorProviderError(error, "test-key");
			expect(sanitized.toLowerCase()).toContain("network error");
			expect(sanitized).not.toMatch(/stalled(?: repeatedly)?/i);
		}
	});
});
