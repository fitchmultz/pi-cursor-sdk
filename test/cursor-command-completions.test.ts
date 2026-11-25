import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CombinedAutocompleteProvider, type AutocompleteItem, type SlashCommand } from "@earendil-works/pi-tui";
import { createExtensionPi, resetIndexExtensionTestState } from "./helpers/index-extension-test-kit.js";

vi.mock("../src/model-discovery.js", () => ({
	discoverModels: vi.fn(),
	getCursorModelMetadata: vi.fn(),
	replaceCursorModelMetadata: vi.fn(),
}));

import extensionFactory from "../src/index.js";
import { discoverModels } from "../src/model-discovery.js";

const mockedDiscover = vi.mocked(discoverModels);
const SAMPLE_CLOUD_AGENT_ID = "bc-00000000-0000-0000-0000-000000000001";

async function registerExtensionCommands() {
	mockedDiscover.mockResolvedValueOnce([]);
	const pi = createExtensionPi();
	await extensionFactory(pi);
	return pi._commands;
}

function getCompletions(
	commands: Awaited<ReturnType<typeof registerExtensionCommands>>,
	name: string,
	prefix: string,
): AutocompleteItem[] | null {
	const command = commands.get(name);
	if (!command?.getArgumentCompletions) {
		throw new Error(`Expected getArgumentCompletions on /${name}`);
	}
	const result = command.getArgumentCompletions(prefix);
	if (result instanceof Promise) {
		throw new Error(`Expected synchronous completions on /${name}`);
	}
	return result;
}

