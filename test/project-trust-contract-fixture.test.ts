import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { createTrustIsolatedPackedFixture, PROJECT_TRUST_FIXTURE_SETUP_TIMEOUT_MS } from "./helpers/project-trust-contract-fixture.js";

it("removes only its allocated packed fixture when preparation fails", () => {
	const scratch = mkdtempSync(join(tmpdir(), "pi-cursor-trust-fixture-cleanup-"));
	const receipt = join(scratch, "pack-destination.txt");
	const failedPack = join(scratch, "failed-pack.cjs");
	const sibling = join(scratch, "keep.txt");
	let allocatedRoot: string | undefined;
	writeFileSync(sibling, "unrelated sibling\n");
	writeFileSync(failedPack, `
const { writeFileSync } = require("node:fs");
writeFileSync(${JSON.stringify(receipt)}, process.argv[process.argv.indexOf("--pack-destination") + 1]);
process.stderr.write("intentional fixture preparation failure\\n");
process.exit(23);
`);
	vi.stubEnv("npm_execpath", failedPack);
	try {
		expect(() => createTrustIsolatedPackedFixture()).toThrow("intentional fixture preparation failure");
		allocatedRoot = dirname(readFileSync(receipt, "utf8"));
		expect(existsSync(allocatedRoot)).toBe(false);
		expect(readFileSync(sibling, "utf8")).toBe("unrelated sibling\n");
	} finally {
		vi.unstubAllEnvs();
		if (allocatedRoot) rmSync(allocatedRoot, { recursive: true, force: true });
		rmSync(scratch, { recursive: true, force: true });
	}
}, PROJECT_TRUST_FIXTURE_SETUP_TIMEOUT_MS);
