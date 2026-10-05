/**
 * Tracks whether `cursor_ask_question` is awaiting pi UI input.
 * Live-run idle dispose consults this so a blocked question cannot look like an idle run (#281).
 */

let blockedDepth = 0;
const listeners = new Set<() => void>();

export function isCursorAskQuestionBlocked(): boolean {
	return blockedDepth > 0;
}

export function setCursorAskQuestionBlocked(active: boolean): void {
	const wasBlocked = blockedDepth > 0;
	if (active) {
		blockedDepth += 1;
	} else if (blockedDepth > 0) {
		blockedDepth -= 1;
	}
	const isBlocked = blockedDepth > 0;
	if (wasBlocked === isBlocked) return;
	for (const listener of [...listeners]) {
		listener();
	}
}

export function onCursorAskQuestionBlockedChange(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function resetCursorAskQuestionBlockedStateForTests(): void {
	blockedDepth = 0;
	listeners.clear();
}
