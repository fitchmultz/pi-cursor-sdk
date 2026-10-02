import { afterEach, describe, expect, it } from "vitest";
import {
	__resetCursorTodoMirrorForTests,
	__setCursorTodoMirrorStoreImporterForTests,
	CURSOR_TASK_NOTE_SOURCE,
	CURSOR_TODO_MIRROR_EVENT,
	CURSOR_TODO_SOURCE,
	RPIV_TODO_UPDATED_EVENT,
	mapCursorTaskToNote,
	mapCursorTodoStatus,
	mapCursorTodosToTasks,
	mergeMirroredTodoState,
	mirrorCursorActivityTool,
	registerCursorTodoMirror,
	resolveCursorTodoMirrorEnabled,
} from "../src/cursor-todo-mirror.js";

describe("cursor todo mirror", () => {
	afterEach(() => {
		__resetCursorTodoMirrorForTests();
	});

	it("defaults mirror on and honors opt-out", () => {
		expect(resolveCursorTodoMirrorEnabled({})).toBe(true);
		expect(resolveCursorTodoMirrorEnabled({ PI_CURSOR_TODO_MIRROR: "0" })).toBe(false);
	});

	it("maps Cursor todo statuses onto pi statuses", () => {
		expect(mapCursorTodoStatus("pending")).toBe("pending");
		expect(mapCursorTodoStatus("inProgress")).toBe("in_progress");
		expect(mapCursorTodoStatus("completed")).toBe("completed");
		expect(mapCursorTodoStatus("cancelled")).toBe("pending");
	});

	it("keeps at most one in_progress Cursor todo", () => {
		const tasks = mapCursorTodosToTasks([
			{ content: "A", status: "inProgress" },
			{ content: "B", status: "inProgress" },
			{ content: "C", status: "completed" },
		]);
		expect(tasks.map((task) => task.status)).toEqual(["in_progress", "pending", "completed"]);
		expect(tasks.every((task) => task.metadata?.source === CURSOR_TODO_SOURCE)).toBe(true);
	});

	it("preserves Cursor task notes across updateTodos snapshots", () => {
		const withNote = mergeMirroredTodoState(undefined, {
			kind: "task",
			note: mapCursorTaskToNote({
				description: "Map APIs",
				agentId: "abc123",
				subagentName: "composer-worker",
			}),
		});
		expect(withNote.tasks).toHaveLength(1);
		expect(withNote.tasks[0]?.metadata?.source).toBe(CURSOR_TASK_NOTE_SOURCE);

		const merged = mergeMirroredTodoState(withNote, {
			kind: "updateTodos",
			items: [{ content: "Ship mirror", status: "pending" }],
		});
		expect(merged.tasks.map((task) => task.subject)).toEqual([
			"Ship mirror",
			"Cursor task: Map APIs",
		]);
	});

	it("upserts task notes by agent id", () => {
		const first = mergeMirroredTodoState(undefined, {
			kind: "task",
			note: mapCursorTaskToNote({ description: "old", agentId: "a1" }),
		});
		const second = mergeMirroredTodoState(first, {
			kind: "task",
			note: mapCursorTaskToNote({ description: "new", agentId: "a1" }),
		});
		expect(second.tasks.filter((task) => task.metadata?.source === CURSOR_TASK_NOTE_SOURCE)).toHaveLength(1);
		expect(second.tasks[0]?.subject).toContain("new");
	});

	it("writes rpiv-todo store and emits mirror events", async () => {
		const replaced: Array<{ sessionId: string; state: unknown }> = [];
		const emitted: Array<{ channel: string; data: unknown }> = [];
		__setCursorTodoMirrorStoreImporterForTests(async () => ({
			getState: () => ({ tasks: [], nextId: 1 }),
			replaceState: (sessionId, state) => {
				replaced.push({ sessionId, state });
			},
		}));
		registerCursorTodoMirror({
			events: {
				emit: (channel, data) => {
					emitted.push({ channel, data });
				},
			},
		} as never);

		const payload = await mirrorCursorActivityTool({
			toolName: "updateTodos",
			args: {
				todos: [{ content: "Wire mirror", status: "inProgress" }],
			},
			result: { status: "ok", value: {} },
			sessionId: "sess-1",
			env: { PI_CURSOR_TODO_MIRROR: "1" },
		});

		expect(payload?.state.tasks).toHaveLength(1);
		expect(replaced).toHaveLength(1);
		expect(emitted.map((entry) => entry.channel)).toEqual([
			CURSOR_TODO_MIRROR_EVENT,
			RPIV_TODO_UPDATED_EVENT,
		]);
	});

	it("skips when disabled", async () => {
		const payload = await mirrorCursorActivityTool({
			toolName: "updateTodos",
			args: { todos: [{ content: "Nope", status: "pending" }] },
			result: { status: "ok", value: {} },
			sessionId: "sess-1",
			env: { PI_CURSOR_TODO_MIRROR: "0" },
		});
		expect(payload).toBeUndefined();
	});
});
