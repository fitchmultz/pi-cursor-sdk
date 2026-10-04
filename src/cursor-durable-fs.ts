import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function sameFileIdentity(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

export function noFollowFlag(): number {
	return process.platform !== "win32" && typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

export function openExistingRegularFileNoFollow(path: string, flags: number): number {
	const before = lstatSync(path);
	if (!before.isFile()) throw new Error("path is not a regular file");
	let fd: number | undefined;
	try {
		fd = openSync(path, flags | noFollowFlag());
		const opened = fstatSync(fd);
		const after = lstatSync(path);
		if (!opened.isFile() || !after.isFile() || !sameFileIdentity(before, opened) || !sameFileIdentity(opened, after)) {
			throw new Error("path changed while opening regular file");
		}
		return fd;
	} catch (error) {
		if (fd !== undefined) {
			try { closeSync(fd); } catch {}
		}
		throw error;
	}
}

/** Creates a private regular file without replacing or following an existing path. */
export function createRegularFileExclusive(path: string, flags: number, mode: number): number {
	const fd = openSync(path, flags | constants.O_CREAT | constants.O_EXCL | noFollowFlag(), mode);
	try {
		const opened = fstatSync(fd);
		const after = lstatSync(path);
		if (!opened.isFile() || !after.isFile() || !sameFileIdentity(opened, after)) throw new Error("created file changed while opening");
		return fd;
	} catch (error) { closeSync(fd); throw error; }
}

/** Bounded, fail-closed framed journals; an incomplete last frame is not recognized. */
export function readDurableFramePrefix(path: string, maxBytes = 16 * 1024 * 1024): { frames: unknown[]; incompleteTail: boolean } {
	let fd: number;
	try { fd = openExistingRegularFileNoFollow(path, constants.O_RDONLY); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { frames: [], incompleteTail: false }; throw error; }
	try {
		if (fstatSync(fd).size > maxBytes) throw new Error("journal exceeds size limit");
		const buffer = Buffer.alloc(Math.min(fstatSync(fd).size + 1, maxBytes + 1));
		let length = 0;
		while (length < buffer.length) { const count = readSync(fd, buffer, length, buffer.length - length, length); if (!count) break; length += count; }
		if (length === buffer.length) throw new Error("journal changed or exceeds size limit");
		const text = buffer.subarray(0, length).toString("utf8");
		const end = text.lastIndexOf("\n");
		return {
			frames: end < 0 ? [] : text.slice(0, end).split("\n").map(line => JSON.parse(line) as unknown),
			incompleteTail: !!text && !text.endsWith("\n"),
		};
	} finally { closeSync(fd); }
}

export function readDurableFrames(path: string, maxBytes = 16 * 1024 * 1024): unknown[] {
	const result = readDurableFramePrefix(path, maxBytes);
	if (result.incompleteTail) throw new Error("incomplete journal frame");
	return result.frames;
}

export function appendDurableFrame(path: string, data: unknown, validate?: (frames: unknown[]) => void): void {
	// Validate framing and the owner's complete candidate history once, before recognition.
	const frames = readDurableFrames(path);
	validate?.([...frames, data]);
	let created = false;
	let fd: number;
	try { fd = createRegularFileExclusive(path, constants.O_RDWR | constants.O_APPEND, 0o600); created = true; }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		fd = openExistingRegularFileNoFollow(path, constants.O_RDWR | constants.O_APPEND);
	}
	try {
		if (process.platform !== "win32") fchmodSync(fd, 0o600);
		const frame = `${JSON.stringify(data)}\n`;
		if (fstatSync(fd).size + Buffer.byteLength(frame) > 16 * 1024 * 1024) throw new Error("journal exceeds size limit");
		writeFileSync(fd, frame);
		fsyncSync(fd);
		if (created && process.platform !== "win32") {
			const directoryFd = openSync(dirname(path), constants.O_RDONLY);
			try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
		}
	} finally { closeSync(fd); }
}

/** Opens a read-write descriptor (required for Windows FlushFileBuffers) without following a swapped-in symlink. */
export function fsyncExistingRegularFile(path: string): boolean {
	let fd: number | undefined;
	try {
		fd = openExistingRegularFileNoFollow(path, constants.O_RDWR);
		fsyncSync(fd);
		return true;
	} catch {
		return false;
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// fsync already established the durability decision.
			}
		}
	}
}
