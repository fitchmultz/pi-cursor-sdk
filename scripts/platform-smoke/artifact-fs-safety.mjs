/**
 * No-follow filesystem safety primitives shared by artifact scanning, bundling, and extraction:
 * symlink-proof identity tracking, trusted-root traversal, bounded reads, safe extraction
 * writes/cleanup, and the exclusive spill-file writer used when a bundle is too big to inline.
 */

import {
	closeSync, constants, fstatSync, lstatSync, openSync, readSync,
	readdirSync, realpathSync, unlinkSync, writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { MAX_BUNDLE_FILE_BYTES } from "./artifact-bundle-contract.mjs";
import { writeExtractedFilesAnchored } from "./artifact-anchored-extract.mjs";

function sameFileIdentity(left, right) {
	return left.dev === right.dev && left.ino === right.ino;
}

function sameStableFileSnapshot(left, right) {
	return sameFileIdentity(left, right) && left.size === right.size && left.mode === right.mode &&
		left.nlink === right.nlink && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function sameDirectorySnapshot(left, right, immutable) {
	return sameFileIdentity(left, right) && (!immutable || (
		left.ctimeMs === right.ctimeMs && left.mtimeMs === right.mtimeMs && left.size === right.size &&
		left.mode === right.mode && left.nlink === right.nlink
	));
}

export function reverifyDirectory(directory) {
	try {
		const current = lstatSync(directory.path);
		return current.isDirectory() && !current.isSymbolicLink() &&
			sameDirectorySnapshot(directory.stat, current, directory.immutable) &&
			(directory.descriptor === undefined || sameDirectorySnapshot(directory.stat, fstatSync(directory.descriptor), directory.immutable));
	} catch {
		return false;
	}
}

export function reverifyDirectories(directories) {
	return directories.every(reverifyDirectory);
}

export function openRegularFileNoFollow(path, parentDirectories = []) {
	if (!reverifyDirectories(parentDirectories)) throw new Error("parent directory changed before file open");
	const before = lstatSync(path);
	if (!before.isFile() || before.isSymbolicLink()) throw new Error("path is not a regular file");
	if (!reverifyDirectories(parentDirectories)) throw new Error("parent directory changed before file open");
	let descriptor;
	try {
		const noFollow = process.platform !== "win32" && typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
		descriptor = openSync(path, constants.O_RDONLY | noFollow);
		const opened = fstatSync(descriptor);
		const after = lstatSync(path);
		if (!opened.isFile() || !after.isFile() || after.isSymbolicLink() || !sameFileIdentity(before, opened) ||
			!sameFileIdentity(opened, after) || !reverifyDirectories(parentDirectories)) {
			throw new Error("path changed while opening regular file");
		}
		return descriptor;
	} catch (error) {
		if (descriptor !== undefined) {
			try { closeSync(descriptor); } catch {}
		}
		throw error;
	}
}

export function boundedFileSnapshot(path, maxBytes = MAX_BUNDLE_FILE_BYTES, parentDirectories = []) {
	let descriptor;
	let result;
	try {
		descriptor = openRegularFileNoFollow(path, parentDirectories);
		const before = fstatSync(descriptor, { bigint: true });
		if (!before.isFile()) {
			result = { ok: false, reason: "non-regular-entry" };
		} else if (before.size > BigInt(maxBytes)) {
			result = { ok: false, reason: "file-size", size: Number(before.size) };
		} else if (!reverifyDirectories(parentDirectories)) {
			result = { ok: false, reason: "file-changed" };
		} else {
			const content = Buffer.alloc(Number(before.size));
			let offset = 0;
			while (offset < content.length) {
				const bytesRead = readSync(descriptor, content, offset, content.length - offset, null);
				if (bytesRead === 0) break;
				offset += bytesRead;
			}
			const after = fstatSync(descriptor, { bigint: true });
			result = offset === Number(before.size) && sameStableFileSnapshot(before, after) && reverifyDirectories(parentDirectories)
				? { ok: true, content }
				: { ok: false, reason: "file-changed" };
		}
	} catch {
		result = { ok: false, reason: "file-read" };
	}
	if (descriptor !== undefined) {
		try { closeSync(descriptor); } catch { return { ok: false, reason: "file-close" }; }
	}
	return result;
}

/**
 * Open a directory descriptor whose identity is pinned against symlink/rename swaps.
 *
 * `immutable: true` marks a traversal root/ancestor: its full stat snapshot (ctime/mtime/size/
 * mode/nlink) must stay frozen for the life of the walk, so `reverifyDirectory` compares the
 * whole snapshot — used for read-only scanning and bundling.
 * `immutable: false` (default) marks an extraction destination, where only device+inode identity
 * is pinned, since mtime/size legitimately change as files are written into it.
 */
export function openTrustedDirectory(path, { immutable = false, created = false } = {}) {
	const before = lstatSync(path);
	if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("trusted directory target is not a real directory");
	if (process.platform === "win32") {
		const after = lstatSync(path);
		if (!after.isDirectory() || after.isSymbolicLink() || !sameFileIdentity(before, after)) throw new Error("trusted directory target changed");
		return { path, stat: after, immutable, created };
	}
	let descriptor;
	try {
		descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
		const opened = fstatSync(descriptor);
		const after = lstatSync(path);
		if (!opened.isDirectory() || !after.isDirectory() || after.isSymbolicLink() ||
			!sameFileIdentity(before, opened) || !sameFileIdentity(opened, after)) throw new Error("trusted directory target changed");
		return { path, stat: opened, descriptor, immutable, created };
	} catch (error) {
		if (descriptor !== undefined) try { closeSync(descriptor); } catch {}
		throw error;
	}
}

function closeDirectory(directory) {
	if (directory?.descriptor !== undefined) closeSync(directory.descriptor);
}

function samePath(left, right) {
	return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function canonicalTraversalRoot(root) {
	const lexicalRoot = resolve(root);
	const final = lstatSync(lexicalRoot);
	if (!final.isDirectory() || final.isSymbolicLink()) throw new Error("artifact root is not a real directory");
	const actualRoot = realpathSync(lexicalRoot);
	for (const lexicalBase of [resolve(process.cwd()), resolve(tmpdir())]) {
		const rel = relative(lexicalBase, lexicalRoot);
		if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) continue;
		if (samePath(actualRoot, resolve(realpathSync(lexicalBase), rel))) return actualRoot;
	}
	throw new Error("artifact root is outside a trusted canonical base");
}

function isNonArtifactInfrastructureDirectory(name) {
	return /^(?:node_modules|\.git)$/i.test(name);
}

/** Binary-safe, no-follow, symlink-race-proof walk of every file under a trusted root. */
export function walkArtifactTree(root, handlers) {
	let rootDirectory;
	try {
		rootDirectory = openTrustedDirectory(canonicalTraversalRoot(root), { immutable: true });
	} catch {
		handlers.directoryRead(resolve(root), undefined, resolve(root));
		return;
	}
	function report(handler, path) {
		handler(path, undefined, rootDirectory.path);
	}
	function walk(directory, ancestors) {
		const guards = [...ancestors, directory];
		let entries;
		try {
			if (!reverifyDirectories(guards)) throw new Error("artifact directory changed before read");
			entries = readdirSync(directory.path, { withFileTypes: true });
			if (!reverifyDirectories(guards)) throw new Error("artifact directory changed after read");
		} catch {
			report(handlers.directoryRead, directory.path);
			return;
		}
		for (const entry of entries) {
			if (!reverifyDirectories(guards)) {
				report(handlers.directoryRead, directory.path);
				return;
			}
			const path = resolve(directory.path, entry.name);
			let stat;
			try { stat = lstatSync(path); } catch {
				report(handlers.fileRead, path);
				continue;
			}
			if (stat.isDirectory() && !stat.isSymbolicLink()) {
				if (isNonArtifactInfrastructureDirectory(entry.name)) continue;
				let child;
				try {
					child = openTrustedDirectory(path, { immutable: true });
					if (!reverifyDirectories(guards)) throw new Error("artifact ancestor changed");
					walk(child, guards);
				} catch {
					report(handlers.directoryRead, path);
				} finally {
					if (child) try { closeDirectory(child); } catch { report(handlers.directoryRead, path); }
				}
				if (!reverifyDirectories(guards)) {
					report(handlers.directoryRead, directory.path);
					return;
				}
			} else if (stat.isFile() && !stat.isSymbolicLink()) {
				handlers.file(path, guards, rootDirectory.path);
			} else {
				report(handlers.nonRegular, path);
			}
		}
	}
	try { walk(rootDirectory, []); } finally {
		try { closeDirectory(rootDirectory); } catch { report(handlers.directoryRead, rootDirectory.path); }
	}
}

function missingPath(path) {
	try { return { stat: lstatSync(path) }; } catch (error) {
		if (error?.code === "ENOENT") return {};
		throw error;
	}
}

function preflightExtraction(outputDir, files) {
	const root = openTrustedDirectory(resolve(outputDir));
	try {
		const directoryPaths = new Set([root.path]);
		for (const file of files) {
			let path = dirname(resolve(outputDir, file.path));
			while (path !== root.path) {
				directoryPaths.add(path);
				path = dirname(path);
			}
		}
		const paths = [...directoryPaths].sort((left, right) => left.split(/[/\\]/).length - right.split(/[/\\]/).length);
		for (const path of paths) {
			const { stat } = missingPath(path);
			if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error("artifact destination parent is not a real directory");
		}
		for (const file of files) {
			const path = resolve(outputDir, file.path);
			if (missingPath(path).stat) throw new Error("artifact destination already exists");
		}
		return { root };
	} catch (error) {
		if (root.descriptor !== undefined) try { closeSync(root.descriptor); } catch {}
		throw error;
	}
}

/** Write prevalidated `{path, content}` files through descriptor-relative POSIX extraction and return
 * the `writeExtractedFilesAnchored` outcome; a destination that fails preflight is `rejected`.
 * Windows controllers reject nonempty extraction because Node lacks handle-relative creation. */
export function writeExtractedFiles(outputDir, files) {
	let preflight;
	let outcome = "rejected";
	try {
		preflight = preflightExtraction(outputDir, files);
		outcome = writeExtractedFilesAnchored(preflight.root.path, files, preflight.root.stat);
	} catch {}
	if (preflight?.root.descriptor !== undefined) {
		try { closeSync(preflight.root.descriptor); } catch {}
	}
	return outcome;
}

/** Exclusively create `path` (no-follow, fails if it already exists) and write `content` to it,
 * verifying identity before and after the write and unlinking on any failure. */
export function writeBundleSpillFile(path, content) {
	let descriptor;
	let stat;
	let failure;
	try {
		const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
		descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
		stat = fstatSync(descriptor);
		const afterOpen = lstatSync(path);
		if (!stat.isFile() || !afterOpen.isFile() || afterOpen.isSymbolicLink() || !sameFileIdentity(stat, afterOpen)) {
			throw new Error("platform artifact bundle changed while opening");
		}
		let offset = 0;
		while (offset < content.length) {
			const written = writeSync(descriptor, content, offset, content.length - offset);
			if (written < 1) throw new Error("platform artifact bundle write made no progress");
			offset += written;
		}
		const afterWrite = lstatSync(path);
		if (!afterWrite.isFile() || afterWrite.isSymbolicLink() || !sameFileIdentity(stat, fstatSync(descriptor)) || !sameFileIdentity(stat, afterWrite)) {
			throw new Error("platform artifact bundle changed while writing");
		}
	} catch (error) {
		failure = error;
	}
	if (descriptor !== undefined) {
		try { closeSync(descriptor); } catch (error) { failure ??= error; }
	}
	if (failure) {
		if (stat) {
			try {
				const current = lstatSync(path);
				if (current.isFile() && !current.isSymbolicLink() && sameFileIdentity(stat, current)) unlinkSync(path);
			} catch {}
		}
		throw failure;
	}
}
