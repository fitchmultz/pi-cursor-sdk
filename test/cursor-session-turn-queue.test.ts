import { afterEach, describe, expect, it } from "vitest";
import { CursorLiveRunAbortError } from "../src/cursor-live-run-coordinator.js";
import {
	__testUtils as cursorSessionTurnQueueTestUtils,
	runExclusiveCursorSessionTurn,
} from "../src/cursor-session-turn-queue.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((innerResolve) => {
		resolve = innerResolve;
	});
	return { promise, resolve };
}

async function flushQueue(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("cursor session turn queue", () => {
	afterEach(() => {
		cursorSessionTurnQueueTestUtils.reset();
	});

	it("serializes calls for the same scope", async () => {
		const releaseFirst = deferred();
		const releaseSecond = deferred();
		const events: string[] = [];

		const first = runExclusiveCursorSessionTurn("scope", async () => {
			events.push("first:start");
			await releaseFirst.promise;
			events.push("first:end");
			return "first";
		});
		const second = runExclusiveCursorSessionTurn("scope", async () => {
			events.push("second:start");
			await releaseSecond.promise;
			events.push("second:end");
			return "second";
		});

		await flushQueue();
		expect(events).toEqual(["first:start"]);

		releaseFirst.resolve();
		await expect(first).resolves.toBe("first");
		await flushQueue();
		// The first call's settled slot must not unlink the running second call's slot.
		const third = runExclusiveCursorSessionTurn("scope", async () => {
			events.push("third:start");
			return "third";
		});
		await flushQueue();
		expect(events).toEqual(["first:start", "first:end", "second:start"]);

		releaseSecond.resolve();
		await expect(second).resolves.toBe("second");
		await expect(third).resolves.toBe("third");
		expect(events).toEqual(["first:start", "first:end", "second:start", "second:end", "third:start"]);
		expect(cursorSessionTurnQueueTestUtils.count()).toBe(0);
	});

	it("allows different scopes to overlap", async () => {
		const releaseFirst = deferred();
		const events: string[] = [];

		const first = runExclusiveCursorSessionTurn("scope-a", async () => {
			events.push("first:start");
			await releaseFirst.promise;
			events.push("first:end");
		});
		const second = runExclusiveCursorSessionTurn("scope-b", async () => {
			events.push("second:start");
		});

		await flushQueue();
		expect(events).toEqual(["first:start", "second:start"]);
		await second;
		expect(cursorSessionTurnQueueTestUtils.count()).toBe(1);

		releaseFirst.resolve();
		await first;
		await flushQueue();
		expect(events).toEqual(["first:start", "second:start", "first:end"]);
		expect(cursorSessionTurnQueueTestUtils.count()).toBe(0);
	});

	it("rejects an already-aborted queued signal without running the body", async () => {
		const releaseFirst = deferred();
		const controller = new AbortController();
		let secondRan = false;

		const first = runExclusiveCursorSessionTurn("scope", async () => {
			await releaseFirst.promise;
		});
		controller.abort();
		const second = runExclusiveCursorSessionTurn(
			"scope",
			async () => {
				secondRan = true;
			},
			controller.signal,
		);

		await expect(second).rejects.toBeInstanceOf(CursorLiveRunAbortError);
		expect(secondRan).toBe(false);
		expect(cursorSessionTurnQueueTestUtils.count()).toBe(1);

		releaseFirst.resolve();
		await first;
		await flushQueue();
		expect(cursorSessionTurnQueueTestUtils.count()).toBe(0);
	});

	it("rejects with CursorLiveRunAbortError when aborted while waiting", async () => {
		const releaseFirst = deferred();
		const controller = new AbortController();
		let secondRan = false;

		const first = runExclusiveCursorSessionTurn("scope", async () => {
			await releaseFirst.promise;
		});
		const second = runExclusiveCursorSessionTurn(
			"scope",
			async () => {
				secondRan = true;
			},
			controller.signal,
		);

		await flushQueue();
		controller.abort();
		await expect(second).rejects.toBeInstanceOf(CursorLiveRunAbortError);
		expect(secondRan).toBe(false);
		expect(cursorSessionTurnQueueTestUtils.count()).toBe(1);

		releaseFirst.resolve();
		await first;
		await flushQueue();
		expect(cursorSessionTurnQueueTestUtils.count()).toBe(0);
	});
});
