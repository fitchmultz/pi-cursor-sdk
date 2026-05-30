import { describe, expect, it } from "vitest";
import { isUnauthenticatedConnectError } from "../src/cursor-provider-errors.js";
import {
	installCursorSdkProcessErrorGuard,
	isCursorSdkAbortConnectError,
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

function makeNonCursorNetworkConnectError(): Error & { rawMessage: string; code: number; cause: NodeJS.ErrnoException } {
	const error = makeCursorSdkNetworkConnectError();
	error.stack =
		"ConnectError: [aborted] read ECONNRESET\n" +
		"    at file:///repo/node_modules/@connectrpc/connect-node/dist/esm/node-universal-client.js:293:63";
	return error;
}

describe("Cursor SDK process error guard", () => {
	it("matches local Cursor SDK abort ConnectError shape", () => {
		expect(isCursorSdkAbortConnectError(makeCursorSdkAbortConnectError())).toBe(true);
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

	it("does not suppress non-Cursor network ConnectErrors", () => {
		const suppression = installCursorSdkProcessErrorGuard();
		let listenerCalled = false;
		const listener = () => {
			listenerCalled = true;
		};
		process.once("uncaughtException", listener);
		try {
			const emitted = process.emit("uncaughtException", makeNonCursorNetworkConnectError(), "uncaughtException");
			expect(emitted).toBe(true);
			expect(listenerCalled).toBe(true);
		} finally {
			process.removeListener("uncaughtException", listener);
			suppression.dispose();
		}
	});

	it("does not suppress Cursor network ConnectErrors after guard disposal", () => {
		const suppression = installCursorSdkProcessErrorGuard();
		suppression.dispose();
		let listenerCalled = false;
		const listener = () => {
			listenerCalled = true;
		};
		process.once("uncaughtException", listener);
		try {
			const emitted = process.emit("uncaughtException", makeCursorSdkNetworkConnectError(), "uncaughtException");
			expect(emitted).toBe(true);
			expect(listenerCalled).toBe(true);
		} finally {
			process.removeListener("uncaughtException", listener);
		}
	});
});
