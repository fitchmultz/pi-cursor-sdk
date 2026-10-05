import { readFileSync } from "node:fs";

interface CapturedError {
	name: string;
	message: string;
	rawMessage?: string;
	code: number;
	stack: string;
}

const capture = JSON.parse(readFileSync(
	new URL("../fixtures/cursor-sdk-stall-abort-1.0.35.json", import.meta.url), "utf8",
)) as { chain: [CapturedError, CapturedError, CapturedError] };

/** Rehydrate the actual default-depth offline capture; only its repo prefix was normalized. */
export function makeCursorSdkStallAbortWrapperConnectError() {
	const [outer, inner, originalAbort] = capture.chain;
	const abort = Object.assign(new DOMException(originalAbort.message, originalAbort.name), { stack: originalAbort.stack });
	const cause = Object.assign(new Error(inner.message), inner, { cause: abort });
	return Object.assign(new Error(outer.message), outer, { cause });
}
