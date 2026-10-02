import * as ai from "@earendil-works/pi-ai";
import { convertToLlm, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import {
	asMockCursorRun, mockCreatedAgent, mockedCreate, makeModel,
	resetCursorProviderTestState, registerBridgeForProviderTest, createTestToolInfo,
	registerNativeToolDisplayForTest, type CursorDeltaHandler,
	connectMcpClient, getCreatedAgentOptions, getPiToolsMcpUrlFromAgentCreateOptions,
} from "./helpers/cursor-provider-harness.js";
import { streamCursor, __testUtils } from "../src/cursor-provider.js";
import { buildCursorPrompt, computeCursorContextFingerprint, shouldBootstrapCursorContext } from "../src/context.js";
import { getActiveContextToolNames } from "../src/cursor-context-tools.js";
import { resolveCursorPiContext } from "../src/cursor-pi-context.js";
import { getPackageDir, type BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { pathToFileURL } from "node:url";
import { resolveCursorFacingSystemPrompt } from "../src/cursor-agents-context.js";
import { resolveCursorSkillSystemPrompt } from "../src/cursor-skill-tool.js";

// Contract test of host serialization, not an extension runtime dependency.
const { buildSystemPrompt } = await import(pathToFileURL(`${getPackageDir()}/dist/core/system-prompt.js`).href) as {
	buildSystemPrompt(options: BuildSystemPromptOptions): string;
};

// Deliberately run through the installed Pi runtime, not a hand-normalized mock.
// The optional exports are absent on supported stock Pi 0.84/0.85.
const transcriptHost = "getCurrentSystemPrompt" in ai;
const tool = { name: "audit_tool", description: "Synthetic tool", parameters: Type.Object({}) };
const user = { role: "user" as const, content: "LATEST", timestamp: 1 };

async function boundary() {
	const runtime = await ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
	const registry = new ModelRegistry(runtime);
	const received: ai.Context[] = [];
	registry.registerProvider("cursor", {
		api: "cursor-sdk", baseUrl: "https://invalid.invalid", apiKey: "synthetic",
		models: [{ ...makeModel(), baseUrl: "https://invalid.invalid" }],
		streamSimple(model, context, options) {
			received.push(context);
			return streamCursor(model, context, options);
		},
	});
	const model = runtime.getModel("cursor", makeModel().id)!;
	return { received, send: (context: ai.Context) => runtime.streamSimple(model, context, { apiKey: "synthetic" }).result() };
}

function mockSend(agentId = "agent-1") {
	const send = vi.fn().mockImplementation(async () => asMockCursorRun({
		id: "run-1", agentId, status: "finished",
		wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "DONE" }),
	}));
	mockCreatedAgent({ agentId, send, listArtifacts: vi.fn().mockResolvedValue([]) });
	return send;
}

