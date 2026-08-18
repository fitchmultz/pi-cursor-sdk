import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { isUnauthenticatedConnectError } from "../src/cursor-provider-errors.js";
import { makeNodeClosedPipeWriteError } from "./helpers/cursor-sdk-process-error-fixtures.js";
import {
	__testUtils,
	installCursorSdkProcessErrorGuard,
	installCursorSdkSessionProcessErrorGuard,
	isCursorSdkAbortConnectError,
	registerCursorSdkSessionProcessErrorGuard,
} from "../src/cursor-sdk-process-error-guard.js";

function makeCursorSdkAbortConnectError(): Error & { rawMessage: string; code: number; cause: DOMException } {
	const error = new Error("[canceled] This operation was aborted") as Error & {
		rawMessage: string;
		code: number;
		cause: DOMException;
	};
	error.name = "ConnectError";
	error.rawMessage = "This operation was aborted";
	error.code = 1;
	error.cause = new DOMException("This operation was aborted", "AbortError");
	error.stack =
		"ConnectError: [canceled] This operation was aborted\n" +
		"    at file:///repo/node_modules/@connectrpc/connect-node/dist/esm/node-universal-client.js:293:63\n" +
		"    at file:///repo/node_modules/@cursor/sdk/dist/esm/index.js:8:1086456\n" +
		"Caused by: AbortError";
	return error;
}

const bunAvailable = spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0;
const bunIt = bunAvailable ? it : it.skip;
const posixIt = process.platform === "win32" ? it.skip : it;

const guardUrl = pathToFileURL(resolve("src/cursor-sdk-process-error-guard.ts")).href;
const nodeTypeScriptImportHook = `data:text/javascript,${encodeURIComponent(`
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.endsWith(".js") && context.parentURL?.startsWith("file:")) {
			const sourceUrl = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
			if (existsSync(fileURLToPath(sourceUrl))) return nextResolve(sourceUrl.href, context);
		}
		return nextResolve(specifier, context);
	},
});
`)}`;

function runNodeProcessErrorProbe(body: string) {
	return spawnSync(
		process.execPath,
		[
			"--import",
			nodeTypeScriptImportHook,
			"--input-type=module",
			"--eval",
			`import { installCursorSdkProcessErrorGuard, installCursorSdkSessionProcessErrorGuard } from ${JSON.stringify(guardUrl)};\n${body}`,
		],
		{ encoding: "utf8", timeout: 10_000 },
	);
}

// Reproduces the observed fatal shape: the SDK's spawned child exits while a large
// stdin write is in flight, so Node emits a raw EPIPE 'error' with no listener.
const realClosedPipeStdinWriteBody = `
const { spawn } = await import("node:child_process");
const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: ["pipe", "ignore", "ignore"] });
child.stdin.write("x".repeat(1 << 22));
`;

function runBunProcessErrorProbe(body: string) {
	return spawnSync(
		"bun",
		[
			"--eval",
			`import { installCursorSdkProcessErrorGuard, installCursorSdkSessionProcessErrorGuard } from ${JSON.stringify(guardUrl)};\n${body}`,
		],
		{ encoding: "utf8", timeout: 10_000 },
	);
}

function makeCursorSdkWriteIterableClosedError(): Error {
	const error = new Error("WritableIterable is closed");
	error.name = "WriteIterableClosedError";
	error.stack =
		"WriteIterableClosedError: WritableIterable is closed\n" +
		"    at write (/repo/node_modules/@cursor/sdk/dist/esm/index.js:1:3188743)\n" +
		"    at <anonymous> (/repo/node_modules/@cursor/sdk/dist/esm/357.js:1:101697)";
	return error;
}

function makeCursorSdkUnauthenticatedConnectError(): Error & { rawMessage: string; code: number } {
	const error = new Error("[unauthenticated] Error") as Error & { rawMessage: string; code: number };
	error.name = "ConnectError";
	error.rawMessage = "Error";
	error.code = 16;
	error.stack =
		"ConnectError: [unauthenticated] Error\n" +
		"    at file:///repo/node_modules/@connectrpc/connect/dist/esm/protocol-connect/error-json.js:53:19\n" +
		"    at file:///repo/node_modules/@cursor/sdk/dist/esm/index.js:8:1086456";
	return error;
}

function makeCursorBackendUnauthenticatedConnectError(): Error & { rawMessage: string; code: number; details: Array<{ type: string }> } {
	const error = makeCursorSdkUnauthenticatedConnectError() as Error & {
		rawMessage: string;
		code: number;
		details: Array<{ type: string }>;
	};
	error.stack =
		"ConnectError: [unauthenticated] Error\n" +
		"    at file:///repo/node_modules/@connectrpc/connect/dist/esm/protocol-connect/error-json.js:53:19";
	error.details = [{ type: "aiserver.v1.ErrorDetails" }];
	return error;
}

