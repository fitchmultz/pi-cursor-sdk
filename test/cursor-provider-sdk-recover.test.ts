import { describe, expect, it, vi } from "vitest";
import {
	AUTH_CURSOR_SDK_ERROR_MESSAGE,
	CLOUD_AUTH_CURSOR_SDK_ERROR_MESSAGE,
	MISSING_CURSOR_API_KEY_MESSAGE,
} from "../src/cursor-provider-errors.js";
import {
	CURSOR_SDK_RECOVER_CONTINUE_PROMPT,
	CURSOR_SDK_RECOVER_COOLDOWN_MS,
	CURSOR_SDK_RECOVER_ENTRY_TYPE,
	CURSOR_SDK_RECOVER_SLASH,
	buildCursorSdkRecoverContinuePrompt,
	classifyCursorRecoverableErrorMessage,
	isCursorAuthFailureErrorMessage,
	isCursorRecoverableAbortErrorMessage,
	registerCursorSdkRecover,
	shouldQueueCursorSdkRecover,
	softenCursorRecoverableErrorMessage,
} from "../src/cursor-provider-sdk-recover.js";
import { makeAssistantMessage } from "./helpers/pi-harness.js";
import type { AssistantMessage } from "@earendil-works/pi-ai";

/** Channel name must match recover listener / question-tool emit (#255). */
const ASK_QUESTION_ANSWERED_EVENT = "pi-cursor-sdk:ask-question:answered";

function assistantError(provider: string | undefined, errorMessage?: string): AssistantMessage {
	return {
		...makeAssistantMessage(""),
		...(provider ? { provider } : {}),
		stopReason: "error",
		...(errorMessage !== undefined ? { errorMessage } : {}),
	};
}

describe("isCursorAuthFailureErrorMessage", () => {
	it("matches canonical auth failure strings", () => {
		expect(isCursorAuthFailureErrorMessage(AUTH_CURSOR_SDK_ERROR_MESSAGE)).toBe(true);
		expect(isCursorAuthFailureErrorMessage(MISSING_CURSOR_API_KEY_MESSAGE)).toBe(true);
		expect(isCursorAuthFailureErrorMessage(CLOUD_AUTH_CURSOR_SDK_ERROR_MESSAGE)).toBe(true);
		expect(isCursorAuthFailureErrorMessage("Cursor SDK API key may be invalid or unauthorized")).toBe(true);
		expect(isCursorAuthFailureErrorMessage("Network error: Cursor SDK request failed")).toBe(false);
		expect(isCursorAuthFailureErrorMessage(undefined)).toBe(false);
	});
});

describe("isCursorRecoverableAbortErrorMessage", () => {
	it("matches stale aborts and rejects user cancels", () => {
		expect(isCursorRecoverableAbortErrorMessage("This operation was aborted")).toBe(true);
		expect(isCursorRecoverableAbortErrorMessage("Error: This operation was aborted")).toBe(true);
		expect(isCursorRecoverableAbortErrorMessage("[canceled] This operation was aborted")).toBe(true);
		expect(isCursorRecoverableAbortErrorMessage("Cancelled: Cursor SDK run aborted.")).toBe(true);
		expect(isCursorRecoverableAbortErrorMessage("Cancelled: prompt interrupted.")).toBe(false);
		expect(isCursorRecoverableAbortErrorMessage("Cancelled: Cursor SDK run was cancelled.")).toBe(false);
	});
});

describe("classifyCursorRecoverableErrorMessage", () => {
	it("prefers auth over abort", () => {
		expect(classifyCursorRecoverableErrorMessage(AUTH_CURSOR_SDK_ERROR_MESSAGE)).toBe("auth");
		expect(classifyCursorRecoverableErrorMessage("This operation was aborted")).toBe("abort");
	});
});

describe("buildCursorSdkRecoverContinuePrompt", () => {
	it("appends a late question answer when present", () => {
		expect(buildCursorSdkRecoverContinuePrompt()).toBe(CURSOR_SDK_RECOVER_CONTINUE_PROMPT);
		expect(buildCursorSdkRecoverContinuePrompt({ answerSummary: "Use Preview" })).toContain("Use Preview");
	});
});

describe("softenCursorRecoverableErrorMessage", () => {
	it("replaces the raw error with a recovery notice", () => {
		const softened = softenCursorRecoverableErrorMessage(
			assistantError("cursor", "This operation was aborted"),
			"abort",
		);
		expect(softened.errorMessage).toMatch(/auto-reloading/i);
		expect(softened.errorMessage).not.toBe("This operation was aborted");
	});
});

