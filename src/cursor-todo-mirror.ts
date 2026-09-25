import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseEnvBoolean } from "./cursor-env-boolean.js";
import { getCursorSessionId } from "./cursor-session-scope.js";
import type { CursorTaskMetadata } from "./cursor-task-presentation.js";
import {
	getTodoItems,
	type CursorTodoItem,
	type CursorToolResultLike,
} from "./cursor-tool-result-display-readers.js";

export const CURSOR_TODO_MIRROR_ENV = "PI_CURSOR_TODO_MIRROR";
export const CURSOR_TODO_MIRROR_EVENT = "pi-cursor-sdk/todo-mirror";
export const RPIV_TODO_UPDATED_EVENT = "rpiv-todo/updated";

export const CURSOR_TODO_SOURCE = "cursor-updateTodos";
export const CURSOR_TASK_NOTE_SOURCE = "cursor-task";

type PiTaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export interface MirroredPiTask {
	id: number;
	subject: string;
	description?: string;
	activeForm?: string;
	status: PiTaskStatus;
	metadata?: Record<string, unknown>;
}

export interface MirroredPiTaskState {
	tasks: MirroredPiTask[];
	nextId: number;
}

export type CursorTodoMirrorKind = "updateTodos" | "task";

export interface CursorTodoMirrorPayload {
	kind: CursorTodoMirrorKind;
	sessionId: string;
	state: MirroredPiTaskState;
}

type CursorTodoMirrorEvents = Pick<ExtensionAPI, "events">;

type RpivTodoStoreModule = {
	replaceState(sessionId: string, next: MirroredPiTaskState): void;
	getState(sessionId: string): MirroredPiTaskState;
};

let mirrorEvents: CursorTodoMirrorEvents | undefined;
let storeImporter: (() => Promise<RpivTodoStoreModule | undefined>) | undefined;

export function resolveCursorTodoMirrorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return parseEnvBoolean(env[CURSOR_TODO_MIRROR_ENV], true);
}

export function mapCursorTodoStatus(status: string | undefined): PiTaskStatus {
	const normalized = status?.trim().toLowerCase();
	if (!normalized) return "pending";
	if (normalized === "completed" || normalized === "complete" || normalized === "done") return "completed";
	// Cursor cancelled is not a pi status; keep visible as pending.
	if (normalized === "cancelled" || normalized === "canceled") return "pending";
	if (normalized === "in_progress" || normalized === "inprogress" || normalized === "in-progress") {
		return "in_progress";
	}
	if (normalized === "deleted") return "deleted";
	return "pending";
}

function cursorTodoKey(item: CursorTodoItem): string {
	return item.content.trim();
}

function isPreservedTaskNote(task: MirroredPiTask): boolean {
	return task.metadata?.source === CURSOR_TASK_NOTE_SOURCE && task.status !== "deleted";
}

export function mapCursorTodosToTasks(items: readonly CursorTodoItem[]): MirroredPiTask[] {
	let nextId = 1;
	const tasks: MirroredPiTask[] = [];
	let sawInProgress = false;
	for (const item of items) {
		const subject = item.content.trim();
		if (!subject) continue;
		let status = mapCursorTodoStatus(item.status);
		if (status === "in_progress") {
			if (sawInProgress) status = "pending";
			else sawInProgress = true;
		}
		tasks.push({
			id: nextId,
			subject,
			status,
			activeForm: status === "in_progress" ? subject : undefined,
			metadata: {
				source: CURSOR_TODO_SOURCE,
				cursorKey: cursorTodoKey(item),
				cursorStatus: item.status ?? null,
			},
		});
		nextId += 1;
	}
	return tasks;
}

export function mapCursorTaskToNote(metadata: CursorTaskMetadata): MirroredPiTask {
	const description = metadata.description?.trim() || "Cursor task";
	const agentId = metadata.agentId?.trim();
	const subject = agentId ? `Cursor task: ${description}` : `Cursor task: ${description}`;
	return {
		id: 1,
		subject: subject.slice(0, 200),
		description: [
			metadata.subagentName ? `subagent=${metadata.subagentName}` : undefined,
			metadata.subagentKind ? `kind=${metadata.subagentKind}` : undefined,
			metadata.model ? `model=${metadata.model}` : undefined,
			agentId ? `agentId=${agentId}` : undefined,
			metadata.isBackground === true ? "background=true" : undefined,
		]
			.filter((line): line is string => Boolean(line))
			.join("\n") || undefined,
		status: "completed",
		metadata: {
			source: CURSOR_TASK_NOTE_SOURCE,
			cursorAgentId: agentId ?? null,
			cursorSubagentName: metadata.subagentName ?? null,
			cursorSubagentKind: metadata.subagentKind ?? null,
			cursorModel: metadata.model ?? null,
			cursorIsBackground: metadata.isBackground ?? null,
		},
	};
}

