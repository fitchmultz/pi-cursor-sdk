import {
	accessSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync,
	openSync, realpathSync, type Stats,
} from "node:fs";
import { isAbsolute, join, parse, resolve, sep } from "node:path";
import { noFollowFlag, openExistingRegularFileNoFollow, sameFileIdentity } from "./cursor-durable-fs.js";

/** Lexical only: capture selection before acquisition awaits; fileless callers skip it. */
export function normalizeCursorCustomStoreRoot(value: string): string {
	const root = parse(value).root;
	const components = value.slice(root.length).split(process.platform === "win32" ? /[\\/]/ : sep);
	if (!isAbsolute(value) || !root || value.includes("\0") || components.some(part => part === "." || part === "..") ||
		(process.platform === "win32" && (!/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+[\\/]?)$/.test(root) ||
			/^[\\/]{2}[?.][\\/]/.test(value)))) {
		throw new Error("Cursor local storeRoot must be a native fully qualified absolute path without dot components or device prefixes");
	}
	const normalized = resolve(value);
	if (normalized === resolve(root)) throw new Error("Cursor local storeRoot must not be a filesystem or share root");
	return normalized;
}

function invalid(path: string, reason: string): never {
	throw new Error(`Cursor custom local store path ${reason}: ${path}`);
}

function statIfPresent(path: string): Stats | undefined {
	try { return lstatSync(path); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

function assertDirectory(path: string, stat: Stats, privateDirectory: boolean, afterShared: boolean): void {
	if (!stat.isDirectory()) invalid(path, "contains a link or non-directory");
	if (process.platform === "win32") return;
	const uid = process.getuid!();
	if (privateDirectory || afterShared) {
		if (stat.uid !== uid) invalid(path, "is not owned by the current user");
	} else if (stat.uid !== 0 && stat.uid !== uid) invalid(path, "has an untrusted owner");
	const trustedShared = !privateDirectory && !afterShared && stat.uid === 0 && (stat.mode & 0o1000) !== 0;
	if ((stat.mode & 0o022) !== 0 && !trustedShared) invalid(path, "is group or other writable");
	if (privateDirectory && (stat.mode & 0o300) !== 0o300) invalid(path, "is not owner writable/searchable");
}

function restrictPrivateDirectory(path: string, before: Stats): void {
	if (process.platform !== "win32") {
		const fd = openSync(path, constants.O_RDONLY | noFollowFlag());
		try {
			const opened = fstatSync(fd);
			if (!opened.isDirectory() || !sameFileIdentity(before, opened) || !sameFileIdentity(opened, lstatSync(path))) {
				invalid(path, "changed while opening");
			}
			fchmodSync(fd, 0o700);
			const after = lstatSync(path);
			if (!after.isDirectory() || !sameFileIdentity(opened, after)) invalid(path, "changed while restricting permissions");
		} finally { closeSync(fd); }
	}
	accessSync(path, constants.W_OK | constants.X_OK);
}

function assertTrustedSystemTarget(target: string): void {
	let path = parse(target).root;
	for (const part of ["", ...target.slice(path.length).split(sep).filter(Boolean)]) {
		path = join(path, part);
		const stat = lstatSync(path);
		if (!stat.isDirectory() || stat.uid !== 0 || ((stat.mode & 0o022) !== 0 && !(stat.mode & 0o1000))) {
			invalid(path, "has an untrusted system-link target");
		}
	}
}

/** Verify ancestors before individually creating components; never realpath an arbitrary user tree. */
export function prepareCursorCustomStoreRoot(selectedRoot: string): string {
	const normalized = normalizeCursorCustomStoreRoot(selectedRoot);
	let path = parse(normalized).root;
	let afterShared = false;
	const components = normalized.slice(path.length).split(sep).filter(Boolean);
	assertDirectory(path, lstatSync(path), false, false);
	for (const [index, part] of components.entries()) {
		path = join(path, part);
		const leaf = index === components.length - 1;
		let stat = statIfPresent(path);
		if (stat?.isSymbolicLink()) {
			if (process.platform === "win32" || leaf || afterShared || stat.uid !== 0) invalid(path, "contains a link or non-directory");
			const target = realpathSync(path);
			assertTrustedSystemTarget(target);
			path = target;
			stat = lstatSync(path);
		}
		if (!stat) {
			try { mkdirSync(path, { mode: 0o700 }); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
			stat = lstatSync(path);
		}
		assertDirectory(path, stat, leaf, afterShared);
		if (leaf) restrictPrivateDirectory(path, stat);
		if (process.platform !== "win32" && stat.uid === 0 && (stat.mode & 0o022) !== 0) afterShared = true;
	}
	return path;
}

/** Called after exact admission and again immediately before/after the public pathname-based SDK open. */
export function guardCursorCustomStorePath(customRoot: string, stateRoot: string): { verify(): void } {
	if (prepareCursorCustomStoreRoot(customRoot) !== customRoot) invalid(customRoot, "changed canonical identity");
	const directories = [{ path: customRoot, stat: lstatSync(customRoot) }];
	let path = customRoot;
	for (const part of stateRoot.slice(customRoot.length + 1).split(sep)) {
		path = join(path, part);
		if (!statIfPresent(path)) {
			try { mkdirSync(path, { mode: 0o700 }); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
		}
		const stat = lstatSync(path);
		assertDirectory(path, stat, true, true);
		restrictPrivateDirectory(path, stat);
		directories.push({ path, stat });
	}
	const leaves = ["index.db", "index.db-wal", "index.db-shm", "index.db-journal"];
	const originalLeaves = new Map<string, Stats>();
	const checkLeaves = () => {
		for (const name of leaves) {
			const file = join(stateRoot, name);
			const stat = statIfPresent(file);
			if (!stat) {
				if (name === "index.db" && originalLeaves.has(file)) invalid(file, "disappeared SQLite file");
				continue;
			}
			if (!stat.isFile() || stat.nlink !== 1) invalid(file, "contains a linked or nonregular SQLite file");
			if (process.platform !== "win32" && (stat.uid !== process.getuid!() || (stat.mode & 0o022))) {
				invalid(file, "contains an unowned or shared SQLite file");
			}
			const before = originalLeaves.get(file);
			if (before && !sameFileIdentity(before, stat)) invalid(file, "changed SQLite file identity");
			const fd = openExistingRegularFileNoFollow(file, constants.O_RDWR);
			closeSync(fd);
			originalLeaves.set(file, stat);
		}
	};
	checkLeaves();
	// ponytail: the public SDK uses pathname/lazy checkpoint opens. This guards
	// current-user private contents, not hostile same-user/admin races. Windows
	// rejects Node-visible links/junctions but has no ACL hardening/O_NOFOLLOW
	// equivalent here; use an ACL-protected root. Upgrade with public native APIs.
	return { verify() {
		if (prepareCursorCustomStoreRoot(customRoot) !== customRoot) invalid(customRoot, "changed canonical identity");
		for (const { path, stat } of directories) {
			const after = lstatSync(path);
			assertDirectory(path, after, true, true);
			if (!sameFileIdentity(stat, after)) invalid(path, "changed directory identity");
		}
		checkLeaves();
	} };
}