describe("Cursor slash-command argument completions", () => {
	beforeEach(async () => {
		await resetIndexExtensionTestState();
	});

	afterEach(resetIndexExtensionTestState);

	it("registers getArgumentCompletions only on fixed-option commands", async () => {
		const commands = await registerExtensionCommands();
		const withCompletions = [...commands.entries()]
			.filter(([, cmd]) => typeof cmd.getArgumentCompletions === "function")
			.map(([name]) => name)
			.sort();
		const withoutCompletions = [...commands.entries()]
			.filter(([, cmd]) => cmd.getArgumentCompletions === undefined)
			.map(([name]) => name)
			.sort();

		expect(withCompletions).toEqual([
			"cursor-cloud",
			"cursor-http",
			"cursor-local-resume-cleanup",
			"cursor-mode",
			"cursor-runtime",
			"cursor-usage",
		]);
		expect(withoutCompletions).toEqual([
			"cursor-abort",
			"cursor-fast",
			"cursor-refresh-config",
			"cursor-refresh-models",
			"cursor-tools",
		]);
	});

	it("completes /cursor-http options and rejects unknown or extra tokens", async () => {
		const commands = await registerExtensionCommands();
		const all = getCompletions(commands, "cursor-http", "");
		expect(all?.map((item) => item.value)).toEqual(["on", "off", "toggle"]);
		expect(all?.every((item) => Boolean(item.description))).toBe(true);
		expect(getCompletions(commands, "cursor-http", "o")?.map((item) => item.value)).toEqual(["on", "off"]);
		expect(getCompletions(commands, "cursor-http", "T")?.map((item) => item.value)).toEqual(["toggle"]);
		expect(getCompletions(commands, "cursor-http", "on ")).toBeNull();
		expect(getCompletions(commands, "cursor-http", "on off")).toBeNull();
		expect(getCompletions(commands, "cursor-http", "maybe")).toBeNull();
	});

	it("completes /cursor-mode options and rejects unknown or extra tokens", async () => {
		const commands = await registerExtensionCommands();
		const all = getCompletions(commands, "cursor-mode", "");
		expect(all?.map((item) => item.value)).toEqual(["agent", "plan"]);
		expect(all?.every((item) => Boolean(item.description))).toBe(true);
		expect(getCompletions(commands, "cursor-mode", "p")?.map((item) => item.value)).toEqual(["plan"]);
		expect(getCompletions(commands, "cursor-mode", "A")?.map((item) => item.value)).toEqual(["agent"]);
		expect(getCompletions(commands, "cursor-mode", "agent ")).toBeNull();
		expect(getCompletions(commands, "cursor-mode", "ask")).toBeNull();
	});

	it("completes /cursor-local-resume-cleanup flags and rejects unknown or extra tokens", async () => {
		const commands = await registerExtensionCommands();
		const all = getCompletions(commands, "cursor-local-resume-cleanup", "");
		expect(all?.map((item) => item.value)).toEqual(["--dry-run", "--yes"]);
		expect(all?.every((item) => Boolean(item.description))).toBe(true);
		expect(getCompletions(commands, "cursor-local-resume-cleanup", "--d")?.map((item) => item.value)).toEqual(["--dry-run"]);
		expect(getCompletions(commands, "cursor-local-resume-cleanup", "--y")?.map((item) => item.value)).toEqual(["--yes"]);
		expect(getCompletions(commands, "cursor-local-resume-cleanup", "--yes ")).toBeNull();
		expect(getCompletions(commands, "cursor-local-resume-cleanup", "--force")).toBeNull();
	});

	it("completes /cursor-runtime runtime options and second-token save flags", async () => {
		const commands = await registerExtensionCommands();
		const first = getCompletions(commands, "cursor-runtime", "");
		expect(first?.map((item) => item.value)).toEqual(["local", "cloud"]);
		expect(first?.every((item) => Boolean(item.description))).toBe(true);
		expect(getCompletions(commands, "cursor-runtime", "c")?.map((item) => item.value)).toEqual(["cloud"]);
		expect(getCompletions(commands, "cursor-runtime", "remote")).toBeNull();

		const second = getCompletions(commands, "cursor-runtime", "local ");
		expect(second?.map((item) => ({ value: item.value, label: item.label }))).toEqual([
			{ value: "local --save-user", label: "--save-user" },
			{ value: "local --save-project", label: "--save-project" },
		]);
		expect(second?.every((item) => Boolean(item.description))).toBe(true);
		expect(getCompletions(commands, "cursor-runtime", "cloud --save-p")?.map((item) => item.value)).toEqual([
			"cloud --save-project",
		]);
		expect(getCompletions(commands, "cursor-runtime", "invalid --save-")).toBeNull();
		expect(getCompletions(commands, "cursor-runtime", "local --save-user ")).toBeNull();
		expect(getCompletions(commands, "cursor-runtime", "local --save-user --save-project")).toBeNull();
	});

	it("completes /cursor-cloud subcommands and --yes after a valid delete agent ID", async () => {
		const commands = await registerExtensionCommands();
		const first = getCompletions(commands, "cursor-cloud", "");
		expect(first?.map((item) => ({ value: item.value, label: item.label }))).toEqual([
			{ value: "list", label: "list" },
			{ value: "archive ", label: "archive" },
			{ value: "delete ", label: "delete" },
		]);
		expect(first?.every((item) => Boolean(item.description))).toBe(true);
		expect(getCompletions(commands, "cursor-cloud", "ar")?.map((item) => item.value)).toEqual(["archive "]);
		expect(getCompletions(commands, "cursor-cloud", "list ")).toBeNull();
		expect(getCompletions(commands, "cursor-cloud", "archive ")).toBeNull();
		expect(getCompletions(commands, "cursor-cloud", "delete ")).toBeNull();
		expect(getCompletions(commands, "cursor-cloud", `delete ${SAMPLE_CLOUD_AGENT_ID}`)).toBeNull();

		const confirm = getCompletions(commands, "cursor-cloud", `delete ${SAMPLE_CLOUD_AGENT_ID} --y`);
		expect(confirm?.map((item) => ({ value: item.value, label: item.label }))).toEqual([
			{ value: `delete ${SAMPLE_CLOUD_AGENT_ID} --yes`, label: "--yes" },
		]);
		expect(confirm?.[0]?.description).toBeTruthy();
		expect(getCompletions(commands, "cursor-cloud", `delete ${SAMPLE_CLOUD_AGENT_ID} `)?.map((item) => item.value)).toEqual([
			`delete ${SAMPLE_CLOUD_AGENT_ID} --yes`,
		]);
		expect(getCompletions(commands, "cursor-cloud", "delete not-an-agent-id --")).toBeNull();
		expect(getCompletions(commands, "cursor-cloud", `delete ${SAMPLE_CLOUD_AGENT_ID} --yes `)).toBeNull();
		expect(getCompletions(commands, "cursor-cloud", "status")).toBeNull();
	});

	it("completes /cursor-usage subcommands and rejects dynamic paths or unknown tokens", async () => {
		const commands = await registerExtensionCommands();
		const all = getCompletions(commands, "cursor-usage", "");
		expect(all?.map((item) => ({ value: item.value, label: item.label }))).toEqual([
			{ value: "refresh", label: "refresh" },
			{ value: "export ", label: "export" },
			{ value: "help", label: "help" },
		]);
		expect(all?.every((item) => Boolean(item.description))).toBe(true);
		expect(getCompletions(commands, "cursor-usage", "ex")?.map((item) => item.value)).toEqual(["export "]);
		expect(getCompletions(commands, "cursor-usage", "refresh ")).toBeNull();
		expect(getCompletions(commands, "cursor-usage", "export ")).toBeNull();
		expect(getCompletions(commands, "cursor-usage", "export usage.json")).toBeNull();
		expect(getCompletions(commands, "cursor-usage", "unknown")).toBeNull();
	});

	it("applies completions cleanly through Pi CombinedAutocompleteProvider", async () => {
		const commands = await registerExtensionCommands();
		const slashCommands: SlashCommand[] = [...commands.entries()].map(([name, cmd]) => ({
			name,
			description: cmd.description,
			getArgumentCompletions: cmd.getArgumentCompletions,
		}));
		const provider = new CombinedAutocompleteProvider(slashCommands, process.cwd());
		const signal = new AbortController().signal;

		const cases: Array<{ line: string; expectedLine: string }> = [
			{ line: "/cursor-http o", expectedLine: "/cursor-http on" },
			{ line: "/cursor-runtime local --save-u", expectedLine: "/cursor-runtime local --save-user" },
			{ line: "/cursor-cloud ar", expectedLine: "/cursor-cloud archive " },
			{
				line: `/cursor-cloud delete ${SAMPLE_CLOUD_AGENT_ID} --`,
				expectedLine: `/cursor-cloud delete ${SAMPLE_CLOUD_AGENT_ID} --yes`,
			},
			{ line: "/cursor-usage ex", expectedLine: "/cursor-usage export " },
		];

		for (const testCase of cases) {
			const suggestions = await provider.getSuggestions([testCase.line], 0, testCase.line.length, { signal });
			expect(suggestions, testCase.line).not.toBeNull();
			const applied = provider.applyCompletion(
				[testCase.line],
				0,
				testCase.line.length,
				suggestions!.items[0]!,
				suggestions!.prefix,
			);
			expect(applied.lines[0]).toBe(testCase.expectedLine);
			expect(applied.cursorCol).toBe(testCase.expectedLine.length);
		}
	});
});
