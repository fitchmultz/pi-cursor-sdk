import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
	MAX_BUNDLE_AGGREGATE_BYTES, MAX_BUNDLE_FILE_BYTES, MAX_BUNDLE_FILE_COUNT,
	MAX_BUNDLE_PATH_BYTES, MAX_BUNDLE_PATH_COMPONENTS, MAX_INFLATED_BUNDLE_JSON_BYTES,
} from "./artifact-bundle-contract.mjs";

const MAGIC = Buffer.from([80, 73, 65, 82, 84, 48, 49, 0]);
/** Exit statuses documented in `artifact-openat-extract.c` `main()`. */
const HELPER_EXIT_OUTCOMES = new Map([[0, "committed"], [2, "rejected"], [3, "rolled-back"], [4, "rollback-incomplete"]]);
/** Compiled once per process: `unattempted`, then `ready` with its path or `unavailable`. */
let helper = { kind: "unattempted" };

function compileHelper() {
	if (helper.kind !== "unattempted") return helper;
	const source = fileURLToPath(new URL("./artifact-openat-extract.c", import.meta.url));
	const content = readFileSync(source);
	const nativeLimits = [
		MAX_INFLATED_BUNDLE_JSON_BYTES, MAX_BUNDLE_FILE_COUNT, MAX_BUNDLE_FILE_BYTES,
		MAX_BUNDLE_AGGREGATE_BYTES, MAX_BUNDLE_PATH_BYTES, MAX_BUNDLE_PATH_COMPONENTS,
	];
	const key = createHash("sha256").update(content).update(process.platform).update(process.arch)
		.update(nativeLimits.join(":"))
		.digest("hex").slice(0, 16);
	const directory = mkdtempSync(join(tmpdir(), `pi-cursor-artifact-openat-${key}-`));
	chmodSync(directory, 0o700);
	const output = join(directory, "extract");
	const compiled = spawnSync("cc", [
		"-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
		`-DMAX_INPUT=${MAX_INFLATED_BUNDLE_JSON_BYTES}`,
		`-DMAX_FILES=${MAX_BUNDLE_FILE_COUNT}`,
		`-DMAX_FILE_BYTES=${MAX_BUNDLE_FILE_BYTES}`,
		`-DMAX_TOTAL_BYTES=${MAX_BUNDLE_AGGREGATE_BYTES}`,
		`-DMAX_PATH_BYTES=${MAX_BUNDLE_PATH_BYTES}`,
		`-DMAX_PATH_COMPONENTS=${MAX_BUNDLE_PATH_COMPONENTS}`,
		"-o", output, source,
	], {
		encoding: "utf8",
		timeout: 30_000,
		maxBuffer: 1024 * 1024,
	});
	if (compiled.status !== 0 || compiled.error || !existsSync(output)) {
		rmSync(directory, { recursive: true, force: true });
		helper = { kind: "unavailable" };
		return helper;
	}
	chmodSync(output, 0o700);
	helper = { kind: "ready", path: output };
	process.once("exit", () => {
		try { rmSync(directory, { recursive: true, force: true }); } catch {}
	});
	return helper;
}

function encodeFiles(files) {
	const count = Buffer.alloc(4);
	count.writeUInt32LE(files.length);
	const chunks = [MAGIC, count];
	for (const file of files) {
		const path = Buffer.from(file.path, "utf8");
		const lengths = Buffer.alloc(8);
		lengths.writeUInt32LE(path.length, 0);
		lengths.writeUInt32LE(file.content.length, 4);
		chunks.push(lengths, path, file.content);
	}
	return Buffer.concat(chunks);
}

function writePosix(outputDir, files, expectedRoot) {
	const prepared = compileHelper();
	if (prepared.kind !== "ready") return "rejected";
	let inputDirectory;
	let inputFd;
	try {
		inputDirectory = mkdtempSync(join(tmpdir(), "pi-cursor-artifact-input-"));
		chmodSync(inputDirectory, 0o700);
		const inputPath = join(inputDirectory, "frame");
		writeFileSync(inputPath, encodeFiles(files), { flag: "wx", mode: 0o600 });
		inputFd = openSync(inputPath, "r");
		unlinkSync(inputPath);
		const result = spawnSync(prepared.path, [outputDir, String(expectedRoot.dev), String(expectedRoot.ino)], {
			stdio: [inputFd, "pipe", "pipe"],
			encoding: "buffer",
			maxBuffer: 1024 * 1024,
		});
		// A signal, spawn error, or unrecognized status reports nothing about created entries.
		return (!result.error && HELPER_EXIT_OUTCOMES.get(result.status)) || "unknown";
	} catch {
		// spawnSync reports helper failures in its result, so only frame staging throws.
		return "rejected";
	} finally {
		try {
			if (inputFd !== undefined) closeSync(inputFd);
		} catch {
			// Continue to remove the private input directory.
		} finally {
			if (inputDirectory) try { rmSync(inputDirectory, { recursive: true, force: true }); } catch {}
		}
	}
}

/** Extracts prevalidated files without permitting a nested host-path swap to redirect writes and
 * returns the extraction outcome:
 * - `committed`: every file was written and verified beneath the pinned root.
 * - `rejected`: refused before any destination entry was created.
 * - `rolled-back`: failed after creating entries and removed every entry it created.
 * - `rollback-incomplete`: failed, and an entry it created could not be confirmed removed.
 * - `unknown`: the native helper ended without reporting, so created entries may remain.
 * Node has no handle-relative Windows creation API, so Windows controllers fail closed before
 * mutating nonempty bundles. Windows remains a supported target of POSIX-hosted release matrices. */
export function writeExtractedFilesAnchored(outputDir, files, expectedRoot) {
	if (process.platform === "win32") return files.length === 0 ? "committed" : "rejected";
	return writePosix(outputDir, files, expectedRoot);
}