describe("installed Pi provider context boundary", () => {
	beforeEach(resetCursorProviderTestState);
	afterEach(async () => {
		await __testUtils.releaseAllPendingCursorLiveRunsForTests();
		await __testUtils.resetSessionCursorAgents();
	});

	it("preserves system instructions, tool snapshots, and incremental reuse through ModelRuntime", async () => {
		const sdkSend = mockSend();
		const { received, send } = await boundary();
		const input = { systemPrompt: "SYSTEM_SENTINEL", tools: [tool], messages: [user] };
		expect((await send(input)).stopReason).toBe("stop");
		expect(Object.keys(received[0]).sort()).toEqual(transcriptHost ? ["messages"] : ["messages", "systemPrompt", "tools"]);
		expect(sdkSend.mock.calls[0][0].text).toContain("SYSTEM_SENTINEL");
		expect(getActiveContextToolNames(received[0])).toEqual(new Set(["audit_tool"]));
		const fingerprint = computeCursorContextFingerprint(received[0]);
		expect(JSON.parse(fingerprint).messageHashes.every((hash: unknown) => typeof hash === "string")).toBe(true);
		expect(shouldBootstrapCursorContext({ bootstrapped: true, contextFingerprint: fingerprint }, received[0])).toBe(false);
		expect((await send({ ...input, messages: [user, { ...user, content: "FOLLOWUP", timestamp: 2 }] })).stopReason).toBe("stop");
		expect(mockedCreate).toHaveBeenCalledTimes(1);
		expect(sdkSend.mock.calls[1][0].text).not.toContain("SYSTEM_SENTINEL");
		expect(sdkSend.mock.calls[1][0].text).toContain("FOLLOWUP");
	});

	it("passes Pi's visible ! shell output before the next question to Cursor", async () => {
		const sdkSend = mockSend();
		const { received, send } = await boundary();
		const input = { systemPrompt: "SYSTEM", tools: [], messages: [user] };
		const firstResponse = await send(input);
		const shell = {
			role: "bashExecution" as const,
			command: "pwd",
			output: "/fixture/worktree",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: 3,
		};
		const shellText = "Ran `pwd`\n```\n/fixture/worktree\n```";
		expect(convertToLlm([shell])).toEqual([
			{ role: "user", content: [{ type: "text", text: shellText }], timestamp: shell.timestamp },
		]);

		await send({
			...input,
			messages: [user, firstResponse, shell as unknown as ai.Context["messages"][number], { ...user, content: "Where am I?", timestamp: 4 }],
		});
		expect(received[1].messages).toContainEqual(expect.objectContaining(shell));
		const text = sdkSend.mock.calls[1][0].text;
		expect(text).toContain(`User: ${shellText}`);
		expect(text).toContain("User: Where am I?");
		expect(text.indexOf(shellText)).toBeLessThan(text.indexOf("Where am I?"));
	});

	it("keeps Pi's !! shell output private and the next question incremental", async () => {
		const sdkSend = mockSend();
		const { send } = await boundary();
		const input = { systemPrompt: "SYSTEM", tools: [], messages: [user] };
		const firstResponse = await send(input);
		const shell = {
			role: "bashExecution" as const,
			command: "pwd",
			output: "/fixture/private",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			excludeFromContext: true,
			timestamp: 3,
		};
		expect(convertToLlm([shell])).toEqual([]);

		await send({
			...input,
			messages: [user, firstResponse, shell as unknown as ai.Context["messages"][number], { ...user, content: "Follow up", timestamp: 4 }],
		});
		expect(mockedCreate).toHaveBeenCalledTimes(1);
		expect(sdkSend.mock.calls[1][0].text).toContain("User: Follow up");
		expect(sdkSend.mock.calls[1][0].text).not.toContain("/fixture/private");
	});

	it("keeps the empty request snapshot distinct from the bridge's registry-owned surface", async () => {
		const sdkSend = mockSend();
		registerBridgeForProviderTest({ active: [tool.name], tools: [createTestToolInfo(tool.name, tool.parameters)] });
		const { received, send } = await boundary();
		expect((await send({ systemPrompt: "SYSTEM_SENTINEL", tools: [], messages: [user] })).stopReason).toBe("stop");
		expect(getActiveContextToolNames(received[0])).toEqual(new Set());
		// The bridge intentionally uses pi.getActiveTools/getAllTools, not the
		// provider replay allowlist (the established stock-Pi contract).
		expect(mockedCreate.mock.calls[0][0]?.mcpServers?.pi_tools).toBeDefined();
		expect(sdkSend.mock.calls[0][0].text).toContain("For exposed pi bridge tools");
	});

	it("preserves bridge filters and the callable manifest at the provider boundary", async () => {
		await registerNativeToolDisplayForTest([]);
		process.env.PI_CURSOR_TOOL_MANIFEST = "1";
		const sdkSend = mockSend();
		registerBridgeForProviderTest({ active: [tool.name, "read", "cursor"], tools: [tool.name, "read", "cursor", "inactive"].map((name) => createTestToolInfo(name, tool.parameters)) });
		const { send } = await boundary();
		expect((await send({ systemPrompt: "BRIDGE_SYSTEM", tools: [tool], messages: [user] })).stopReason).toBe("stop");
		const { client, transport } = await connectMcpClient(getPiToolsMcpUrlFromAgentCreateOptions(getCreatedAgentOptions()));
		try {
			expect((await client.listTools()).tools.map((entry) => entry.name)).toEqual(["pi__audit_tool"]);
		} finally {
			await client.close();
			await transport.close();
		}
		const text = sdkSend.mock.calls[0][0].text;
		expect(text).toContain("pi__audit_tool");
		expect(text).not.toContain("pi__read");
		expect(text).not.toContain("pi__cursor");
		expect(text).not.toContain("pi__inactive");
	});

	it("reboots when the current tool declaration changes", async () => {
		mockSend();
		const { send } = await boundary();
		const input = { systemPrompt: "SYSTEM_SENTINEL", tools: [tool], messages: [user] };
		await send(input);
		await send({ ...input, tools: [{ ...tool, description: "CHANGED" }] });
		expect(mockedCreate).toHaveBeenCalledTimes(2);
	});

	it("preserves the legacy absent-tool snapshot distinction", () => {
		expect(resolveCursorPiContext({ systemPrompt: "legacy", messages: [user] }).tools).toBeUndefined();
		expect(resolveCursorPiContext({ systemPrompt: "legacy", messages: [user], tools: [] }).tools).toEqual([]);
	});

	it.each(["fresh", "bootstrap"] as const)("preserves cloud instructions with %s history policy", async (policy) => {
		process.env.PI_CURSOR_RUNTIME = "cloud";
		process.env.PI_CURSOR_CLOUD_ACK = "1";
		process.env.PI_CURSOR_CLOUD_ALLOW_LOCAL_STATE = "1";
		process.env.PI_CURSOR_CLOUD_CONTEXT = policy;
		const sdkSend = mockSend("bc-11111111-1111-4111-8111-111111111111");
		const { send } = await boundary();
		const result = await send({ systemPrompt: "CLOUD_SYSTEM", tools: [], messages: [{ ...user, content: "HISTORY" }, { ...user, timestamp: 2 }] });
		expect(result.stopReason, result.errorMessage).toBe("stop");
		const text = sdkSend.mock.calls[0][0].text;
		expect(text).toContain("CLOUD_SYSTEM");
		expect(text.includes("HISTORY")).toBe(policy === "bootstrap");
		expect(text).toContain("LATEST");
		expect(text).not.toContain("pi__");
	});

	it("sanitizes the actual host prompt and deduplicates only overlapping context files", () => {
		const files = [{ path: "/fixture/AGENTS.md", content: "PROJECT_RULE" }, { path: "/fixture/NOTES.md", content: "KEEP_RULE" }];
		const options = { cwd: "/fixture", contextFiles: files, selectedTools: ["audit_tool"], toolSnippets: { audit_tool: "PI_ONLY_TOOL_SENTINEL" }, promptGuidelines: ["PI_ONLY_RULE_SENTINEL"] };
		const prompt = buildSystemPrompt(options);
		const local = resolveCursorFacingSystemPrompt(prompt, makeModel(), options, "project");
		expect(local).not.toContain("PROJECT_RULE");
		expect(local).toContain("KEEP_RULE");
		expect(resolveCursorFacingSystemPrompt(prompt, makeModel(), options, "none")).toBe(prompt);
		expect(resolveCursorFacingSystemPrompt(prompt, makeModel(), options, "project", undefined, "cloud")).toBe(prompt);
		const text = buildCursorPrompt({ systemPrompt: local, messages: [user] }).text;
		expect(text).not.toContain("PI_ONLY_TOOL_SENTINEL");
		expect(text).not.toContain("PI_ONLY_RULE_SENTINEL");
		expect(text).toContain("KEEP_RULE");
	});

	it("rewrites the host skill catalog once locally and removes it for cloud", () => {
		const skills = [{ name: "fixture", description: "fixture", filePath: "/fixture/SKILL.md", baseDir: "/fixture", source: "test", sourceInfo: { source: "test", path: "/fixture/SKILL.md", scope: "temporary" as const, origin: "top-level" as const }, disableModelInvocation: false }];
		const options = { cwd: "/fixture", skills };
		const prompt = buildSystemPrompt(options);
		expect(prompt).toContain("<available_skills>");
		const local = resolveCursorSkillSystemPrompt(prompt, makeModel(), options);
		expect(local.match(/<available_skills>/g)).toHaveLength(1);
		expect(local).toContain("pi__cursor_activate_skill");
		const cloud = resolveCursorSkillSystemPrompt(prompt, makeModel(), options, "cloud");
		expect(cloud).not.toContain("/fixture/SKILL.md");
		expect(cloud).not.toContain("<skills>");
	});

	it.each([true, false])("routes native replay against request tools (active=%s)", async (active) => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		await registerNativeToolDisplayForTest([]);
		const sdkSend = vi.fn().mockImplementation(async (_message: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "read", args: { path: "fixture.txt" } }, callId: "c1" } });
			opts.onDelta({ update: { type: "tool-call-completed", toolCall: { name: "read", result: { status: "success", value: { content: "RECORDED" } } }, callId: "c1" } });
			return asMockCursorRun({ id: "run-1", agentId: "agent-1", status: "finished", wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "DONE" }) });
		});
		mockCreatedAgent({ send: sdkSend });
		const { send } = await boundary();
		const input = { systemPrompt: "REPLAY_SYSTEM", tools: active ? [{ ...tool, name: "read" }] : [], messages: [user] };
		const first = await send(input);
		expect(first.stopReason, first.errorMessage).toBe(active ? "toolUse" : "stop");
		const call = first.content.find((block) => block.type === "toolCall");
		if (!active) { expect(call).toBeUndefined(); return; }
		expect(call?.name).toBe("read");
		const messages: unknown[] = [...input.messages, first, { role: "toolResult", toolCallId: call!.id, toolName: "read", content: [{ type: "text", text: "RECORDED" }], isError: false, timestamp: 3 }];
		if (transcriptHost) {
			messages.push({ role: "system", content: "", sections: { note: "NEXT" }, timestamp: 4 });
			expect(__testUtils.hasTrailingUserMessagesAfterToolResults({ messages: [...messages, user] } as ai.Context)).toBe(true);
		}
		const final = await send({ ...input, messages } as ai.Context);
		expect(final.stopReason, final.errorMessage).toBe("stop");
		expect(sdkSend).toHaveBeenCalledTimes(1);
	});

	it.skipIf(!transcriptHost)("replays sections/content and removals using the actual host helpers", async () => {
		const sdkSend = mockSend();
		const { received, send } = await boundary();
		const messages = [
			{ role: "system", content: [{ type: "text", text: "BASE" }], sections: { rule: "OLD", gone: "REMOVE" }, toolsAdded: [tool], timestamp: 0 },
			user,
			{ role: "system", content: "ADDED", sections: { rule: "CURRENT", gone: null }, toolsRemoved: [{ name: tool.name }], timestamp: 2 },
		];
		await send({ messages } as unknown as ai.Context);
		const text = sdkSend.mock.calls[0][0].text;
		expect(text).toContain("BASE\n\nADDED\n\nCURRENT");
		expect(text).not.toContain("OLD");
		expect(text).not.toContain("REMOVE");
		expect(getActiveContextToolNames(received[0])).toEqual(new Set());
		expect(buildCursorPrompt(received[0], { includePiBridgeGuidance: false, includePiAskQuestionGuidance: false }).text).toBe(text);
		const state = { bootstrapped: true, contextFingerprint: computeCursorContextFingerprint(received[0]) };
		expect(shouldBootstrapCursorContext(state, received[0])).toBe(false);
		expect(computeCursorContextFingerprint(structuredClone(received[0]))).toBe(state.contextFingerprint);
		for (const delta of [
			{ content: "CHANGED_CONTENT" },
			{ sections: { rule: "CHANGED_SECTION" } },
			{ toolsAdded: [{ ...tool, description: "CHANGED_TOOL" }] },
		]) {
			const changed = { messages: [...messages, { role: "system", content: "", timestamp: 5, ...delta }] } as unknown as ai.Context;
			expect(shouldBootstrapCursorContext(state, changed)).toBe(true);
		}
	});
});
