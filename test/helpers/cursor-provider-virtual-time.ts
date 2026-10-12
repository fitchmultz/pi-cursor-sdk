import { scheduler } from "node:timers/promises";
import { afterEach, beforeEach, vi } from "vitest";

/**
 * Registers per-test fake Date/setTimeout/clearTimeout. Node's scheduler.wait uses native timers,
 * so it advances the same delay on Vitest's clock, or waits natively once a test restores real timers.
 * Register after any beforeEach that resets timers.
 */
export function installCursorProviderVirtualTime(): void {
	let restoreWait: () => void;
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
		const nativeWait = scheduler.wait.bind(scheduler);
		const wait = vi.spyOn(scheduler, "wait").mockImplementation(async (delay) => {
			await (vi.isFakeTimers() ? vi.advanceTimersByTimeAsync(delay) : nativeWait(delay));
		});
		restoreWait = () => wait.mockRestore();
	});
	afterEach(() => {
		restoreWait();
		vi.useRealTimers();
	});
}
