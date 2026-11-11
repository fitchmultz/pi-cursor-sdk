import type { AssistantMessage, AssistantMessageEventStream, TextContent, ThinkingContent } from "@earendil-works/pi-ai";

const DEFAULT_THINKING_TRACE_MAX_CHARS = 50000;
export const CURSOR_TEXT_MESSAGE_SEPARATOR = "\n\n";

/** A channel's open block and its index in the partial; a closed channel has none. */
interface OpenContentBlock<TBlock> {
	readonly contentIndex: number;
	readonly block: TBlock;
}

/** Open slots retain block references; callers append to partial.content without replacing earlier blocks. */
export class CursorPartialContentEmitter {
	// Independent channels: without mutual exclusion, thinking and text can both stay open.
	private openThinking: OpenContentBlock<ThinkingContent> | undefined;
	private openText: OpenContentBlock<TextContent> | undefined;
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
		const open = this.openThinking;
		if (!open) return;
		this.openThinking = undefined;
		this.stream.push({
			type: "thinking_end",
			contentIndex: open.contentIndex,
			content: open.block.thinking,
			partial: this.partial,
		});
	}

	closeText(): string {
		const open = this.openText;
		if (!open) return "";
		this.openText = undefined;
		this.stream.push({
			type: "text_end",
			contentIndex: open.contentIndex,
			content: open.block.text,
			partial: this.partial,
		});
		return open.block.text;
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

		let open = this.openThinking;
		if (!open) {
			open = { contentIndex: this.partial.content.length, block: { type: "thinking", thinking: "" } };
			this.partial.content.push(open.block);
			this.openThinking = open;
			this.stream.push({ type: "thinking_start", contentIndex: open.contentIndex, partial: this.partial });
		}
		open.block.thinking += text;
		this.activityTraceChars += text.length;
		this.stream.push({
			type: "thinking_delta",
			contentIndex: open.contentIndex,
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
		let open = this.openText;
		if (!open) {
			open = { contentIndex: this.partial.content.length, block: { type: "text", text: "" } };
			this.partial.content.push(open.block);
			this.openText = open;
			this.stream.push({ type: "text_start", contentIndex: open.contentIndex, partial: this.partial });
		}
		open.block.text += delta;
		this.stream.push({
			type: "text_delta",
			contentIndex: open.contentIndex,
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
