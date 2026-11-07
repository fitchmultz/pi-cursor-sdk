import { Agent, type AgentMessage } from "@cursor/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectCursorTranscriptWebToolCalls, countCursorAgentMessages } from "../src/cursor-agent-message-web-tools.js";

const fakeAgentMessage: AgentMessage = {
	type: "assistant",
	uuid: "agent-1:0",
	agent_id: "agent-1",
	message: {},
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe("countCursorAgentMessages", () => {
	it("counts local Cursor messages beyond the old 4096-message fallback cap", async () => {
		const messageCount = 5000;
		const list = vi.spyOn(Agent.messages, "list").mockImplementation(async (_agentId, options) => {
			const offset = options?.offset ?? 0;
			return offset < messageCount ? [fakeAgentMessage] : [];
		});

		await expect(countCursorAgentMessages("agent-1", "/repo")).resolves.toBe(messageCount);
		expect(list).toHaveBeenCalledWith("agent-1", { runtime: "local", cwd: "/repo", limit: 1, offset: 4096 });
	});
});

describe("collectCursorTranscriptWebToolCalls", () => {
	it.each([
		{
			name: "webSearch",
			toolCase: "webSearchToolCall",
			messageType: "user",
			uuid: "agent-1:7",
			args: { searchTerm: "Cursor IDE", toolCallId: "tool-1" },
			value: {
				references: [{
					title: "Web search results",
					url: "",
					chunk: "Links:\n1. [Cursor — Build Software with AI Agents](https://cursor.com/product)",
				}],
			},
			identity: "cursor-transcript:agent-1:7:webSearch:tool-1",
			text: "Links:\n1. [Cursor — Build Software with AI Agents](https://cursor.com/product)",
		},
		{
			name: "webFetch",
			toolCase: "webFetchToolCall",
			messageType: "assistant",
			uuid: "agent-1:8",
			args: { url: "https://example.com", toolCallId: "tool-fetch-1" },
			value: { content: [{ type: "text", text: "<title>Example Domain</title>" }] },
			identity: "cursor-transcript:agent-1:8:webFetch:tool-fetch-1",
			text: "<title>Example Domain</title>",
		},
	] as const)("extracts protobuf-style Cursor $name calls from local agent messages", ({ name, toolCase, messageType, uuid, args, value, identity, text }) => {
		const calls = collectCursorTranscriptWebToolCalls([{
			type: messageType,
			uuid,
			agent_id: "agent-1",
			message: {
				turn: {
					case: "agentConversationTurn",
					value: {
						steps: [{
							message: {
								case: "toolCall",
								value: {
									tool: {
										case: toolCase,
										value: {
											args,
											result: { result: { case: "success", value } },
										},
									},
								},
							},
						}],
					},
				},
			},
		}]);

		expect(calls).toHaveLength(1);
		expect(calls[0].identity).toBe(identity);
		expect(calls[0].toolCall).toEqual({
			name,
			args,
			result: { status: "success", value: { content: [{ type: "text", text }] } },
		});
	});
});
