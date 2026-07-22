import { vi } from "vitest";
import type { ExtensionAPI, ProviderConfig, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { CursorNativeToolDisplayExtensionApi } from "../../src/cursor-native-tool-display-registration.js";
import type cursorExtensionFactory from "../../src/index.js";
import { createExtensionCommandContext } from "./context-fixtures.js";
import { createHarnessEventApi } from "./event-harness.js";
import {
	DEFAULT_ACTIVE_TOOL_NAMES,
	DEFAULT_BUILTIN_TOOL_NAMES,
	createBuiltinToolInfo,
} from "./tool-fixtures.js";
import type {
	BridgePiHarness,
	ExtensionCommandContextOverrides,
	PiHarness,
	PiHarnessOptions,
	RegisteredCommandOptions,
	RegisteredTool,
} from "./pi-harness-types.js";

/** Pi harness surface accepted by `src/index.ts` extension factory registration. */
export type CursorExtensionRegistrationPi = Parameters<typeof cursorExtensionFactory>[0];

export function createBridgePiHarness(options: { active: string[]; tools: ToolInfo[] }): BridgePiHarness {
	const eventApi = createHarnessEventApi();
	return {
		...eventApi,
		getActiveTools: vi.fn<ExtensionAPI["getActiveTools"]>(() => [...options.active]),
		getAllTools: vi.fn<ExtensionAPI["getAllTools"]>(() => [...options.tools]),
		setActiveTools: vi.fn<ExtensionAPI["setActiveTools"]>(),
	};
}

/** Canonical configurable fake pi surface for extension, provider, and session tests. */
export function createPiHarness(options: PiHarnessOptions = {}): PiHarness {
	const eventApi = createHarnessEventApi();
	const registered: Array<{ name: string; config: ProviderConfig }> = [];
	const commands = new Map<string, RegisteredCommandOptions>();
	const tools: RegisteredTool[] = [];
	const initialTools =
		options.initialTools ?? [...DEFAULT_BUILTIN_TOOL_NAMES].map((name) => createBuiltinToolInfo(name));
	let activeToolNames = [...(options.activeTools ?? DEFAULT_ACTIVE_TOOL_NAMES)];

	const resolveFlagValue = (name: string): boolean | string | undefined => {
		if (Object.prototype.hasOwnProperty.call(options.flagValues ?? {}, name)) {
			return options.flagValues?.[name];
		}
		return options.defaultFlagValue ?? false;
	};

	const runCommand = async (
		name: string,
		args = "",
		ctxOverrides: ExtensionCommandContextOverrides = {},
	): Promise<void> => {
		const command = commands.get(name);
		if (!command) {
			throw new Error(`Command not registered: ${name}`);
		}
		await command.handler(args, createExtensionCommandContext(ctxOverrides));
	};

	const registerTool = vi.fn<ExtensionAPI["registerTool"]>((tool) => {
		tools.push(tool as RegisteredTool);
	}) as PiHarness["registerTool"];

	const eventsEmitted: Array<{ channel: string; data: unknown }> = [];
	const events: ExtensionAPI["events"] = {
		emit: vi.fn((channel: string, data: unknown) => {
			eventsEmitted.push({ channel, data });
		}),
		on: vi.fn(() => () => {}),
	};

	return {
		...eventApi,
		registerProvider: vi.fn<ExtensionAPI["registerProvider"]>((name: string, config: ProviderConfig) => {
			registered.push({ name, config });
		}),
		registerFlag: vi.fn<ExtensionAPI["registerFlag"]>(),
		registerCommand: vi.fn<ExtensionAPI["registerCommand"]>((name: string, command) => {
			commands.set(name, command);
		}),
		registerTool,
		getAllTools: vi.fn<ExtensionAPI["getAllTools"]>(() => {
			const toolsByName = new Map<string, ToolInfo>();
			for (const tool of initialTools) toolsByName.set(tool.name, tool);
			for (const tool of tools) {
				toolsByName.set(tool.name, {
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters,
					sourceInfo: { source: "test", path: "pi-cursor-sdk-test", scope: "temporary", origin: "top-level" },
				});
			}
			return [...toolsByName.values()];
		}),
		getActiveTools: vi.fn<ExtensionAPI["getActiveTools"]>(() => [...activeToolNames]),
		setActiveTools: vi.fn<ExtensionAPI["setActiveTools"]>((toolNames: string[]) => {
			activeToolNames = [...toolNames];
		}),
		sendMessage: vi.fn<ExtensionAPI["sendMessage"]>(),
		getFlag: vi.fn<ExtensionAPI["getFlag"]>((name: string) => resolveFlagValue(name)),
		appendEntry: vi.fn<ExtensionAPI["appendEntry"]>(),
		events,
		_eventsEmitted: eventsEmitted,
		runCommand,
		_registered: registered,
		_commands: commands,
		_tools: tools,
		_activeToolNames: () => [...activeToolNames],
	};
}

export function createExtensionRegistrationPi(
	options: PiHarnessOptions = {},
): PiHarness & CursorExtensionRegistrationPi {
	const harness = createPiHarness(options);
	return harness;
}

export type { CursorNativeToolDisplayExtensionApi };
