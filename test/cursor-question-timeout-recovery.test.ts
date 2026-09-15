import { describe, expect, it, vi } from "vitest";
import {
	CURSOR_ASK_QUESTION_CONTINUE_PROMPT,
	isCursorAskQuestionTimeoutErrorMessage,
	registerCursorAskQuestionTimeoutRecovery,
	shouldQueueCursorAskQuestionContinue,
} from "../src/cursor-question-timeout-recovery.js";
import {
	CURSOR_ASK_QUESTION_ANSWERED_EVENT,
	CURSOR_ASK_QUESTION_BLOCKED_EVENT,
} from "../src/cursor-question-tool.js";
import { isCursorPiBridgeWaitForUserTool } from "../src/cursor-pi-tool-bridge-constants.js";
import { CURSOR_ASK_QUESTION_TOOL_NAME } from "../src/cursor-question-tool.js";
import { makeAssistantMessage } from "./helpers/pi-harness.js";
import type { AssistantMessage } from "@earendil-works/pi-ai";

function assistantError(provider: string | undefined, errorMessage?: string): AssistantMessage {
	return {
		...makeAssistantMessage(""),
		...(provider ? { provider } : {}),
		stopReason: "error",
		...(errorMessage !== undefined ? { errorMessage } : {}),
	};
}

describe("cursor ask-question timeout recovery", () => {
	it("treats cursor_ask_question as a wait-for-user bridge tool", () => {
		expect(isCursorPiBridgeWaitForUserTool(CURSOR_ASK_QUESTION_TOOL_NAME)).toBe(true);
		expect(isCursorPiBridgeWaitForUserTool("bash")).toBe(false);
	});

	it("matches Cursor MCP question timeouts and ignores unrelated errors", () => {
		expect(isCursorAskQuestionTimeoutErrorMessage("MCP tool call timed out after 60s")).toBe(true);
		expect(isCursorAskQuestionTimeoutErrorMessage("Request timed out")).toBe(true);
		expect(isCursorAskQuestionTimeoutErrorMessage("Cursor pi bridge CallTool timed out after 3600000 ms")).toBe(true);
		expect(isCursorAskQuestionTimeoutErrorMessage("Network error")).toBe(false);
		expect(isCursorAskQuestionTimeoutErrorMessage(undefined)).toBe(false);
	});

	it("queues continue only after the question UI is gone", () => {
		const message = assistantError("cursor", "MCP tool call timed out after 60s");
		expect(
			shouldQueueCursorAskQuestionContinue({
				message,
				isCursorProvider: true,
				questionActive: true,
				nowMs: 1_000,
			}),
		).toBe(false);
		expect(
			shouldQueueCursorAskQuestionContinue({
				message,
				isCursorProvider: true,
				questionActive: false,
				nowMs: 1_000,
			}),
		).toBe(true);
		expect(
			shouldQueueCursorAskQuestionContinue({
				message,
				isCursorProvider: true,
				questionActive: false,
				lastQueuedAtMs: 1_000,
				nowMs: 2_000,
				cooldownMs: 15_000,
			}),
		).toBe(false);
	});

	it("sends a late answer as a follow-up when the bridge call is no longer pending", () => {
		const sendUserMessage = vi.fn();
		const listeners = new Map<string, (payload: unknown) => void>();
		registerCursorAskQuestionTimeoutRecovery({
			on: vi.fn(),
			sendUserMessage,
			events: {
				emit: vi.fn(),
				on: (channel: string, handler: (payload: unknown) => void) => {
					listeners.set(channel, handler);
					return () => listeners.delete(channel);
				},
			},
		} as never);

		listeners.get(CURSOR_ASK_QUESTION_ANSWERED_EVENT)?.({
			toolCallId: "cursor-pi-bridge-run-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee-tool-1",
			summary: "User answered: keep waiting",
			cancelled: false,
		});

		expect(sendUserMessage).toHaveBeenCalledWith("User answered: keep waiting", { deliverAs: "followUp" });
	});

	it("queues continue without /reload when a timeout lands after the question UI closed", () => {
		const sendUserMessage = vi.fn();
		const listeners = new Map<string, (payload: unknown) => void>();
		const onHandlers: Array<(event: { message: AssistantMessage }, ctx: { model?: { provider?: string } }) => void> = [];
		registerCursorAskQuestionTimeoutRecovery({
			on: (eventName: string, handler: (event: { message: AssistantMessage }, ctx: { model?: { provider?: string } }) => void) => {
				if (eventName === "message_end") onHandlers.push(handler);
			},
			sendUserMessage,
			events: {
				emit: vi.fn(),
				on: (channel: string, handler: (payload: unknown) => void) => {
					listeners.set(channel, handler);
					return () => listeners.delete(channel);
				},
			},
		} as never);

		listeners.get(CURSOR_ASK_QUESTION_BLOCKED_EVENT)?.({ active: true });
		listeners.get(CURSOR_ASK_QUESTION_BLOCKED_EVENT)?.({ active: false });
		onHandlers[0]!({ message: assistantError("cursor", "MCP tool call timed out after 60s") }, { model: { provider: "cursor" } });

		expect(sendUserMessage).toHaveBeenCalledWith(CURSOR_ASK_QUESTION_CONTINUE_PROMPT, { deliverAs: "followUp" });
	});
});
