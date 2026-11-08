// Loaded by Pi's own extension loader in an offline RPC child: registers the real question tool from src, mirrors its
// blocked event to the RPC status channel, and adds an offline "cursor" model that asks the prompt's JSON arguments.
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import {
	CURSOR_ASK_QUESTION_BLOCKED_EVENT,
	CURSOR_ASK_QUESTION_TOOL_NAME,
	registerCursorQuestionTool,
} from "../../src/cursor-question-tool.js";

export default function cursorQuestionRpcExtension(pi: ExtensionAPI): void {
	let ui: ExtensionUIContext | undefined;
	pi.on("session_start", (_event, ctx) => {
		ui = ctx.ui;
	});
	pi.events.on(CURSOR_ASK_QUESTION_BLOCKED_EVENT, (payload) => {
		ui?.setStatus(CURSOR_ASK_QUESTION_BLOCKED_EVENT, JSON.stringify(payload));
	});
	registerCursorQuestionTool(pi);
	pi.registerProvider("cursor", {
		baseUrl: "https://example.invalid",
		apiKey: "offline-fixture-only",
		api: "cursor-sdk",
		models: [{
			id: "question-proof", name: "Question proof", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 256000, maxTokens: 32000,
		}],
		streamSimple(model, context) {
			const stream = createAssistantMessageEventStream();
			const last = context.messages.at(-1);
			const prompt = last?.role !== "user" ? undefined
				: typeof last.content === "string" ? last.content
				: last.content.map((block) => (block.type === "text" ? block.text : "")).join("");
			const content: AssistantMessage["content"] = prompt === undefined
				? [{ type: "text", text: "Question tool finished." }]
				: [{ type: "toolCall", id: "question-rpc", name: CURSOR_ASK_QUESTION_TOOL_NAME, arguments: JSON.parse(prompt) }];
			const reason = prompt === undefined ? "stop" : "toolUse";
			const message: AssistantMessage = {
				role: "assistant", content, api: model.api, provider: model.provider, model: model.id, stopReason: reason, timestamp: Date.now(),
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			};
			queueMicrotask(() => {
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason, message });
				stream.end();
			});
			return stream;
		},
	});
}
