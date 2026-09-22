import { LOCAL_RESUME_SUITES } from "./local-resume-suites.mjs";

/**
 * Scenario definitions for all required platform smoke suites.
 *
 * Each scenario defines the prompt template, environment, command rendering,
 * required artifacts, and assertion contracts.
 *
 * Platform rendering: posix (macOS/Ubuntu) or powershell (Windows native).
 */

export const SCENARIOS = {
	"platform-build": {
		description: "Build, test, typecheck, pack, and install the extension without Cursor calls.",
		cursorCalls: 0,
		commands: {
			npmCi: { posix: "npm ci", powershell: "npm ci" },
			npmTest: { posix: "npm test", powershell: "npm test" },
			npmTypecheck: { posix: "npm run typecheck", powershell: "npm run typecheck" },
			npmPack: { posix: "npm pack", powershell: "npm pack" },
		},
	},

	...Object.fromEntries(LOCAL_RESUME_SUITES.map(({ suite, description, cursorCalls }) => [suite, { description, cursorCalls }])),

	"cursor-native-visual-matrix": {
		description: "Prove provider reality, native tool replay, card rendering, JSONL correctness.",
		cursorCalls: 1,
		env: {
			PI_CURSOR_SETTING_SOURCES: "none",
			PI_CURSOR_NATIVE_TOOL_DISPLAY: "1",
			PI_CURSOR_REGISTER_NATIVE_TOOLS: "1",
			PI_CURSOR_PI_TOOL_BRIDGE: "0",
			PI_CURSOR_EXPOSE_BUILTIN_TOOLS: "0",
			PI_CURSOR_SDK_EVENT_DEBUG: "1",
		},
		commands: {
			shellSmoke: {
				posix: "printf 'cursor visual smoke\\n'",
				powershell: "Write-Output 'cursor visual smoke'",
			},
			shellFailure: {
				posix: "sh -c 'echo native shell failure >&2; exit 7'",
				powershell: "Write-Error 'native shell failure'; exit 7",
			},
		},
		promptTemplate: `Native visual matrix.

Use Cursor-native tools only. Do not use pi__ tools.
On Windows/PowerShell shell commands, do not use &&; if you add a cd command, separate commands with a semicolon (;).

Steps:
1. read ./package.json and remember the package name.
2. grep ./README.md for "pi-cursor-sdk".
3. find README.md from repo root.
4. find src/cursor-provider.ts from repo root; this is the list=<yes/no> evidence.
5. run shell: {{shellSmoke}}
6. write .debug/platform-smoke/native.txt with alpha and beta.
7. edit beta to gamma in that file.
8. run shell and preserve the failure: {{shellFailure}}
9. stop using tools and answer exactly:
NATIVE_MATRIX_OK package=<name> grep=<yes/no> find=<yes/no> list=<yes/no> shell=<yes/no> shell_fail=<yes/no> write=<yes/no> edit=<yes/no>`,
		finalMarker: "NATIVE_MATRIX_OK package=pi-cursor-sdk",
		requiredCards: [
			"read", "grep", "find", "shell-success", "write", "edit-diff", "shell-failure", "footer-status",
		],
		requiredJSONLTools: [
			{ name: "read" },
			{ name: "grep" },
			{ name: "find" },
			{ name: "bash" },
			{ name: "cursor" },
			{ name: "edit" },
		],
		requiredJSONLResults: [
			{ id: "native-read-package", toolName: "read", isError: false, contains: "pi-cursor-sdk" },
			{ id: "native-grep-readme", toolName: "grep", isError: false, contains: "README.md" },
			{ id: "native-find-readme", toolName: "find", isError: false, contains: "README.md" },
			{ id: "native-list-src", toolName: "find", isError: false, contains: "cursor-provider.ts" },
			{ id: "native-shell-output", toolName: "bash", isError: false, contains: "cursor visual smoke" },
			{ id: "native-write-diff", toolName: "cursor", sourceToolName: "edit", isError: false, contains: "+beta" },
			{ id: "native-edit-diff", toolName: "cursor", sourceToolName: "edit", isError: false, contains: "+gamma" },
			{ id: "native-shell-failure", toolName: "bash", isError: true, contains: "native shell failure" },
		],
		visualEvidence: [
			{
				id: "native-read-package",
				pattern: "^\\s*read\\s+(?:(?:\\./)?package\\.json|.*[\\\\/]package\\.json)(?:\\s+·\\s+local file preview)?\\s*$",
				wrappedPattern: "^\\s*read\\s+.*[\\\\/]package\\.(?:json|js\\s+on|j\\s*son)(?:\\s+·\\s+local file preview)?\\s*$",
				jsonlResultId: "native-read-package",
			},
			{ id: "native-shell-success", pattern: "^\\s*cursor visual smoke\\s*$", jsonlResultId: "native-shell-output" },
			{ id: "native-write-diff", pattern: "^\\s*\\+.*beta", jsonlResultId: "native-write-diff" },
			{ id: "native-edit-diff", pattern: "^\\s*\\+.*gamma", jsonlResultId: "native-edit-diff" },
			{ id: "native-shell-failure", pattern: "^\\s*native shell failure\\s*$|^\\s*Command exited with code 7\\s*$", jsonlResultId: "native-shell-failure" },
		],
	},

	"cursor-store-root-live": {
		description: "Prove persisted session SQLite relocates under PI_CURSOR_SDK_STATE_ROOT instead of ~/.cursor/projects.",
		cursorCalls: 1,
		storeRootRelative: ".platform-smoke/custom-store-root",
		env: {
			PI_CURSOR_SETTING_SOURCES: "none",
			PI_CURSOR_NATIVE_TOOL_DISPLAY: "0",
			PI_CURSOR_REGISTER_NATIVE_TOOLS: "0",
			PI_CURSOR_PI_TOOL_BRIDGE: "0",
			PI_CURSOR_EXPOSE_BUILTIN_TOOLS: "0",
			PI_CURSOR_SDK_EVENT_DEBUG: "1",
		},
		promptTemplate: "Join STORE, ROOT, and OK with underscores and reply with only the result.",
		finalMarker: "STORE_ROOT_OK",
		requiredCards: ["footer-status"],
	},

	"cursor-http1-live": {
		description: "Prove an opt-in HTTP/1.1/SSE local provider turn and visible transport status.",
		cursorCalls: 1,
		env: {
			PI_CURSOR_SETTING_SOURCES: "none",
			PI_CURSOR_HTTP_1_1: "1",
			PI_CURSOR_NATIVE_TOOL_DISPLAY: "1",
			PI_CURSOR_REGISTER_NATIVE_TOOLS: "1",
			PI_CURSOR_PI_TOOL_BRIDGE: "0",
			PI_CURSOR_EXPOSE_BUILTIN_TOOLS: "0",
			PI_CURSOR_SDK_EVENT_DEBUG: "1",
		},
		promptTemplate: "Join HTTP1, LIVE, and OK with underscores and reply with only the result.",
		finalMarker: "HTTP1_LIVE_OK",
		requiredCards: ["http1-status"],
	},

	"cursor-bridge-visual-matrix": {
		description: "Prove pi bridge routing, bridge tool cards, diagnostics, real pi tool names.",
		cursorCalls: 1,
		env: {
			PI_CURSOR_SETTING_SOURCES: "none",
			PI_CURSOR_NATIVE_TOOL_DISPLAY: "1",
			PI_CURSOR_REGISTER_NATIVE_TOOLS: "1",
			PI_CURSOR_PI_TOOL_BRIDGE: "1",
			PI_CURSOR_EXPOSE_BUILTIN_TOOLS: "1",
			PI_CURSOR_PI_TOOL_BRIDGE_DEBUG: "1",
			PI_CURSOR_SDK_EVENT_DEBUG: "1",
		},
		commands: {
			shellSmoke: {
				posix: "node -e \"console.log('bridge visual smoke')\"",
				powershell: "node -e \"console.log('bridge visual smoke')\"",
			},
		},
		promptTemplate: `Bridge visual matrix.

Use pi bridge tools only. Use exact pi__ names.

You must make exactly three pi bridge tool calls before your final answer: pi__bash, pi__read, then pi__read. Do not answer until all three calls complete.

Steps:
1. call pi__bash with command: {{shellSmoke}}
2. call pi__read on ./package.json.
3. call pi__read on ./definitely-missing-platform-smoke-file.txt.
4. answer exactly:
BRIDGE_MATRIX_OK bash_ok=<yes/no> read_ok=<yes/no> read_missing_error=<yes/no>`,
		finalMarker: "BRIDGE_MATRIX_OK bash_ok=yes",
		requiredCards: [
			"bridge-read-success", "bridge-read-failure",
			"bridge-shell-success", "footer-status",
		],
		requiredJSONLTools: [
			{ name: "read" },
			{ name: "bash" },
		],
		requiredJSONLResults: [
			{ id: "bridge-read-success", toolName: "read", isError: false, contains: "pi-cursor-sdk" },
			{ id: "bridge-read-failure", toolName: "read", isError: true, contains: "definitely-missing-platform-smoke-file.txt" },
			{ id: "bridge-shell-success", toolName: "bash", isError: false, contains: "bridge visual smoke" },
		],
		expectedJSONLResultToolOrder: ["bash", "read", "read"],
		visualEvidence: [
			{
				id: "bridge-read-success",
				pattern: "^\\s*read\\s+(?:\\./package\\.json|.*[\\\\/]package\\.j(?:son|s))\\s*$",
				wrappedPattern: "^\\s*read\\s+.*[\\\\/]package\\.(?:json|js\\s+on|j\\s*son)\\s*$",
				jsonlResultId: "bridge-read-success",
			},
			{ id: "bridge-read-failure", pattern: "^\\s*read \\./definitely-missing-platform-smoke-file\\.txt|ENOENT: no such file", jsonlResultId: "bridge-read-failure" },
			{ id: "bridge-shell-success", pattern: "^\\s*bridge visual smoke\\s*$", jsonlResultId: "bridge-shell-success" },
		],
		requiredBridgeDiagnostics: true,
	},

	"cursor-abort-cleanup": {
		description: "Prove long-running bridge cancellation with no orphan processes.",
		cursorCalls: 1,
		env: {
			PI_CURSOR_SETTING_SOURCES: "none",
			PI_CURSOR_NATIVE_TOOL_DISPLAY: "1",
			PI_CURSOR_REGISTER_NATIVE_TOOLS: "1",
			PI_CURSOR_PI_TOOL_BRIDGE: "1",
			PI_CURSOR_EXPOSE_BUILTIN_TOOLS: "1",
			PI_CURSOR_PI_TOOL_BRIDGE_DEBUG: "1",
			PI_CURSOR_SDK_EVENT_DEBUG: "1",
		},
		commands: {
			longRunning: {
				posix: "node -e \"const fs=require('fs');fs.mkdirSync('.debug/platform-smoke',{recursive:true});fs.writeFileSync('.debug/platform-smoke/abort-started.txt',String(process.pid));setTimeout(() => console.log(process.env.PLATFORM_ABORT_MARKER), 30000)\"",
				powershell: "node -e \"const fs=require('fs');fs.mkdirSync('.debug/platform-smoke',{recursive:true});fs.writeFileSync('.debug/platform-smoke/abort-started.txt',String(process.pid));setTimeout(() => console.log(process.env.PLATFORM_ABORT_MARKER), 30000)\"",
			},
		},
		promptTemplate: `Abort cleanup matrix.

Call pi__bash with command:
{{longRunning}}

Do not answer until the tool completes.`,
		finalMarker: null, // Should NOT succeed — harness interrupts
		visualEvidence: [
			{ id: "abort-long-running-shell", pattern: "^\\s*Elapsed [1-9](?:\\.\\d)?s\\s*$" },
		],
		requiredBridgeDiagnostics: "abort",
	},
};

export function getScenario(name) {
	return SCENARIOS[name] ?? null;
}

export function renderPrompt(scenario, platform) {
	let prompt = scenario.promptTemplate;
	if (scenario.commands) {
		for (const [key, cmdMap] of Object.entries(scenario.commands)) {
			const cmd = platform === "powershell" ? (cmdMap.powershell ?? cmdMap.posix) : (cmdMap.posix ?? cmdMap.powershell);
			prompt = prompt.replaceAll(`{{${key}}}`, cmd ?? "");
		}
	}
	return prompt;
}
