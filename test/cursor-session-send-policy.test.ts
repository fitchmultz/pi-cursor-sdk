import { describe, it, expect } from "vitest";
import type { Context } from "@earendil-works/pi-ai";
import { computeCursorContextFingerprint } from "../src/context.js";
import {
	buildCursorSessionSendPrompt,
	MAX_COMPLETED_INCREMENTAL_SENDS_BEFORE_REBOOTSTRAP,
	planCursorSessionSend,
} from "../src/cursor-session-send-policy.js";
import { getCursorToolTailGuardText } from "../src/context.js";

describe("cursor-session-send-policy", () => {
	const priorContext: Context = {
		messages: [{ role: "user", content: "Hello", timestamp: 1 }],
	};
	const followUpContext: Context = {
		messages: [...priorContext.messages, { role: "user", content: "Follow up", timestamp: 2 }],
	};
	const fingerprint = computeCursorContextFingerprint(priorContext);

	it.each([
		{
			name: "plans initial bootstrap without resetting the agent",
			state: { bootstrapped: false, contextFingerprint: "", incrementalSendCount: 0 },
			context: priorContext,
			expected: { mode: "bootstrap", resetAgent: false, reason: "initial" },
		},
		{
			name: "plans incremental sends below the rebootstrap threshold",
			state: { bootstrapped: true, contextFingerprint: fingerprint, incrementalSendCount: MAX_COMPLETED_INCREMENTAL_SENDS_BEFORE_REBOOTSTRAP - 1 },
			context: followUpContext,
			expected: { mode: "incremental", resetAgent: false, reason: "incremental" },
		},
		{
			name: "plans agent reset and bootstrap at the incremental threshold",
			state: { bootstrapped: true, contextFingerprint: fingerprint, incrementalSendCount: MAX_COMPLETED_INCREMENTAL_SENDS_BEFORE_REBOOTSTRAP },
			context: followUpContext,
			expected: { mode: "bootstrap", resetAgent: true, reason: "incremental_threshold" },
		},
		{
			name: "plans context-divergence bootstrap with agent reset",
			state: { bootstrapped: true, contextFingerprint: fingerprint, incrementalSendCount: 2 },
			context: { messages: [{ role: "user", content: "Hello edited", timestamp: 1 }] } satisfies Context,
			expected: { mode: "bootstrap", resetAgent: true, reason: "context_divergence" },
		},
	])("$name", ({ state, context, expected }) => {
		expect(planCursorSessionSend(state, context)).toEqual(expected);
	});

	it("builds bootstrap and incremental prompts from the send plan", () => {
		const context: Context = {
			systemPrompt: "Be helpful.",
			messages: [{ role: "user", content: "Follow up", timestamp: 3 }],
		};
		const bootstrapPrompt = buildCursorSessionSendPrompt(context, {}, {
			mode: "bootstrap",
			resetAgent: false,
			reason: "initial",
		});
		const incrementalPrompt = buildCursorSessionSendPrompt(context, {}, {
			mode: "incremental",
			resetAgent: false,
			reason: "incremental",
		});

		expect(bootstrapPrompt.text).toContain("Cursor SDK tool boundary:");
		expect(bootstrapPrompt.text.endsWith(getCursorToolTailGuardText())).toBe(true);
		expect(incrementalPrompt.text).not.toContain("Cursor SDK tool boundary:");
		expect(incrementalPrompt.text.endsWith(getCursorToolTailGuardText())).toBe(true);
	});
});
