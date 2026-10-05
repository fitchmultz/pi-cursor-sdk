/** Tracks whether cursor_ask_question is awaiting pi UI input (#281). */
let blockedDepth = 0;
const syncHooks = new Set<() => void>();

export function isCursorAskQuestionBlocked(): boolean {
	return blockedDepth > 0;
}

/** Register a listener invoked whenever ask_question blocked depth changes. */
export function registerCursorAskQuestionBlockedSync(hook: () => void): () => void {
	syncHooks.add(hook);
	return () => {
		syncHooks.delete(hook);
	};
}

function notifyAskQuestionBlockedSync(): void {
	for (const hook of syncHooks) {
		try {
			hook();
		} catch {
			// Ignore listener failures; idle-dispose sync must not break ask_question.
		}
	}
}

export function setCursorAskQuestionBlocked(active: boolean): void {
	if (active) {
		blockedDepth += 1;
	} else if (blockedDepth > 0) {
		blockedDepth -= 1;
	}
	notifyAskQuestionBlockedSync();
}

export function resetCursorAskQuestionBlockedForTests(): void {
	blockedDepth = 0;
	syncHooks.clear();
}
