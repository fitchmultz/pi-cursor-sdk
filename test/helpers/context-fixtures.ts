import { vi } from "vitest";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { AssistantMessage, AssistantMessageEvent, Context } from "@earendil-works/pi-ai";
import {
	DEFAULT_COMPACTION_SETTINGS,
	ModelRegistry,
	ModelRuntime,
	type NormalizedBuildSystemPromptOptions,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { makeModel } from "./model-fixtures.js";
import type { ExtensionCommandContextOverrides, ExtensionContextOverrides } from "./pi-harness-types.js";

const sharedTestModelRegistry = new ModelRegistry(await ModelRuntime.create({
	allowModelNetwork: false,
	credentials: new InMemoryCredentialStore(),
	modelsPath: null,
}));

function getSharedTestModelRegistry(): ModelRegistry {
	return sharedTestModelRegistry;
}

export function createDefaultSystemPromptOptions(cwd: string): NormalizedBuildSystemPromptOptions {
	return {
		cwd,
		selectedTools: ["read", "bash", "edit", "write"],
		toolSnippets: {},
		toolGuidelines: {},
		promptGuidelines: [],
		appendSystemPrompt: "",
		sections: {},
		contextFiles: [],
		skills: [],
	};
}

function createMinimalSessionManager(cwd: string, overrides: Partial<ExtensionContext["sessionManager"]> = {}): ExtensionContext["sessionManager"] {
	// Return-type checking supports the official and fork fixture superset.
	const sessionManager = {
		getCwd: vi.fn(() => cwd),
		getSessionDir: vi.fn(() => ""),
		getSessionId: vi.fn(() => "test-session"),
		getSessionFile: vi.fn(() => undefined),
		getLeafId: vi.fn(() => null),
		getLeafEntry: vi.fn(() => undefined),
		getEntry: vi.fn(() => undefined),
		getLabel: vi.fn(() => undefined),
		getBranch: vi.fn(() => []),
		buildContextEntries: vi.fn(() => []),
		getHeader: vi.fn(() => null),
		getEntries: vi.fn(() => []),
		getEntriesRevision: vi.fn(() => 0),
		getTree: vi.fn(() => []),
		getSessionName: vi.fn(() => undefined),
		...overrides,
	};
	return sessionManager;
}

function createMinimalExtensionUi(): ExtensionContext["ui"] {
	return {
		select: vi.fn(async () => undefined),
		confirm: vi.fn(async () => false),
		input: vi.fn(async () => undefined),
		notify: vi.fn(),
		onTerminalInput: vi.fn(() => () => {}),
		setStatus: vi.fn(),
		setWorkingMessage: vi.fn(),
		setWorkingVisible: vi.fn(),
		setWorkingIndicator: vi.fn(),
		setHiddenThinkingLabel: vi.fn(),
		setWidget: vi.fn(),
		setFooter: vi.fn(),
		setHeader: vi.fn(),
		setTitle: vi.fn(),
		custom: vi.fn(<T>() => Promise.resolve(undefined as T)) as ExtensionContext["ui"]["custom"],
		pasteToEditor: vi.fn(),
		setEditorText: vi.fn(),
		getEditorText: vi.fn(() => ""),
		editor: vi.fn(async () => undefined),
		addAutocompleteProvider: vi.fn(),
		setEditorComponent: vi.fn(),
		getEditorComponent: vi.fn(() => undefined),
		theme: {} as ExtensionContext["ui"]["theme"],
		getAllThemes: vi.fn(() => []),
		getTheme: vi.fn(() => undefined),
		setTheme: vi.fn(() => ({ success: true })),
		getToolsExpanded: vi.fn(() => false),
		setToolsExpanded: vi.fn(),
	} satisfies ExtensionContext["ui"];
}

function createMinimalExtensionContextInternal(overrides: ExtensionContextOverrides = {}): ExtensionContext {
	const cwd = overrides.cwd ?? process.cwd();
	const base = {
		ui: createMinimalExtensionUi(),
		mode: "tui" as const,
		hasUI: true,
		cwd,
		sessionManager: createMinimalSessionManager(cwd, overrides.sessionManager),
		modelRegistry: getSharedTestModelRegistry(),
		model: makeModel("composer-2.5"),
		scopedModels: [],
		isIdle: vi.fn(() => true),
		isBashRunning: vi.fn(() => false),
		isProjectTrusted: vi.fn(() => true),
		signal: undefined,
		abort: vi.fn(),
		hasPendingMessages: vi.fn(() => false),
		hasPendingSteeringMessages: vi.fn(() => false),
		getPendingNextTurnCount: vi.fn(() => 0),
		getPendingInputCount: vi.fn(() => 0),
		shutdown: vi.fn(),
		getContextUsage: vi.fn(() => undefined),
		getCompactionSettings: vi.fn(() => ({ ...DEFAULT_COMPACTION_SETTINGS })),
		newContext: vi.fn(),
		compact: vi.fn(),
		getSystemPrompt: vi.fn(() => ""),
	};
	return {
		...base,
		...overrides,
		ui: {
			...base.ui,
			...overrides.ui,
		},
		sessionManager: {
			...base.sessionManager,
			...overrides.sessionManager,
		},
	};
}

function createMinimalExtensionCommandContextInternal(
	overrides: ExtensionCommandContextOverrides = {},
): ExtensionCommandContext {
	const base = createMinimalExtensionContextInternal(overrides) as ExtensionCommandContext;
	return {
		...base,
		...overrides,
		getSystemPromptOptions:
			overrides.getSystemPromptOptions ?? vi.fn(() => createDefaultSystemPromptOptions(base.cwd)),
		waitForIdle: overrides.waitForIdle ?? vi.fn(async () => undefined),
		newSession: overrides.newSession ?? vi.fn(async () => ({ cancelled: false })),
		fork: overrides.fork ?? vi.fn(async () => ({ cancelled: false })),
		navigateTree: overrides.navigateTree ?? vi.fn(async () => ({ cancelled: false })),
		switchSession: overrides.switchSession ?? vi.fn(async () => ({ cancelled: false })),
		reload: overrides.reload ?? vi.fn(async () => undefined),
		ui: {
			...base.ui,
			...overrides.ui,
		},
		sessionManager: {
			...base.sessionManager,
			...overrides.sessionManager,
		},
	};
}

export function createExtensionTestContext(ctxOverrides: ExtensionContextOverrides = {}): ExtensionContext {
	return createMinimalExtensionContextInternal(ctxOverrides);
}

export function createExtensionCommandContext(
	ctxOverrides: ExtensionCommandContextOverrides = {},
): ExtensionCommandContext {
	return createMinimalExtensionCommandContextInternal(ctxOverrides);
}

export function makeContext(messages: Context["messages"] = [{ role: "user", content: "Hello", timestamp: 1 }]): Context {
	return {
		systemPrompt: "Be helpful.",
		messages,
	};
}

export function makeAssistantMessage(text = "Done", timestamp = 2): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "cursor-sdk",
		provider: "cursor",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

export async function collectEvents<TEvent>(stream: AsyncIterable<TEvent>): Promise<TEvent[]> {
	const events: TEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

export async function collectAssistantEvents(
	stream: AsyncIterable<AssistantMessageEvent>,
): Promise<AssistantMessageEvent[]> {
	return collectEvents(stream);
}