function makeNonCursorUnauthenticatedConnectError(): Error & { rawMessage: string; code: number } {
	const error = makeCursorSdkUnauthenticatedConnectError();
	error.stack =
		"ConnectError: [unauthenticated] Error\n" +
		"    at file:///repo/node_modules/@connectrpc/connect/dist/esm/protocol-connect/error-json.js:53:19";
	return error;
}

function makeCursorSdkNetworkConnectError(): Error & { rawMessage: string; code: number; cause: NodeJS.ErrnoException } {
	const error = new Error("[aborted] read ECONNRESET") as Error & {
		rawMessage: string;
		code: number;
		cause: NodeJS.ErrnoException;
	};
	error.name = "ConnectError";
	error.rawMessage = "read ECONNRESET";
	error.code = 10;
	error.cause = Object.assign(new Error("read ECONNRESET"), {
		code: "ECONNRESET",
		syscall: "read",
	});
	error.stack =
		"ConnectError: [aborted] read ECONNRESET\n" +
		"    at file:///repo/node_modules/@connectrpc/connect-node/dist/esm/node-universal-client.js:293:63\n" +
		"    at file:///repo/node_modules/@cursor/sdk/dist/esm/index.js:8:1086456";
	return error;
}

function makeCursorSdkHttp2EnhanceYourCalmConnectError(): Error & {
	rawMessage: string;
	code: number;
	cause: Error & { rawMessage: string; code: string };
} {
	const error = new Error("[internal] Stream closed with error code NGHTTP2_ENHANCE_YOUR_CALM") as Error & {
		rawMessage: string;
		code: number;
		cause: Error & { rawMessage: string; code: string };
	};
	error.name = "ConnectError";
	error.rawMessage = "Stream closed with error code NGHTTP2_ENHANCE_YOUR_CALM";
	error.code = 2;
	error.cause = Object.assign(new Error("stream closed with error code NGHTTP2_ENHANCE_YOUR_CALM"), {
		rawMessage: "stream closed with error code NGHTTP2_ENHANCE_YOUR_CALM",
		code: "ERR_HTTP2_STREAM_ERROR",
	});
	error.stack =
		"ConnectError: [internal] Stream closed with error code NGHTTP2_ENHANCE_YOUR_CALM\n" +
		"    at file:///repo/node_modules/@connectrpc/connect/dist/esm/connect-error.js:71:20\n" +
		"    at file:///repo/node_modules/@cursor/sdk/dist/esm/index.js:8:1086456";
	return error;
}

function makeCursorSdkStallAbortWrapperConnectError(): Error & { rawMessage: string; code: number; cause: Error } {
	const cause = Object.assign(new Error("[canceled] This operation was aborted"), {
		name: "ConnectError",
		rawMessage: "This operation was aborted",
		code: 1,
		cause: new DOMException("This operation was aborted", "AbortError"),
	});
	cause.stack =
		"ConnectError: [canceled] This operation was aborted\n" +
		"    at ConnectError.from (file:///repo/node_modules/@connectrpc/connect/dist/esm/connect-error.js:69:24)\n" +
		"    at connectErrorFromNodeReason (file:///repo/node_modules/@connectrpc/connect-node/dist/esm/node-error.js:52:29)\n" +
		"    at Object.reject (file:///repo/node_modules/@connectrpc/connect-node/dist/esm/node-universal-client.js:293:63)\n" +
		"    at AbortSignal.r (file:///repo/node_modules/@cursor/sdk/dist/esm/996.js:1:5705)\n" +
		"    at Y.onStall (file:///repo/node_modules/@cursor/sdk/dist/esm/357.js:1:75246)";
	const error = new Error("[unknown] [canceled] This operation was aborted") as Error & {
		rawMessage: string;
		code: number;
		cause: Error;
	};
	error.name = "ConnectError";
	error.rawMessage = "[canceled] This operation was aborted";
	error.code = 2;
	error.cause = cause;
	error.stack =
		"ConnectError: [unknown] [canceled] This operation was aborted\n" +
		"    at a.from (file:///repo/node_modules/@cursor/sdk/dist/esm/index.js:1:1125976)\n" +
		"    at file:///repo/node_modules/@cursor/sdk/dist/esm/996.js:1:5832";
	return error;
}

function makeCursorExtensionNetworkConnectError(): Error & { rawMessage: string; code: number; cause: NodeJS.ErrnoException } {
	const error = makeCursorSdkNetworkConnectError();
	error.stack =
		"ConnectError: [aborted] read ECONNRESET\n" +
		"    at file:///C:/Users/example/.pi/agent/git/github.com/fitchmultz/pi-cursor-sdk/node_modules/@connectrpc/connect-node/dist/esm/node-universal-client.js:293:63";
	return error;
}

