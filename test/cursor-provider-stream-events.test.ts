import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	resetCursorProviderTestState,
	makeModel,
	makeContext,
	makeAssistantMessage,
	collectEvents,
	collectTextDeltas,
	collectThinkingDeltas,
	getEventsOfType,
	getDoneEvent,
	getErrorEvent,
	type CursorDeltaHandler,
	mockCreatedAgent,
	asMockCursorRun,
	asMockSdkAgent,
	mockedCreate,
} from "./helpers/cursor-provider-harness.js";
import { streamCursor } from "./helpers/cursor-provider-ownership.js";
import { __testUtils as cursorProviderTestUtils } from "../src/cursor-provider.js";
import type { Context } from "@earendil-works/pi-ai";


describe("streamCursor stream events", () => {
	beforeEach(resetCursorProviderTestState);

	it("detects trailing user messages only after tool results", () => {
			const base = makeContext();
			const toolResult: Context["messages"][number] = {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "bash",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: 3,
			};

			expect(cursorProviderTestUtils.hasTrailingUserMessagesAfterToolResults(base)).toBe(false);
			expect(
				cursorProviderTestUtils.hasTrailingUserMessagesAfterToolResults({
					...base,
					messages: [...base.messages, makeAssistantMessage(), { role: "user", content: "follow up", timestamp: 4 }],
				}),
			).toBe(false);
			expect(
				cursorProviderTestUtils.hasTrailingUserMessagesAfterToolResults({
					...base,
					messages: [...base.messages, makeAssistantMessage(), toolResult, { role: "user", content: "follow up", timestamp: 4 }],
				}),
			).toBe(true);
		});

		it("emits text deltas as pi text stream events", async () => {
			const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				opts.onDelta({ update: { type: "text-delta", text: "Hello " } });
				opts.onDelta({ update: { type: "text-delta", text: "world" } });
				return asMockCursorRun({
					id: "run-1",
					agentId: "agent-1",
					status: "finished",
					wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
					cancel: vi.fn(),
					supports: () => true,
					unsupportedReason: () => undefined,
				});
			});
			mockCreatedAgent({
				send: mockSend,
				[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
			});

			const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
			const events = await collectEvents(stream);

			const textDeltas = getEventsOfType(events, "text_delta");
			expect(textDeltas).toHaveLength(2);
			expect(textDeltas[0].delta).toBe("Hello ");
			expect(textDeltas[1].delta).toBe("world");

			const done = getDoneEvent(events);
			expect(done).toBeDefined();
		});

		it("serializes concurrent Cursor turns for one pi session across model selections", async () => {
			let activeSends = 0;
			let maxActiveSends = 0;
			let releaseFirstSend!: () => void;
			const firstSendReleased = new Promise<void>((resolve) => {
				releaseFirstSend = resolve;
			});
			let firstSendStarted = false;
			const sendFor = (label: string) =>
				vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
					activeSends += 1;
					maxActiveSends = Math.max(maxActiveSends, activeSends);
					if (label === "first") {
						firstSendStarted = true;
						await firstSendReleased;
					} else {
						expect(firstSendStarted).toBe(true);
					}
					opts.onDelta({ update: { type: "text-delta", text: `${label}-answer` } });
					activeSends -= 1;
					return asMockCursorRun({
						id: `${label}-run`,
						agentId: `${label}-agent`,
						status: "finished",
						wait: vi.fn().mockResolvedValue({ id: `${label}-run`, status: "finished" }),
					});
				});
			const firstSend = sendFor("first");
			const secondSend = sendFor("second");
			mockedCreate
				.mockResolvedValueOnce(asMockSdkAgent({ agentId: "first-agent", send: firstSend }))
				.mockResolvedValueOnce(asMockSdkAgent({ agentId: "second-agent", send: secondSend }));

			const firstEventsPromise = collectEvents(streamCursor(makeModel("composer-2.5"), makeContext([{ role: "user", content: "first task", timestamp: 1 }]), { apiKey: "test-key" }));
			const secondEventsPromise = collectEvents(streamCursor(makeModel("gpt-5.5@272k"), makeContext([{ role: "user", content: "second task", timestamp: 1 }]), { apiKey: "test-key", reasoning: "medium" }));
			await vi.waitFor(() => expect(firstSend).toHaveBeenCalledTimes(1));
			expect(secondSend).not.toHaveBeenCalled();

			releaseFirstSend();
			const [firstEvents, secondEvents] = await Promise.all([firstEventsPromise, secondEventsPromise]);

			expect(maxActiveSends).toBe(1);
			expect(collectTextDeltas(firstEvents)).toBe("first-answer");
			expect(collectTextDeltas(secondEvents)).toBe("second-answer");
			expect(mockedCreate).toHaveBeenCalledTimes(2);
		});

		it("aborts a queued Cursor turn without waiting for the active turn", async () => {
			let releaseFirstSend!: () => void;
			const firstSendReleased = new Promise<void>((resolve) => {
				releaseFirstSend = resolve;
			});
			const firstSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				await firstSendReleased;
				opts.onDelta({ update: { type: "text-delta", text: "first-answer" } });
				return asMockCursorRun({
					id: "first-run",
					agentId: "first-agent",
					status: "finished",
					wait: vi.fn().mockResolvedValue({ id: "first-run", status: "finished" }),
				});
			});
			const secondSend = vi.fn();
			mockedCreate.mockResolvedValueOnce(asMockSdkAgent({ agentId: "first-agent", send: firstSend }));

			const firstEventsPromise = collectEvents(streamCursor(makeModel("composer-2.5"), makeContext([{ role: "user", content: "first task", timestamp: 1 }]), { apiKey: "test-key" }));
			await vi.waitFor(() => expect(firstSend).toHaveBeenCalledTimes(1));
			const controller = new AbortController();
			const secondEventsPromise = collectEvents(streamCursor(makeModel("gpt-5.5@272k"), makeContext([{ role: "user", content: "second task", timestamp: 1 }]), { apiKey: "test-key", reasoning: "medium", signal: controller.signal }));

			controller.abort();
			const secondEvents = await secondEventsPromise;
			expect(secondEvents[0]?.type).toBe("start");
			expect(getErrorEvent(secondEvents).reason).toBe("aborted");
			expect(secondSend).not.toHaveBeenCalled();
			expect(mockedCreate).toHaveBeenCalledTimes(1);

			const thirdSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				opts.onDelta({ update: { type: "text-delta", text: "third-answer" } });
				return asMockCursorRun({
					id: "third-run",
					agentId: "third-agent",
					status: "finished",
					wait: vi.fn().mockResolvedValue({ id: "third-run", status: "finished" }),
				});
			});
			mockedCreate.mockResolvedValueOnce(asMockSdkAgent({ agentId: "third-agent", send: thirdSend }));
			const thirdEventsPromise = collectEvents(streamCursor(makeModel("gpt-5.5@272k"), makeContext([{ role: "user", content: "third task", timestamp: 1 }]), { apiKey: "test-key", reasoning: "medium" }));
			await Promise.resolve();
			expect(thirdSend).not.toHaveBeenCalled();

			releaseFirstSend();
			expect(collectTextDeltas(await firstEventsPromise)).toBe("first-answer");
			expect(collectTextDeltas(await thirdEventsPromise)).toBe("third-answer");
		});

		it("emits createPlan args as final visible text when native replay is unavailable", async () => {
			const plan = "Plan:\n1. Create calculator UI.\n2. Implement addition and subtraction.\n3. Add tests.";
			const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				opts.onDelta({ update: { type: "text-delta", text: "Switching to plan mode.\n" } });
				opts.onDelta({ update: { type: "tool-call-completed", toolCall: { name: "createPlan", args: { plan }, result: { status: "success", value: {} } }, callId: "plan-1" } });
				return asMockCursorRun({
					id: "run-1",
					agentId: "agent-1",
					status: "finished",
					wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "Switching to plan mode.\n" }),
					cancel: vi.fn(),
					supports: () => true,
					unsupportedReason: () => undefined,
				});
			});
			mockCreatedAgent({
				send: mockSend,
				[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
			});

			const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
			const text = collectTextDeltas(events);
			const trace = collectThinkingDeltas(events);
			const done = getDoneEvent(events);

			expect(text).toBe(`Switching to plan mode.\n${plan}`);
			expect(trace).toContain("Create calculator UI");
			expect(done.message.content[0]).toEqual({ type: "text", text: `Switching to plan mode.\n${plan}` });
		});

		it("emits thinking deltas as pi thinking stream events", async () => {
			const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				opts.onDelta({ update: { type: "thinking-delta", text: "hmm" } });
				opts.onDelta({ update: { type: "thinking-delta", text: " let me think" } });
				opts.onDelta({ update: { type: "thinking-completed" } });
				opts.onDelta({ update: { type: "text-delta", text: "answer" } });
				return asMockCursorRun({
					id: "run-1",
					agentId: "agent-1",
					status: "finished",
					wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
					cancel: vi.fn(),
					supports: () => true,
					unsupportedReason: () => undefined,
				});
			});
			mockCreatedAgent({
				send: mockSend,
				[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
			});

			const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
			const events = await collectEvents(stream);

			const thinkingDeltas = getEventsOfType(events, "thinking_delta");
			expect(thinkingDeltas).toHaveLength(2);

			const thinkingEnd = events.find((event) => event.type === "thinking_end");
			expect(thinkingEnd).toBeDefined();
		});

		it("keeps late cursor thinking in the saved content order after live text", async () => {
			const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				opts.onDelta({ update: { type: "text-delta", text: "Final answer" } });
				opts.onDelta({ update: { type: "thinking-delta", text: "late trace" } });
				opts.onDelta({ update: { type: "thinking-completed" } });
				return asMockCursorRun({
					id: "run-1",
					agentId: "agent-1",
					status: "finished",
					wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
					cancel: vi.fn(),
					supports: () => true,
					unsupportedReason: () => undefined,
				});
			});
			mockCreatedAgent({
				send: mockSend,
				[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
			});

			const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
			const events = await collectEvents(stream);
			const done = getDoneEvent(events);

			expect(done.message.content).toEqual([
				{ type: "text", text: "Final answer" },
				{ type: "thinking", thinking: "late trace" },
			]);
		});
});