describe("shouldQueueCursorSdkRecover", () => {
	it("queues once for auth/abort and respects cooldown", () => {
		const message = assistantError("cursor", AUTH_CURSOR_SDK_ERROR_MESSAGE);
		expect(shouldQueueCursorSdkRecover({ message, isCursorProvider: true, nowMs: 1_000 })).toBe("auth");
		expect(
			shouldQueueCursorSdkRecover({
				message: assistantError("cursor", "This operation was aborted"),
				isCursorProvider: true,
				nowMs: 1_000,
			}),
		).toBe("abort");
		expect(
			shouldQueueCursorSdkRecover({
				message,
				isCursorProvider: true,
				lastQueuedAtMs: 1_000,
				nowMs: 1_000 + CURSOR_SDK_RECOVER_COOLDOWN_MS - 1,
			}),
		).toBeUndefined();
		expect(
			shouldQueueCursorSdkRecover({
				message,
				isCursorProvider: true,
				lastQueuedAtMs: 1_000,
				nowMs: 1_000 + CURSOR_SDK_RECOVER_COOLDOWN_MS,
			}),
		).toBe("auth");
	});

	it("ignores non-Cursor providers and unrelated errors", () => {
		expect(
			shouldQueueCursorSdkRecover({
				message: assistantError("cursor", AUTH_CURSOR_SDK_ERROR_MESSAGE),
				isCursorProvider: false,
				nowMs: 0,
			}),
		).toBeUndefined();
		expect(
			shouldQueueCursorSdkRecover({
				message: assistantError("cursor", "Network error: Cursor SDK request failed"),
				isCursorProvider: true,
				nowMs: 0,
			}),
		).toBeUndefined();
	});
});