function makeCursorBackendNetworkConnectError(): Error & {
	rawMessage: string;
	code: number;
	cause: NodeJS.ErrnoException;
	details: Array<{ type: string }>;
} {
	const error = makeCursorSdkNetworkConnectError() as Error & {
		rawMessage: string;
		code: number;
		cause: NodeJS.ErrnoException;
		details: Array<{ type: string }>;
	};
	error.stack =
		"ConnectError: [aborted] read ECONNRESET\n" +
		"    at file:///repo/node_modules/@connectrpc/connect-node/dist/esm/node-universal-client.js:293:63";
	error.details = [{ type: "aiserver.v1.ErrorDetails" }];
	return error;
}

function makeCursorBackendUnavailableConnectError(): Error & {
	rawMessage: string;
	code: number;
	details: Array<{ type: string }>;
} {
	const error = new Error("[unavailable] Error") as Error & {
		rawMessage: string;
		code: number;
		details: Array<{ type: string }>;
	};
	error.name = "ConnectError";
	error.rawMessage = "Error";
	error.code = 14;
	error.stack =
		"ConnectError: [unavailable] Error\n" +
		"    at file:///repo/node_modules/@connectrpc/connect/dist/esm/protocol-connect/error-json.js:53:19";
	error.details = [{ type: "aiserver.v1.ErrorDetails" }];
	return error;
}

function makeGenericConnectNodeNetworkConnectError(): Error & { rawMessage: string; code: number; cause: NodeJS.ErrnoException } {
	const error = makeCursorSdkNetworkConnectError();
	error.stack =
		"ConnectError: [aborted] read ECONNRESET\n" +
		"    at file:///repo/node_modules/@connectrpc/connect-node/dist/esm/node-universal-client.js:293:63";
	return error;
}

function makeProvenanceFreeNetworkConnectError(): Error & { rawMessage: string; code: number; cause: NodeJS.ErrnoException } {
	const error = makeCursorSdkNetworkConnectError();
	error.stack =
		"ConnectError: [aborted] read ECONNRESET\n" +
		"    at file:///repo/node_modules/some-other-connect-client/index.js:10:1";
	return error;
}

