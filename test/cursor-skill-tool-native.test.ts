import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	SessionManager,
	SettingsManager,
	type Skill,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { registerCursorSkillTool } from "../src/cursor-skill-tool.js";
import { computeCursorContextFingerprint } from "../src/context.js";
import { planCursorSessionSend } from "../src/cursor-session-send-policy.js";
import { makeAssistantMessage } from "./helpers/pi-harness.js";

it("keeps native Pi prompts stable after lazy skill activation without losing the skill tool", async () => {
	const root = await mkdtemp(join(tmpdir(), "cursor-skill-native-"));
	const filePath = join(root, "SKILL.md");
	await writeFile(filePath, "---\nname: proof\ndescription: Proof skill\n---\nFollow the proof skill instructions.\n");
	const skill: Skill = {
		name: "proof",
		description: "Proof skill",
		filePath,
		baseDir: root,
		disableModelInvocation: false,
		sourceInfo: { path: filePath, source: "test", scope: "user", origin: "top-level" },
	};
	const captured: Context[] = [];
	const services = await createAgentSessionServices({
		cwd: root,
		agentDir: join(root, "agent"),
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
		resourceLoaderOptions: {
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [registerCursorSkillTool],
			skillsOverride: () => ({ skills: [skill], diagnostics: [] }),
		},
	});
	services.modelRuntime.registerProvider("cursor", {
		name: "Cursor native contract test",
		baseUrl: "https://example.invalid",
		apiKey: "unused-test-key",
		api: "cursor-sdk",
		models: [{
			id: "proof", name: "Proof", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 256000, maxTokens: 32000,
		}],
		streamSimple(model, context) {
			captured.push({ ...context, messages: structuredClone(context.messages) });
			const activate = captured.length === 1;
			const reason = activate ? "toolUse" : "stop";
			const message: AssistantMessage = {
				...makeAssistantMessage(), api: model.api, provider: model.provider, model: model.id,
				content: activate
					? [{ type: "toolCall", id: "activate-proof", name: "cursor_activate_skill", arguments: { name: "proof" } }]
					: [{ type: "text", text: "OK" }],
				stopReason: reason,
			};
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason, message });
				stream.end();
			});
			return stream;
		},
	});
	const { session } = await createAgentSessionFromServices({
		services, sessionManager: SessionManager.inMemory(root), model: services.modelRuntime.getModel("cursor", "proof"),
	});
	try {
		await session.bindExtensions({ mode: "json" });
		await session.prompt("Use the proof skill.");
		await session.prompt("Follow up.");
		expect(captured, JSON.stringify(session.messages)).toHaveLength(3);
		const activation = captured[1].messages.find((message) => message.role === "toolResult");
		expect(activation).toMatchObject({ toolName: "cursor_activate_skill", isError: false });
		const content = activation?.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
		expect(content).toContain("Follow the proof skill instructions.");
		expect(content).toContain(`Skill directory: ${root}`);
		expect(captured[0].tools?.find((tool) => tool.name === "cursor_activate_skill")?.description).toContain("Load full pi Agent Skill instructions");
		expect(captured[0].systemPrompt).toContain("call pi__cursor_activate_skill with the skill name");
		expect(captured[2].systemPrompt).toBe(captured[0].systemPrompt);
		expect(planCursorSessionSend({
			bootstrapped: true, incrementalSendCount: 0,
			contextFingerprint: computeCursorContextFingerprint(captured[0]),
		}, captured[2])).toMatchObject({ mode: "incremental", resetAgent: false });
	} finally {
		session.dispose();
		await rm(root, { recursive: true, force: true });
	}
}, 15000);
