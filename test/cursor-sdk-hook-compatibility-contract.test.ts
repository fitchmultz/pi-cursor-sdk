import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "@typescript/typescript6";
import { afterEach, describe, expect, it } from "vitest";
import { installedCursorModuleDeclarations, installedCursorModules } from "./helpers/cursor-sdk-installed-modules.js";

interface HookSession {
	hookExecutor: {
		executeHookForStep(step: string, input: Record<string, unknown>): Promise<Record<string, unknown> | undefined>;
	};
	dispose(): Promise<void>;
}
interface HookRuntime {
	createSessionRuntime(): HookSession;
	dispose(): Promise<void>;
}
type CreateHookRuntime = (workspace: { workingDirectory: string; projectRoot: string; workspaceRoots: string[] },
	options: { includeUserHooks: boolean; includeEnterpriseHooks: boolean; useCommandHookStdinTransport: boolean }) => Promise<HookRuntime>;

const roots: string[] = [];
afterEach(() => {
	// Local retained-workspace checks set this existing evidence flag. Do not
	// delete their original hook fixtures or containing directories.
	if (!process.env.PI_CURSOR_TEST_EVIDENCE_DIR) for (const root of roots) rmSync(root, { recursive: true, force: true });
	roots.length = 0;
});

async function hookResponse(output: Record<string, unknown>, exitCode = 0) {
	const modules = await installedCursorModules();
	const source = modules.factorySource("./src/agent/local-executor.ts");
	const { declarations } = installedCursorModuleDeclarations(source);
	const factories = [...declarations.values()].filter(node => ts.isFunctionDeclaration(node) &&
		node.getText().includes("claudeUserConfigPath") && node.getText().includes("createSessionRuntime"));
	expect(factories).toHaveLength(1);
	const factory = modules.observeFactoryBinding<CreateHookRuntime>("./src/agent/local-executor.ts", factories[0]!.name!.text);
	const base = process.env.PI_CURSOR_TEST_EVIDENCE_DIR ?? tmpdir();
	mkdirSync(base, { recursive: true });
	const root = realpathSync(mkdtempSync(join(base, "sdk-hook-contract-")));
	roots.push(root);
	mkdirSync(join(root, ".claude"));
	const command = "original π";
	const script = join(root, "hook.cjs");
	writeFileSync(script, [
		'const { readFileSync } = require("node:fs");',
		'const input = JSON.parse(readFileSync(0, "utf8"));',
		`if (input.tool_input.command !== ${JSON.stringify(command)}) throw new Error("Hook stdin was not UTF-8 JSON");`,
		`process.stdout.write(${JSON.stringify(JSON.stringify(output))});`,
		`process.exitCode = ${exitCode};`,
	].join("\n"));
	// PowerShell and POSIX shells both accept a double-quoted executable/path;
	// the installed SDK supplies the Windows invocation/transport wrapper.
	const hookCommand = `"${process.execPath.replaceAll("\\", "/")}" "${script.replaceAll("\\", "/")}"`;
	writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify({
		hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: hookCommand, timeout: 10 }] }] },
	}));
	const runtime = await factory({ workingDirectory: root, projectRoot: root, workspaceRoots: [root] }, {
		includeUserHooks: false, includeEnterpriseHooks: false, useCommandHookStdinTransport: true,
	});
	const session = runtime.createSessionRuntime();
	try {
		return await session.hookExecutor.executeHookForStep("preToolUse", {
			tool_name: "Shell", tool_input: { command }, tool_use_id: "offline-hook-contract",
		});
	} finally {
		await session.dispose();
		await runtime.dispose();
	}
}

// These execute the installed settings loader, actual command-hook child and
// output normalization, not Agent/send, inference, Pi policy or a startup canary.
// Lexical observation is test-only and never a supported production SDK API.
describe("installed SDK Claude hook output and native exit contract", () => {
	it("loads Claude settings and honors nested PreToolUse denial with UTF-8 stdin", async () => {
		const response = await hookResponse({ hookSpecificOutput: {
			hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "offline policy denied",
		} });
		expect(response).toMatchObject({ permission: "deny", user_message: "offline policy denied" });
	}, 30_000);

	it("preserves nested command rewriting without executing the rewritten tool", async () => {
		const response = await hookResponse({ hookSpecificOutput: {
			hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { command: "rewritten command" },
		} });
		expect(response).toMatchObject({ permission: "allow", updated_input: { command: "rewritten command" } });
	}, 30_000);

	it("does not interpret a mismatched nested event or overwrite an explicit top-level decision", async () => {
		const mismatch = await hookResponse({ hookSpecificOutput: { hookEventName: "PostToolUse", permissionDecision: "deny" } });
		expect(mismatch?.permission).toBeUndefined();
		const explicit = await hookResponse({ permission: "deny", hookSpecificOutput: {
			hookEventName: "PreToolUse", permissionDecision: "allow",
		} });
		expect(explicit?.permission).toBe("deny");
	}, 30_000);

	it("preserves native hook exit 2 as a denial without failClosed configuration", async () => {
		const response = await hookResponse({}, 2);
		expect(response?.permission).toBe("deny");
	}, 30_000);
});
