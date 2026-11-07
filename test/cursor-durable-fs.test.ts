import { closeSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fsyncExistingRegularFile, openExistingRegularFileNoFollow } from "../src/cursor-durable-fs.js";

let tempDir: string | undefined;

afterEach(() => {
	if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	tempDir = undefined;
});

describe("cursor-durable-fs", () => {
	it("opens a usable descriptor and fsyncs an existing regular file", () => {
		tempDir = mkdtempSync(join(tmpdir(), "cursor-durable-fs-regular-"));
		const path = join(tempDir, "regular.txt");
		writeFileSync(path, "hello");
		const fd = openExistingRegularFileNoFollow(path, 0);
		try {
			expect(readFileSync(fd, "utf8")).toBe("hello");
		} finally {
			closeSync(fd);
		}
		expect(fsyncExistingRegularFile(path)).toBe(true);
	});

	it("returns false rather than fsyncing a missing file", () => {
		tempDir = mkdtempSync(join(tmpdir(), "cursor-durable-fs-missing-"));
		expect(fsyncExistingRegularFile(join(tempDir, "missing.txt"))).toBe(false);
	});

	it.skipIf(process.platform === "win32")("rejects a symlink without opening or modifying its target", () => {
		tempDir = mkdtempSync(join(tmpdir(), "cursor-durable-fs-symlink-"));
		const outsideDir = mkdtempSync(join(tmpdir(), "cursor-durable-fs-target-"));
		try {
			const target = join(outsideDir, "target.txt");
			writeFileSync(target, "original");
			const targetMode = statSync(target).mode & 0o777;
			const link = join(tempDir, "link.txt");
			symlinkSync(target, link);

			expect(() => openExistingRegularFileNoFollow(link, 0)).toThrow();
			expect(fsyncExistingRegularFile(link)).toBe(false);

			expect(readFileSync(target, "utf8")).toBe("original");
			expect(statSync(target).mode & 0o777).toBe(targetMode);
		} finally {
			rmSync(outsideDir, { recursive: true, force: true });
		}
	});
});
