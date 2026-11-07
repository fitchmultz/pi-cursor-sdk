import { Console } from "node:console";

export function collectOutput(backpressure = false) {
	const originals = { stdout: process.stdout.write, stderr: process.stderr.write };
	const originalConsole = globalThis.console;
	globalThis.console = new Console({ stdout: process.stdout, stderr: process.stderr, colorMode: false });
	const stdout: Buffer[] = [], stderr: Buffer[] = [];
	for (const [stream, chunks] of [[process.stdout, stdout], [process.stderr, stderr]] as const) {
		stream.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
			chunks.push(typeof chunk === "string" ? Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8") : Buffer.from(chunk));
			(typeof encoding === "function" ? encoding : callback)?.();
			return !backpressure;
		}) as typeof stream.write;
	}
	return { stdout, stderr, restore() { process.stdout.write = originals.stdout; process.stderr.write = originals.stderr; globalThis.console = originalConsole; } };
}