export function mergeMirroredTodoState(
	existing: MirroredPiTaskState | undefined,
	incoming: { kind: "updateTodos"; items: readonly CursorTodoItem[] } | { kind: "task"; note: MirroredPiTask },
): MirroredPiTaskState {
	const preservedNotes = (existing?.tasks ?? []).filter(isPreservedTaskNote);
	if (incoming.kind === "updateTodos") {
		const mapped = mapCursorTodosToTasks(incoming.items);
		const tasks = [...mapped];
		let nextId = mapped.reduce((max, task) => Math.max(max, task.id), 0) + 1;
		for (const note of preservedNotes) {
			tasks.push({ ...note, id: nextId });
			nextId += 1;
		}
		return { tasks, nextId };
	}

	const noteKey = incoming.note.metadata?.cursorAgentId;
	const withoutMatching = preservedNotes.filter((task) => {
		if (noteKey == null || noteKey === "") return true;
		return task.metadata?.cursorAgentId !== noteKey;
	});
	const cursorTodos = (existing?.tasks ?? []).filter(
		(task) => task.metadata?.source === CURSOR_TODO_SOURCE && task.status !== "deleted",
	);
	const tasks = [...cursorTodos];
	let nextId = tasks.reduce((max, task) => Math.max(max, task.id), 0) + 1;
	for (const note of withoutMatching) {
		tasks.push({ ...note, id: nextId });
		nextId += 1;
	}
	tasks.push({ ...incoming.note, id: nextId });
	nextId += 1;
	return { tasks, nextId };
}

export function registerCursorTodoMirror(pi: CursorTodoMirrorEvents): void {
	mirrorEvents = pi;
}

export function __setCursorTodoMirrorStoreImporterForTests(
	importer: (() => Promise<RpivTodoStoreModule | undefined>) | undefined,
): void {
	storeImporter = importer;
}

export function __resetCursorTodoMirrorForTests(): void {
	mirrorEvents = undefined;
	storeImporter = undefined;
}

async function loadRpivTodoStore(): Promise<RpivTodoStoreModule | undefined> {
	if (storeImporter) return storeImporter();
	try {
		return (await import("@juicesharp/rpiv-todo/state/store.js")) as RpivTodoStoreModule;
	} catch {
		return undefined;
	}
}

export async function mirrorCursorActivityTool(options: {
	toolName: string;
	args: Record<string, unknown>;
	result: CursorToolResultLike;
	taskMetadata?: CursorTaskMetadata;
	env?: NodeJS.ProcessEnv;
	sessionId?: string;
}): Promise<CursorTodoMirrorPayload | undefined> {
	if (!resolveCursorTodoMirrorEnabled(options.env)) return undefined;
	if (options.toolName !== "updateTodos" && options.toolName !== "task") return undefined;

	const sessionId = options.sessionId ?? getCursorSessionId() ?? "";
	if (!sessionId) return undefined;

	const store = await loadRpivTodoStore();
	const existing = store?.getState(sessionId);

	const state =
		options.toolName === "updateTodos"
			? mergeMirroredTodoState(existing, {
					kind: "updateTodos",
					items: getTodoItems(options.args, options.result),
				})
			: mergeMirroredTodoState(existing, {
					kind: "task",
					note: mapCursorTaskToNote(options.taskMetadata ?? {}),
				});

	const payload: CursorTodoMirrorPayload = {
		kind: options.toolName,
		sessionId,
		state,
	};

	try {
		store?.replaceState(sessionId, state);
	} catch {
		// Soft dependency: keep emitting so a local bridge can still apply.
	}

	mirrorEvents?.events.emit(CURSOR_TODO_MIRROR_EVENT, payload);
	mirrorEvents?.events.emit(RPIV_TODO_UPDATED_EVENT, { sessionId });
	return payload;
}
