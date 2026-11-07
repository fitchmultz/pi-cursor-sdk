import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CURSOR_PROVIDER } from "./cursor-model.js";

/**
 * Pi recognizes `context_length_exceeded` (its `OVERFLOW_PATTERNS` includes
 * `/context[_ ]length[_ ]exceeded/i`) as a context-overflow signal and, on
 * detecting it, drops the failed assistant message, compacts, and retries once.
 *
 * The Cursor provider sanitizes SDK failures into auth/network/generic messages
 * that pi does NOT treat as overflow, so a genuine Cursor context-overflow
 * failure would otherwise surface as a plain provider error and bypass pi's
 * auto-compact-retry recovery. This handler rewrites only Cursor context-window
 * failures into the `context_length_exceeded` form pi recognizes.
 *
 * See pi `docs/custom-provider.md` -> "Context Overflow Errors".
 */
const CURSOR_OVERFLOW_MARKER = "context_length_exceeded";

/**
 * Context-overflow phrases. These overlap pi's own `OVERFLOW_PATTERNS` so the
 * false-positive surface matches pi's built-in detection for other providers.
 *
 * ponytail: intentionally narrow and textual. We do NOT match bare gRPC
 * `resource_exhausted` (code 8) or `too many tokens` because pi documents those
 * can false-match throttling/quota errors and trigger an unwanted compaction.
 * If a live Cursor probe reveals a distinct overflow phrase, add it here; this
 * pattern set is the single place to extend without touching the handler.
 */
const CURSOR_OVERFLOW_PATTERNS = [
	/context[_ ]?length/i,
	/context[_ ]?window/i,
	/maximum context/i,
	/prompt is too long/i,
	/too large for model/i,
	/exceed(?:s|ed).{0,30}context/i,
] as const;

/** Never treat rate-limit/throttle signals as overflow (pi retries those separately). */
const CURSOR_THROTTLE_PATTERN = /too many requests|rate.?limit|throttl|retry.?after/i;

/**
 * Map a finalized Cursor assistant `errorMessage` to pi's overflow form.
 * Returns `undefined` when the message is not a Cursor context-overflow failure.
 *
 * Idempotent so repeated message delivery does not add another prefix.
 */
function normalizeCursorOverflowErrorMessage(errorMessage: string | undefined): string | undefined {
	const message = errorMessage?.trim();
	if (!message) return undefined;
	// Idempotent: never double-prefix an already-normalized message.
	if (message.includes(CURSOR_OVERFLOW_MARKER)) return undefined;
	if (CURSOR_THROTTLE_PATTERN.test(message)) return undefined;
	if (CURSOR_OVERFLOW_PATTERNS.some((pattern) => pattern.test(message))) {
		return `${CURSOR_OVERFLOW_MARKER}: ${message}`;
	}
	return undefined;
}

export type CursorOverflowExtensionApi = Pick<ExtensionAPI, "on">;

/**
 * Register a `message_end` handler that rewrites Cursor context-overflow
 * failures into the `context_length_exceeded` form pi auto-compacts on.
 *
 * Guarded exactly as pi's provider docs require: scoped to the Cursor provider,
 * only for `stopReason === "error"`, never for throttling, and idempotent.
 */
export function registerCursorOverflowNormalization(pi: CursorOverflowExtensionApi): void {
	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant") return undefined;
		const isCursorProvider = message.provider === CURSOR_PROVIDER || ctx.model?.provider === CURSOR_PROVIDER;
		if (!isCursorProvider || message.stopReason !== "error") return undefined;
		const rewritten = normalizeCursorOverflowErrorMessage(message.errorMessage);
		if (!rewritten) return undefined;
		return { message: { ...message, errorMessage: rewritten } };
	});
}
