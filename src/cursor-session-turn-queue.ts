import { CursorLiveRunAbortError } from "./cursor-live-run-coordinator.js";

const turnQueuesByScope = new Map<string, Promise<void>>();

async function waitForPreviousTurn(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
	if (!signal) {
		await previous.catch(() => undefined);
		return;
	}
	if (signal.aborted) throw new CursorLiveRunAbortError();
	await new Promise<void>((resolve, reject) => {
		const onAbort = (): void => {
			reject(new CursorLiveRunAbortError());
		};
		signal.addEventListener("abort", onAbort, { once: true });
		previous.catch(() => undefined).then(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		});
	});
}

/**
 * Runs `body` after every earlier call for `scopeKey` has settled, so one scope's turns never overlap.
 *
 * Cancellation follows the turn lease:
 * - A call that is not queued behind an earlier call runs `body` even if `signal` is already
 *   aborted. It holds the lease, so `body` owns the abort; the provider turn runner then releases
 *   its scope's pending live run, if any.
 * - A queued call rejects with `CursorLiveRunAbortError`, without running `body`, if `signal` is
 *   already aborted or aborts before its predecessor settles. It never held the lease, so its
 *   caller must not release runs that belong to the lease holder.
 *
 * Each call's slot settles only after its predecessor's slot, so an aborted waiter cannot let a later
 * call overtake an earlier one. A settled slot removes the scope entry only while it is still the latest.
 */
export async function runExclusiveCursorSessionTurn<T>(scopeKey: string, body: () => Promise<T>, signal?: AbortSignal): Promise<T> {
	const previous = turnQueuesByScope.get(scopeKey);
	let releaseCurrent!: () => void;
	const current = new Promise<void>((resolve) => {
		releaseCurrent = resolve;
	});
	const tail = (previous ?? Promise.resolve()).catch(() => undefined).then(() => current);
	turnQueuesByScope.set(scopeKey, tail);
	void tail.finally(() => {
		if (turnQueuesByScope.get(scopeKey) === tail) {
			turnQueuesByScope.delete(scopeKey);
		}
	});

	try {
		if (previous) await waitForPreviousTurn(previous, signal);
		return await body();
	} finally {
		releaseCurrent();
	}
}

export const __testUtils = {
	reset(): void {
		turnQueuesByScope.clear();
	},
	count(): number {
		return turnQueuesByScope.size;
	},
};