describe("Cursor SDK process error guard", () => {
	it("registers an idempotent session lifecycle guard", () => {
		const handlers = new Map<string, () => void>();
		registerCursorSdkSessionProcessErrorGuard({
			on: ((event: string, handler: () => void) => handlers.set(event, handler)) as never,
		});
		const originalEmit = process.emit;

		handlers.get("session_start")?.();
		expect(__testUtils.activeSessionCount()).toBe(1);
		expect(process.emit).not.toBe(originalEmit);
		handlers.get("session_start")?.();
		expect(__testUtils.activeSessionCount()).toBe(1);
		handlers.get("session_shutdown")?.();
		expect(__testUtils.activeSessionCount()).toBe(0);
		expect(process.emit).toBe(originalEmit);
		handlers.get("session_shutdown")?.();
		expect(__testUtils.activeSessionCount()).toBe(0);
	});

	it("restores process hooks across repeated session guard cycles", () => {
		const originalEmit = process.emit;
		const originalUnhandledRejectionListeners = process.rawListeners("unhandledRejection");
		const hadCaptureCallback = process.hasUncaughtExceptionCaptureCallback();
		for (let cycle = 0; cycle < 3; cycle += 1) {
			const guard = installCursorSdkSessionProcessErrorGuard();
			expect(process.emit).not.toBe(originalEmit);
			guard.dispose();
			expect(process.emit).toBe(originalEmit);
			expect(process.rawListeners("unhandledRejection")).toEqual(originalUnhandledRejectionListeners);
			expect(process.hasUncaughtExceptionCaptureCallback()).toBe(hadCaptureCallback);
		}
	});

	it("preserves a pre-existing uncaught-exception capture callback", () => {
		expect(process.hasUncaughtExceptionCaptureCallback()).toBe(false);
		process.setUncaughtExceptionCaptureCallback(() => {});
		try {
			const guard = installCursorSdkSessionProcessErrorGuard();
			guard.dispose();
			expect(process.hasUncaughtExceptionCaptureCallback()).toBe(true);
		} finally {
			process.setUncaughtExceptionCaptureCallback(null);
		}
	});

	it("lets a later component own and clear the uncaught-exception capture callback", () => {
		expect(process.hasUncaughtExceptionCaptureCallback()).toBe(false);
		const guard = installCursorSdkSessionProcessErrorGuard();
		try {
			process.setUncaughtExceptionCaptureCallback(() => {});
			expect(process.hasUncaughtExceptionCaptureCallback()).toBe(true);
			process.setUncaughtExceptionCaptureCallback(null);
			expect(process.hasUncaughtExceptionCaptureCallback()).toBe(false);
		} finally {
			if (process.hasUncaughtExceptionCaptureCallback()) process.setUncaughtExceptionCaptureCallback(null);
			guard.dispose();
		}
	});

	it("preserves later process.emit wrappers until their owner releases them", () => {
		const originalEmit = process.emit;
		const sessionGuard = installCursorSdkSessionProcessErrorGuard();
		const turnGuard = installCursorSdkProcessErrorGuard();
		const cursorEmit = process.emit;
		let laterPatchCalls = 0;
		const laterPatch = function(this: NodeJS.Process, event: string | symbol, ...args: unknown[]): boolean {
			laterPatchCalls += 1;
			return (cursorEmit as (event: string | symbol, ...args: unknown[]) => boolean).call(this, event, ...args);
		};
		let nextSessionGuard: ReturnType<typeof installCursorSdkSessionProcessErrorGuard> | undefined;
		try {
			process.emit = laterPatch as typeof process.emit;
			turnGuard.dispose();
			sessionGuard.dispose();
			expect(process.emit).toBe(laterPatch);

			const callsBeforeEvent = laterPatchCalls;
			process.emit("cursor-sdk-emit-interoperability" as never);
			expect(laterPatchCalls).toBe(callsBeforeEvent + 1);

			process.emit = cursorEmit;
			nextSessionGuard = installCursorSdkSessionProcessErrorGuard();
			nextSessionGuard.dispose();
			expect(process.emit).toBe(originalEmit);
		} finally {
			nextSessionGuard?.dispose();
			turnGuard.dispose();
			sessionGuard.dispose();
			if (process.emit !== originalEmit) {
				process.emit = cursorEmit;
				const cleanupGuard = installCursorSdkSessionProcessErrorGuard();
				cleanupGuard.dispose();
			}
			process.emit = originalEmit;
		}
	});

	it("tracks the installed Cursor SDK closed-writable error contract", () => {
		const controlledExecBundle = readFileSync("node_modules/@cursor/sdk/dist/esm/357.js", "utf8");
		expect(controlledExecBundle).toContain('this.name="WriteIterableClosedError"');
		expect(controlledExecBundle).toContain('"WritableIterable is closed"');
		expect(controlledExecBundle).toContain('SimpleControlledExecManager');
		expect(controlledExecBundle).toContain('catch(e){if(e instanceof i.W2)return;');
		expect(controlledExecBundle).toContain('yield l.write(new s.$Y({message:{case:"throw"');
	});

	it("contains delayed exact SDK failures after the provider-turn guard is disposed in real Node", () => {
		const result = runNodeProcessErrorProbe(`
const sessionGuard = installCursorSdkSessionProcessErrorGuard();
const turnGuard = installCursorSdkProcessErrorGuard();
turnGuard.dispose();
function exactError() {
	const error = new Error("WritableIterable is closed");
	error.name = "WriteIterableClosedError";
	error.stack = "WriteIterableClosedError: WritableIterable is closed\\n    at write (/repo/node_modules/@cursor/sdk/dist/esm/index.js:1:1)";
	return error;
}
setTimeout(() => Promise.reject(exactError()), 10);
setTimeout(() => { throw exactError(); }, 20);
setTimeout(() => {
	console.log("survived delayed SDK failures");
	sessionGuard.dispose();
}, 40);
`);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("survived delayed SDK failures");
	});

	it.each([
		[
			"closed-writable lookalike without Cursor SDK provenance",
			`const error = new Error("WritableIterable is closed");
error.name = "WriteIterableClosedError";
error.stack = "WriteIterableClosedError: WritableIterable is closed\\n    at write (/repo/src/stream.js:1:1)";
Promise.reject(error);`,
			"WritableIterable is closed",
		],
		["unrelated rejection", `Promise.reject(new Error("unrelated delayed failure"));`, "unrelated delayed failure"],
	])("keeps delayed %s fatal in real Node", (_name, rejection, expectedError) => {
		const result = runNodeProcessErrorProbe(`
const sessionGuard = installCursorSdkSessionProcessErrorGuard();
const turnGuard = installCursorSdkProcessErrorGuard();
turnGuard.dispose();
setTimeout(() => { ${rejection} }, 10);
setTimeout(() => {
	console.log("SURVIVED_UNEXPECTEDLY");
	sessionGuard.dispose();
}, 40);
`);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain(expectedError);
		expect(result.stdout).not.toContain("SURVIVED_UNEXPECTEDLY");
	});

	bunIt("suppresses the observed closed-writable rejection under Bun", () => {
		const result = runBunProcessErrorProbe(`
installCursorSdkSessionProcessErrorGuard();
const error = new Error("WritableIterable is closed");
error.name = "WriteIterableClosedError";
error.stack = "WriteIterableClosedError: WritableIterable is closed\\n    at write (/repo/node_modules/@cursor/sdk/dist/esm/index.js:1:1)";
Promise.reject(error);
setTimeout(() => console.log("survived"), 20);
`);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("survived");
	});

	bunIt("keeps unrelated Bun rejections fatal after a prior listener is removed", () => {
		const result = runBunProcessErrorProbe(`
const priorListener = () => {};
process.on("unhandledRejection", priorListener);
installCursorSdkProcessErrorGuard();
process.off("unhandledRejection", priorListener);
Promise.reject(new Error("unrelated listener-removal failure"));
setTimeout(() => console.log("SURVIVED_UNEXPECTEDLY"), 20);
`);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("unrelated listener-removal failure");
		expect(result.stdout).not.toContain("SURVIVED_UNEXPECTEDLY");
	});

	bunIt("preserves a pre-existing Bun once rejection listener", () => {
		const result = runBunProcessErrorProbe(`
process.once("unhandledRejection", (error) => console.log("handled: " + error.message));
installCursorSdkProcessErrorGuard();
Promise.reject(new Error("owned by prior once listener"));
setTimeout(() => console.log("survived"), 20);
`);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("handled: owned by prior once listener");
		expect(result.stdout).toContain("survived");
	});

	it("suppresses the exact closed-writable error for the session after the provider turn ends", () => {
		const sessionGuard = installCursorSdkSessionProcessErrorGuard();
		const turnGuard = installCursorSdkProcessErrorGuard();
		turnGuard.dispose();
		let listenerCalled = false;
		const listener = () => {
			listenerCalled = true;
		};
		process.once("unhandledRejection", listener);
		try {
			const emitted = process.emit("unhandledRejection", makeCursorSdkWriteIterableClosedError(), Promise.resolve());
			expect(emitted).toBe(true);
			expect(listenerCalled).toBe(false);
		} finally {
			process.removeListener("unhandledRejection", listener);
			sessionGuard.dispose();
		}
	});

	it("does not suppress a closed-writable lookalike without a Cursor SDK stack", () => {
		const suppression = installCursorSdkSessionProcessErrorGuard();
		const error = makeCursorSdkWriteIterableClosedError();
		error.stack = "WriteIterableClosedError: WritableIterable is closed\n    at write (/repo/src/stream.ts:1:1)";
		let listenerCalled = false;
		const listener = () => {
			listenerCalled = true;
		};
		process.once("uncaughtException", listener);
		try {
			const emitted = process.emit("uncaughtException", error, "uncaughtException");
			expect(emitted).toBe(true);
			expect(listenerCalled).toBe(true);
		} finally {
			process.removeListener("uncaughtException", listener);
			suppression.dispose();
		}
	});

	it("suppresses the exact observed closed-pipe EPIPE and invalidates while a contained local turn is active", () => {
		const onClosedPipe = vi.fn();
		const turnGuard = installCursorSdkProcessErrorGuard();
		turnGuard.containLocalTransportClosedPipe(onClosedPipe);
		let listenerCalled = false;
		const listener = () => {
			listenerCalled = true;
		};
		process.once("uncaughtException", listener);
		try {
			const emitted = process.emit("uncaughtException", makeNodeClosedPipeWriteError(), "uncaughtException");
			expect(emitted).toBe(true);
			expect(listenerCalled).toBe(false);
			expect(onClosedPipe).toHaveBeenCalledTimes(1);
		} finally {
			process.removeListener("uncaughtException", listener);
			turnGuard.dispose();
		}
	});

	it("does not suppress the exact EPIPE when only session and uncontained turn guards are active", () => {
		const sessionGuard = installCursorSdkSessionProcessErrorGuard();
		const turnGuard = installCursorSdkProcessErrorGuard();
		let listenerCalled = false;
		const listener = () => {
			listenerCalled = true;
		};
		process.once("uncaughtException", listener);
		try {
			const emitted = process.emit("uncaughtException", makeNodeClosedPipeWriteError(), "uncaughtException");
			expect(emitted).toBe(true);
			expect(listenerCalled).toBe(true);
		} finally {
			process.removeListener("uncaughtException", listener);
			turnGuard.dispose();
			sessionGuard.dispose();
		}
	});

	it("does not suppress the exact EPIPE after the contained turn guard is disposed", () => {
		const onClosedPipe = vi.fn();
		const turnGuard = installCursorSdkProcessErrorGuard();
		turnGuard.containLocalTransportClosedPipe(onClosedPipe);
		turnGuard.dispose();
		let listenerCalled = false;
		const listener = () => {
			listenerCalled = true;
		};
		process.once("uncaughtException", listener);
		try {
			const emitted = process.emit("uncaughtException", makeNodeClosedPipeWriteError(), "uncaughtException");
			expect(emitted).toBe(true);
			expect(listenerCalled).toBe(true);
			expect(onClosedPipe).not.toHaveBeenCalled();
		} finally {
			process.removeListener("uncaughtException", listener);
		}
	});

	it.each([
		[
			"application stack frame",
			(error: Error & NodeJS.ErrnoException) => {
				error.stack = "Error: write EPIPE\n    at flush (/repo/src/stream.ts:10:5)";
			},
		],
		[
			"multi-frame synchronous write-dispatch stack (piped stdout / dead terminal)",
			(error: Error & NodeJS.ErrnoException) => {
				error.stack =
					"Error: write EPIPE\n" +
					"    at afterWriteDispatched (node:internal/stream_base_commons:159:15)\n" +
					"    at writeGeneric (node:internal/stream_base_commons:150:3)\n" +
					"    at Socket._writeGeneric (node:net:1026:11)\n" +
					"    at Socket._write (node:net:1038:8)";
			},
		],
		[
			"single node-internal frame that is not the observed completion frame",
			(error: Error & NodeJS.ErrnoException) => {
				error.stack = "Error: write EPIPE\n    at afterWriteDispatched (node:internal/stream_base_commons:159:15)";
			},
		],
		[
			"read syscall",
			(error: Error & NodeJS.ErrnoException) => {
				error.syscall = "read";
			},
		],
		[
			"non-EPIPE code",
			(error: Error & NodeJS.ErrnoException) => {
				error.code = "ECONNRESET";
			},
		],
	])("does not suppress an EPIPE lookalike with %s during a contained local turn", (_name, mutate) => {
		const onClosedPipe = vi.fn();
		const turnGuard = installCursorSdkProcessErrorGuard();
		turnGuard.containLocalTransportClosedPipe(onClosedPipe);
		const error = makeNodeClosedPipeWriteError();
		mutate(error);
		let listenerCalled = false;
		const listener = () => {
			listenerCalled = true;
		};
		process.once("uncaughtException", listener);
		try {
			const emitted = process.emit("uncaughtException", error, "uncaughtException");
			expect(emitted).toBe(true);
			expect(listenerCalled).toBe(true);
			expect(onClosedPipe).not.toHaveBeenCalled();
		} finally {
			process.removeListener("uncaughtException", listener);
			turnGuard.dispose();
		}
	});

	posixIt("contains a real closed-pipe stdin EPIPE while a contained local turn is active in real Node", () => {
		const result = runNodeProcessErrorProbe(`
let invalidated = false;
const turnGuard = installCursorSdkProcessErrorGuard();
turnGuard.containLocalTransportClosedPipe(() => {
	invalidated = true;
});
${realClosedPipeStdinWriteBody}
const timer = setInterval(() => {
	if (!invalidated) return;
	clearInterval(timer);
	console.log("survived real closed-pipe EPIPE and invalidated transport");
	turnGuard.dispose();
}, 25);
`);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("survived real closed-pipe EPIPE and invalidated transport");
	});

	it("keeps a real closed-pipe stdin EPIPE fatal when no contained local turn is active in real Node", () => {
		const result = runNodeProcessErrorProbe(`
const sessionGuard = installCursorSdkSessionProcessErrorGuard();
const turnGuard = installCursorSdkProcessErrorGuard();
${realClosedPipeStdinWriteBody}
setTimeout(() => {
	console.log("SURVIVED_UNEXPECTEDLY");
	turnGuard.dispose();
	sessionGuard.dispose();
}, 2000);
`);
		expect(result.status).not.toBe(0);
		// Windows reports the same closed child-stdin write as EOF rather than EPIPE.
		expect(result.stderr).toMatch(/EPIPE|EOF/);
		expect(result.stdout).not.toContain("SURVIVED_UNEXPECTEDLY");
	});

	it("keeps piped-stdout EPIPE fatal even during a contained local turn in real Node", () => {
		// Reproduces `pi --print | early-exiting-consumer`: pi must still die per Unix
		// convention while a local Cursor turn guard with containment is active.
		const producerBody =
			`import { installCursorSdkProcessErrorGuard } from ${JSON.stringify(guardUrl)};\n` +
			`const turnGuard = installCursorSdkProcessErrorGuard();\n` +
			`turnGuard.containLocalTransportClosedPipe(() => {});\n` +
			`const big = "y".repeat(1 << 16);\n` +
			`setInterval(() => { process.stdout.write(big); }, 2);\n` +
			`setTimeout(() => { process.stderr.write("SURVIVED_UNEXPECTEDLY"); process.exit(0); }, 4000);\n`;
		const result = spawnSync(
			"bash",
			[
				"-c",
				'set -o pipefail; "$NODE_BIN" --import "$TS_HOOK" --input-type=module --eval "$PRODUCER_BODY" | "$NODE_BIN" -e "process.exit(0)"',
			],
			{
				encoding: "utf8",
				timeout: 20_000,
				env: {
					...process.env,
					NODE_BIN: process.execPath,
					TS_HOOK: nodeTypeScriptImportHook,
					PRODUCER_BODY: producerBody,
				},
			},
		);
		expect(result.status).not.toBe(0);
		// A pathological in-flight first write can be contained (identical async shape),
		// but the very next stdout write must still kill the process.
		expect(result.stderr).toMatch(/EPIPE|ERR_STREAM_DESTROYED/);
		expect(result.stderr).not.toContain("SURVIVED_UNEXPECTEDLY");
	});

	it("tracks the installed Cursor SDK local-executor stdin write contract", () => {
		// 1.0.27 attaches a no-op error listener before local shell snapshot writes.
		// Command-hook stdin still uses callback-style write; MCP stdio has its own listener.
		const shellExecBundle = readFileSync("node_modules/@cursor/sdk/dist/esm/357.js", "utf8");
		expect(shellExecBundle).toContain("writeCommandHookStdinPayload");
		expect(shellExecBundle).toContain("stdin.write(e,(e=>{e?n(e):t(void 0)}))");
		expect(shellExecBundle).toContain("o.stdin.write(`${t.join(\"\\n\")}\\n`),o.stdin.end()");
		expect(shellExecBundle).toContain('function Be(e){e?.on("error",(()=>{}))}function ze(e,t){e&&(Be(e),e.write(t),e.end())}');
		const mcpStdioBundle = readFileSync("node_modules/@cursor/sdk/dist/esm/318.js", "utf8");
		expect(mcpStdioBundle).toContain('stdin?.on("error"');
	});

	it("matches local Cursor SDK abort ConnectError shape", () => {
		expect(isCursorSdkAbortConnectError(makeCursorSdkAbortConnectError())).toBe(true);
		expect(isCursorSdkAbortConnectError(makeCursorSdkStallAbortWrapperConnectError())).toBe(false);
		expect(isCursorSdkAbortConnectError(new Error("boom"))).toBe(false);
	});

	it("matches Cursor SDK unauthenticated ConnectError shape", () => {
		expect(isUnauthenticatedConnectError(makeCursorSdkUnauthenticatedConnectError())).toBe(true);
		expect(isUnauthenticatedConnectError(new Error("boom"))).toBe(false);
	});

	it("suppresses matching uncaught exceptions only after abort suppression is enabled", () => {
		const suppression = installCursorSdkProcessErrorGuard();
		let listenerCalled = false;
		const listener = () => {
			listenerCalled = true;
		};
		process.once("uncaughtException", listener);
		try {
			const unsuppressed = process.emit("uncaughtException", makeCursorSdkAbortConnectError(), "uncaughtException");
			expect(unsuppressed).toBe(true);
			expect(listenerCalled).toBe(true);
		} finally {
			process.removeListener("uncaughtException", listener);
		}

		listenerCalled = false;
		process.once("uncaughtException", listener);
		try {
			suppression.suppressAbortErrors();
			const emitted = process.emit("uncaughtException", makeCursorSdkAbortConnectError(), "uncaughtException");
			expect(emitted).toBe(true);
			expect(listenerCalled).toBe(false);
		} finally {
			process.removeListener("uncaughtException", listener);
			suppression.dispose();
		}
	});

	it.each([
		["Cursor SDK stack", makeCursorSdkUnauthenticatedConnectError],
		["Cursor backend details", makeCursorBackendUnauthenticatedConnectError],
	])("suppresses Cursor unauthenticated process errors with %s while a provider turn is active", (_name, makeError) => {
		const suppression = installCursorSdkProcessErrorGuard();
		let listenerCalled = false;
		const listener = () => {
			listenerCalled = true;
		};
		process.once("uncaughtException", listener);
		try {
			const emitted = process.emit("uncaughtException", makeError(), "uncaughtException");
			expect(emitted).toBe(true);
			expect(listenerCalled).toBe(false);
		} finally {
			process.removeListener("uncaughtException", listener);
			suppression.dispose();
		}
	});

	it("does not suppress non-Cursor unauthenticated ConnectErrors", () => {
		const suppression = installCursorSdkProcessErrorGuard();
		let listenerCalled = false;
		const listener = () => {
			listenerCalled = true;
		};
		process.once("uncaughtException", listener);
		try {
			const emitted = process.emit("uncaughtException", makeNonCursorUnauthenticatedConnectError(), "uncaughtException");
			expect(emitted).toBe(true);
			expect(listenerCalled).toBe(true);
		} finally {
			process.removeListener("uncaughtException", listener);
			suppression.dispose();
		}
	});

	it.each([
		["Cursor SDK stack", makeCursorSdkNetworkConnectError],
		["extension-local connect-node stack", makeCursorExtensionNetworkConnectError],
		["Cursor backend details", makeCursorBackendNetworkConnectError],
		["Cursor backend unavailable details", makeCursorBackendUnavailableConnectError],
	])("suppresses Cursor network process errors with %s while a provider turn is active", (_name, makeError) => {
		const suppression = installCursorSdkProcessErrorGuard();
		let listenerCalled = false;
		const listener = () => {
			listenerCalled = true;
		};
		process.once("uncaughtException", listener);
		try {
			const emitted = process.emit("uncaughtException", makeError(), "uncaughtException");
			expect(emitted).toBe(true);
			expect(listenerCalled).toBe(false);
		} finally {
			process.removeListener("uncaughtException", listener);
			suppression.dispose();
		}
	});

	it("suppresses Cursor SDK HTTP/2 stream reset process errors while a provider turn is active", () => {
		const suppression = installCursorSdkProcessErrorGuard();
		let listenerCalled = false;
		const listener = () => {
			listenerCalled = true;
		};
		process.once("uncaughtException", listener);
		try {
			const emitted = process.emit(
				"uncaughtException",
				makeCursorSdkHttp2EnhanceYourCalmConnectError(),
				"uncaughtException",
			);
			expect(emitted).toBe(true);
			expect(listenerCalled).toBe(false);
		} finally {
			process.removeListener("uncaughtException", listener);
			suppression.dispose();
		}
	});

	it("suppresses Cursor SDK stall abort wrappers while a provider turn is active", () => {
		const suppression = installCursorSdkProcessErrorGuard();
		let listenerCalled = false;
		const listener = () => {
			listenerCalled = true;
		};
		process.once("uncaughtException", listener);
		try {
			const emitted = process.emit("uncaughtException", makeCursorSdkStallAbortWrapperConnectError(), "uncaughtException");
			expect(emitted).toBe(true);
			expect(listenerCalled).toBe(false);
		} finally {
			process.removeListener("uncaughtException", listener);
			suppression.dispose();
		}
	});

	it("suppresses Cursor network unhandled rejections while a provider turn is active", () => {
		const suppression = installCursorSdkProcessErrorGuard();
		let listenerCalled = false;
		const listener = () => {
			listenerCalled = true;
		};
		process.once("unhandledRejection", listener);
		try {
			const emitted = process.emit("unhandledRejection", makeCursorSdkNetworkConnectError(), Promise.resolve());
			expect(emitted).toBe(true);
			expect(listenerCalled).toBe(false);
		} finally {
			process.removeListener("unhandledRejection", listener);
			suppression.dispose();
		}
	});

	it("suppresses generic connect-node network errors while a provider turn is active", () => {
		const suppression = installCursorSdkProcessErrorGuard();
		let listenerCalled = false;
		const listener = () => {
			listenerCalled = true;
		};
		process.once("uncaughtException", listener);
		try {
			const emitted = process.emit("uncaughtException", makeGenericConnectNodeNetworkConnectError(), "uncaughtException");
			expect(emitted).toBe(true);
			expect(listenerCalled).toBe(false);
		} finally {
			process.removeListener("uncaughtException", listener);
			suppression.dispose();
		}
	});

	it("does not suppress provenance-free network ConnectErrors during an active provider turn", () => {
		const suppression = installCursorSdkProcessErrorGuard();
		let listenerCalled = false;
		const listener = () => {
			listenerCalled = true;
		};
		process.once("uncaughtException", listener);
		try {
			const emitted = process.emit("uncaughtException", makeProvenanceFreeNetworkConnectError(), "uncaughtException");
			expect(emitted).toBe(true);
			expect(listenerCalled).toBe(true);
		} finally {
			process.removeListener("uncaughtException", listener);
			suppression.dispose();
		}
	});

	it.each([
		["Cursor SDK closed writable", makeCursorSdkWriteIterableClosedError],
		["Cursor SDK stack", makeCursorSdkNetworkConnectError],
		["Cursor SDK HTTP/2 stream reset", makeCursorSdkHttp2EnhanceYourCalmConnectError],
		["Cursor SDK stall abort wrapper", makeCursorSdkStallAbortWrapperConnectError],
		["generic connect-node stack", makeGenericConnectNodeNetworkConnectError],
	])("does not suppress %s process errors after guard disposal", (_name, makeError) => {
		const suppression = installCursorSdkProcessErrorGuard();
		suppression.dispose();
		let listenerCalled = false;
		const listener = () => {
			listenerCalled = true;
		};
		process.once("uncaughtException", listener);
		try {
			const emitted = process.emit("uncaughtException", makeError(), "uncaughtException");
			expect(emitted).toBe(true);
			expect(listenerCalled).toBe(true);
		} finally {
			process.removeListener("uncaughtException", listener);
		}
	});
});