describe("registerCursorSdkRecover", () => {
	function createHarness(options?: { nowMs?: number; cooldownMs?: number }) {
		const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
		const eventHandlers = new Map<string, Array<(payload: unknown) => void>>();
		const sendUserMessage = vi.fn();
		const appendEntry = vi.fn();
		const notify = vi.fn();
		const reload = vi.fn(async () => {});
		const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<unknown> }>();
		const scheduled: Array<{ fn: () => void; delayMs: number }> = [];
		let nowMs = options?.nowMs ?? 10_000;

		registerCursorSdkRecover(
			{
				on: (event, handler) => {
					const list = handlers.get(event) ?? [];
					list.push(handler as (event: unknown, ctx: unknown) => unknown);
					handlers.set(event, list);
				},
				events: {
					on: (event: string, handler: (payload: unknown) => void) => {
						const list = eventHandlers.get(event) ?? [];
						list.push(handler);
						eventHandlers.set(event, list);
					},
				} as never,
				sendUserMessage,
				appendEntry,
				registerCommand: (name, command) => {
					commands.set(name, command as { handler: (args: string, ctx: unknown) => Promise<unknown> });
				},
			},
			{
				now: () => nowMs,
				cooldownMs: options?.cooldownMs ?? 1_000,
				schedule: (fn, delayMs) => {
					scheduled.push({ fn, delayMs });
				},
			},
		);

		return {
			handlers,
			eventHandlers,
			sendUserMessage,
			appendEntry,
			notify,
			reload,
			commands,
			scheduled,
			flushScheduled: () => {
				const pending = scheduled.splice(0, scheduled.length);
				for (const item of pending) item.fn();
			},
		};
	}

	it("reloads and continues on auth failure", async () => {
		const harness = createHarness();
		expect(harness.commands.has("cursor-sdk-recover")).toBe(true);

		const ctx = { model: { provider: "cursor" }, hasUI: true, ui: { notify: harness.notify } };
		const result = harness.handlers.get("message_end")![0](
			{ message: assistantError("cursor", AUTH_CURSOR_SDK_ERROR_MESSAGE) },
			ctx,
		) as { message?: AssistantMessage };
		expect(harness.notify).toHaveBeenCalledTimes(1);
		expect(result.message?.errorMessage).toMatch(/auto-reloading/i);

		harness.handlers.get("agent_settled")![0]({}, ctx);
		expect(harness.sendUserMessage).toHaveBeenCalledWith(CURSOR_SDK_RECOVER_SLASH, {
			expandPromptTemplates: true,
		});

		await harness.commands.get("cursor-sdk-recover")!.handler("", { reload: harness.reload });
		expect(harness.appendEntry).toHaveBeenCalledWith(
			CURSOR_SDK_RECOVER_ENTRY_TYPE,
			expect.objectContaining({ reason: "auth", continue: true }),
		);
		expect(harness.reload).toHaveBeenCalledTimes(1);

		const entries = [
			{
				type: "custom",
				customType: CURSOR_SDK_RECOVER_ENTRY_TYPE,
				data: { reason: "auth", continue: true, atMs: 10_000 },
			},
		];
		harness.handlers.get("session_start")![0](
			{ type: "session_start", reason: "reload" },
			{ hasUI: true, ui: { notify: harness.notify }, sessionManager: { getEntries: () => entries } },
		);
		harness.flushScheduled();
		expect(harness.sendUserMessage).toHaveBeenCalledWith(CURSOR_SDK_RECOVER_CONTINUE_PROMPT);
	});

	it("recovers from abort the same way", async () => {
		const harness = createHarness();
		harness.handlers.get("message_end")![0](
			{ message: assistantError("cursor", "This operation was aborted") },
			{ model: { provider: "cursor" }, hasUI: false, ui: { notify: vi.fn() } },
		);
		harness.handlers.get("agent_settled")![0]({}, {});
		expect(harness.sendUserMessage).toHaveBeenCalledWith(CURSOR_SDK_RECOVER_SLASH, {
			expandPromptTemplates: true,
		});
		await harness.commands.get("cursor-sdk-recover")!.handler("", { reload: harness.reload });
		expect(harness.appendEntry).toHaveBeenCalledWith(
			CURSOR_SDK_RECOVER_ENTRY_TYPE,
			expect.objectContaining({ reason: "abort", continue: true }),
		);
	});

	it("dispatches from the message_end backup timer when settle is missed", () => {
		const harness = createHarness();
		harness.handlers.get("message_end")![0](
			{ message: assistantError("cursor", "This operation was aborted") },
			{ model: { provider: "cursor" }, hasUI: false, ui: { notify: vi.fn() } },
		);
		expect(harness.sendUserMessage).not.toHaveBeenCalled();
		harness.flushScheduled();
		expect(harness.sendUserMessage).toHaveBeenCalledWith(CURSOR_SDK_RECOVER_SLASH, {
			expandPromptTemplates: true,
		});
	});

	it("re-delivers a late ask-question answer after abort reload", async () => {
		const harness = createHarness();
		harness.eventHandlers.get(ASK_QUESTION_ANSWERED_EVENT)![0]({
			toolCallId: "call_1",
			summary: "Chosen: Preview",
			cancelled: false,
		});
		harness.handlers.get("message_end")![0](
			{ message: assistantError("cursor", "This operation was aborted") },
			{ model: { provider: "cursor" }, hasUI: false, ui: { notify: vi.fn() } },
		);
		harness.handlers.get("agent_settled")![0]({}, {});
		await harness.commands.get("cursor-sdk-recover")!.handler("", { reload: harness.reload });
		expect(harness.appendEntry).toHaveBeenCalledWith(
			CURSOR_SDK_RECOVER_ENTRY_TYPE,
			expect.objectContaining({ reason: "abort", continue: true, answerSummary: "Chosen: Preview" }),
		);

		const entries = [
			{
				type: "custom",
				customType: CURSOR_SDK_RECOVER_ENTRY_TYPE,
				data: { reason: "abort", continue: true, atMs: 10_000, answerSummary: "Chosen: Preview" },
			},
		];
		harness.handlers.get("session_start")![0](
			{ type: "session_start", reason: "reload" },
			{ hasUI: false, ui: { notify: vi.fn() }, sessionManager: { getEntries: () => entries } },
		);
		harness.flushScheduled();
		expect(harness.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("Chosen: Preview"));
	});

	it("does not queue reload for unrelated Cursor errors", () => {
		const harness = createHarness();
		harness.handlers.get("message_end")![0](
			{ message: assistantError("cursor", "Network error: Cursor SDK request failed") },
			{ model: { provider: "cursor" }, hasUI: false, ui: { notify: vi.fn() } },
		);
		harness.handlers.get("agent_settled")![0]({}, {});
		harness.flushScheduled();
		expect(harness.sendUserMessage).not.toHaveBeenCalled();
	});
});
