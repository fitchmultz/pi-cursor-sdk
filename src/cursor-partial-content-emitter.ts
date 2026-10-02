import type { AssistantMessage, AssistantMessageEventStream } from "@earendil-works/pi-ai";

const DEFAULT_THINKING_TRACE_MAX_CHARS = 50000;
export const CURSOR_TEXT_MESSAGE_SEPARATOR = "\n\n";

export interface CursorPartialContentEmitterOptions {
	stream: AssistantMessageEventStream;
	partial: AssistantMessage;
	thinkingMaxChars?: number;
	mutuallyExclusive?: boolean;
}

export class CursorPartialContentEmitter {
	private thinkingContentIndex = -1;
	private textContentIndex = -1;
	private textMessageCompleted = false;
	private activityTraceChars = 0;
	private activityTraceTruncated = false;

	constructor(
		private readonly stream: AssistantMessageEventStream,
		private readonly partial: AssistantMessage,
		private readonly thinkingMaxChars = DEFAULT_THINKING_TRACE_MAX_CHARS,
		private readonly mutuallyExclusive = true,
	) {}

	closeThinking(): void {
		if (this.thinkingContentIndex < 0) return;
		const block = this.partial.content[this.thinkingContentIndex];
		if (block.type === "thinking") {
			this.stream.push({
				type: "thinking_end",
				contentIndex: this.thinkingContentIndex,
				content: block.thinking,
				partial: this.partial,
			});
		}
		this.thinkingContentIndex = -1;
	}

	closeText(): string {
		if (this.textContentIndex < 0) return "";
		const contentIndex = this.textContentIndex;
		const block = this.partial.content[contentIndex];
		this.textContentIndex = -1;
		if (block.type !== "text") return "";
		this.stream.push({
			type: "text_end",
			contentIndex,
			content: block.text,
			partial: this.partial,
		});
		return block.text;
	}

	closeAll(): string {
		this.closeThinking();
		return this.closeText();
	}

	appendThinkingDelta(delta: string, options?: { closeText?: boolean }): void {
		const closeText = options?.closeText ?? this.mutuallyExclusive;
		if (closeText) this.closeText();
		if (this.activityTraceTruncated || !delta) return;

		let text = delta;
		if (this.thinkingMaxChars >= 0 && this.activityTraceChars + text.length > this.thinkingMaxChars) {
			const remainingChars = Math.max(this.thinkingMaxChars - this.activityTraceChars, 0);
			text = `${text.slice(0, remainingChars)}\n[Cursor activity trace truncated]\n`;
			this.activityTraceTruncated = true;
		}
		if (!text) return;

		if (this.thinkingContentIndex < 0) {
			this.thinkingContentIndex = this.partial.content.length;
			this.partial.content.push({ type: "thinking", thinking: "" });
			this.stream.push({ type: "thinking_start", contentIndex: this.thinkingContentIndex, partial: this.partial });
		}
		const block = this.partial.content[this.thinkingContentIndex];
		if (block.type !== "thinking") return;
		block.thinking += text;
		this.activityTraceChars += text.length;
		this.stream.push({
			type: "thinking_delta",
			contentIndex: this.thinkingContentIndex,
			delta: text,
			partial: this.partial,
		});
	}

	completeTextMessage(): void {
		// Defer the separator until more text arrives: an exact final answer must
		// not gain trailing whitespace. A fresh Pi tool-use turn needs no prefix.
		this.textMessageCompleted = this.partial.content.some((block) => block.type === "text" && block.text.length > 0);
	}

	appendTextDelta(delta: string, options?: { closeThinking?: boolean }): void {
		const closeThinking = options?.closeThinking ?? this.mutuallyExclusive;
		if (closeThinking) this.closeThinking();
		if (!delta) return;
		if (this.textMessageCompleted) {
			this.textMessageCompleted = false;
			this.appendTextDelta(CURSOR_TEXT_MESSAGE_SEPARATOR, { closeThinking: false });
			this.closeText();
		}
		if (this.textContentIndex < 0) {
			this.textContentIndex = this.partial.content.length;
			this.partial.content.push({ type: "text", text: "" });
			this.stream.push({ type: "text_start", contentIndex: this.textContentIndex, partial: this.partial });
		}
		const block = this.partial.content[this.textContentIndex];
		if (block.type !== "text") return;
		block.text += delta;
		this.stream.push({
			type: "text_delta",
			contentIndex: this.textContentIndex,
			delta,
			partial: this.partial,
		});
	}

	appendThinkingBlock(text: string, options?: { closeText?: boolean }): void {
		const closeText = options?.closeText ?? this.mutuallyExclusive;
		if (closeText) this.closeAll();
		else this.closeThinking();
		this.appendThinkingDelta(text.endsWith("\n") ? text : `${text}\n`, { closeText: false });
		this.closeThinking();
	}

	flushText(deltas: string[]): string {
		for (const delta of deltas) this.appendTextDelta(delta);
		return this.closeText();
	}
}
