import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { isUnauthenticatedConnectError } from "../src/cursor-provider-errors.js";
import { readInstalledPackageDistText } from "./helpers/installed-package.js";
import {
	__testUtils,
	installCursorSdkProcessErrorGuard,
	installCursorSdkSessionProcessErrorGuard,
	isCursorSdkAbortConnectError,
	registerCursorSdkSessionProcessErrorGuard,
} from "../src/cursor-sdk-process-error-guard.js";

const emitProcessEvent = (event: string | symbol, ...args: unknown[]): boolean =>
	(process.emit as (event: string | symbol, ...args: unknown[]) => boolean).call(process, event, ...args);

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
		"    at <anonymous> (/repo/node_modules/@cursor/sdk/dist/esm/34.js:1:101697)";
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
		"    at AbortSignal.r (file:///repo/node_modules/@cursor/sdk/dist/esm/34.js:1:5705)\n" +
		"    at Y.onStall (file:///repo/node_modules/@cursor/sdk/dist/esm/34.js:1:75246)";
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
		"    at file:///repo/node_modules/@cursor/sdk/dist/esm/34.js:1:5832";
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
		const sdkDist = readInstalledPackageDistText("@cursor/sdk");
		expect(sdkDist).toContain('this.name="WriteIterableClosedError"');
		expect(sdkDist).toContain('"WritableIterable is closed"');
		expect(sdkDist).toContain("SimpleControlledExecManager");
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
			const emitted = emitProcessEvent("unhandledRejection", makeCursorSdkWriteIterableClosedError(), Promise.resolve());
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
			const emitted = emitProcessEvent("uncaughtException", error, "uncaughtException");
			expect(emitted).toBe(true);
			expect(listenerCalled).toBe(true);
		} finally {
			process.removeListener("uncaughtException", listener);
			suppression.dispose();
		}
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
			const unsuppressed = emitProcessEvent("uncaughtException", makeCursorSdkAbortConnectError(), "uncaughtException");
			expect(unsuppressed).toBe(true);
			expect(listenerCalled).toBe(true);
		} finally {
			process.removeListener("uncaughtException", listener);
		}

		listenerCalled = false;
		process.once("uncaughtException", listener);
		try {
			suppression.suppressAbortErrors();
			const emitted = emitProcessEvent("uncaughtException", makeCursorSdkAbortConnectError(), "uncaughtException");
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
			const emitted = emitProcessEvent("uncaughtException", makeError(), "uncaughtException");
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
			const emitted = emitProcessEvent("uncaughtException", makeNonCursorUnauthenticatedConnectError(), "uncaughtException");
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
			const emitted = emitProcessEvent("uncaughtException", makeError(), "uncaughtException");
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
			const emitted = emitProcessEvent(
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
			const emitted = emitProcessEvent("uncaughtException", makeCursorSdkStallAbortWrapperConnectError(), "uncaughtException");
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
			const emitted = emitProcessEvent("unhandledRejection", makeCursorSdkNetworkConnectError(), Promise.resolve());
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
			const emitted = emitProcessEvent("uncaughtException", makeGenericConnectNodeNetworkConnectError(), "uncaughtException");
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
			const emitted = emitProcessEvent("uncaughtException", makeProvenanceFreeNetworkConnectError(), "uncaughtException");
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
			const emitted = emitProcessEvent("uncaughtException", makeError(), "uncaughtException");
			expect(emitted).toBe(true);
			expect(listenerCalled).toBe(true);
		} finally {
			process.removeListener("uncaughtException", listener);
		}
	});
});
