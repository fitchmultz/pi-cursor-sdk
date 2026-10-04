import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { registerCursorSkillTool } from "../src/cursor-skill-tool.js";
import { computeCursorContextFingerprint } from "../src/context.js";
import { planCursorSessionSend } from "../src/cursor-session-send-policy.js";
import { makeAssistantMessage } from "./helpers/pi-harness.js";

async function createSkill(root: string, name: string, instructions: string): Promise<Skill> {
	const baseDir = join(root, name);
	await mkdir(baseDir);
	const filePath = join(baseDir, "SKILL.md");
	await writeFile(filePath, `---\nname: ${name}\ndescription: Proof skill\n---\n${instructions}\n`);
	return {
		name,
		description: `${name} skill`,
		filePath,
		baseDir,
		disableModelInvocation: false,
		sourceInfo: { path: filePath, source: "test", scope: "user", origin: "top-level" },
	};
}

async function createNativeSkillSession(
	root: string,
	skills: Skill[],
	respond: (context: Context) => AssistantMessage["content"] | Promise<AssistantMessage["content"]>,
) {
	const services = await createAgentSessionServices({
		cwd: root,
		agentDir: join(root, "agent"),
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
		resourceLoaderOptions: {
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [registerCursorSkillTool],
			skillsOverride: () => ({ skills, diagnostics: [] }),
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
		}, {
			id: "alternate", name: "Alternate", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 256000, maxTokens: 32000,
		}],
		streamSimple(model, context) {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(async () => {
				const content = await respond(context);
				const reason = content.some((block) => block.type === "toolCall") ? "toolUse" : "stop";
				const message: AssistantMessage = {
					...makeAssistantMessage(), api: model.api, provider: model.provider, model: model.id,
					content, stopReason: reason,
				};
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
	await session.bindExtensions({ mode: "json" });
	return { session, services };
}

it("keeps native Pi prompts stable after lazy skill activation without losing the skill tool", async () => {
	const root = await mkdtemp(join(tmpdir(), "cursor-skill-native-"));
	const skill = await createSkill(root, "proof", "Follow the proof skill instructions.");
	const captured: Context[] = [];
	const { session } = await createNativeSkillSession(root, [skill], (context) => {
		captured.push({ ...context, messages: structuredClone(context.messages) });
		return captured.length === 1
			? [{ type: "toolCall", id: "activate-proof", name: "cursor_activate_skill", arguments: { name: "proof" } }]
			: [{ type: "text", text: "OK" }];
	});
	try {
		await session.prompt("Use the proof skill.");
		await session.prompt("Follow up.");
		expect(captured, JSON.stringify(session.messages)).toHaveLength(3);
		const activation = captured[1].messages.find((message) => message.role === "toolResult");
		expect(activation).toMatchObject({ toolName: "cursor_activate_skill", isError: false });
		const content = activation?.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
		expect(content).toContain("Follow the proof skill instructions.");
		expect(content).toContain(`Skill directory: ${skill.baseDir}`);
		expect(getCurrentTools(captured[0].messages).find((tool) => tool.name === "cursor_activate_skill")?.description).toContain("Load full pi Agent Skill instructions");
		expect(getCurrentSystemPrompt(captured[0].messages)).toContain("call pi__cursor_activate_skill with the skill name");
		expect(getCurrentSystemPrompt(captured[2].messages)).toBe(getCurrentSystemPrompt(captured[0].messages));
		expect(planCursorSessionSend({
			bootstrapped: true, incrementalSendCount: 0,
			contextFingerprint: computeCursorContextFingerprint(captured[0]),
		}, captured[2])).toMatchObject({ mode: "incremental", resetAgent: false });
	} finally {
		session.dispose();
		await rm(root, { recursive: true, force: true });
	}
}, 15000);

it.each(["session_start", "activation", "model_select"] as const)(
	"isolates native skill activation from a sibling's %s",
	async (siblingEvent) => {
		const rootA = await mkdtemp(join(tmpdir(), "cursor-skill-native-a-"));
		const rootB = await mkdtemp(join(tmpdir(), "cursor-skill-native-b-"));
		const skillsA = await Promise.all([
			createSkill(rootA, "proof", "Follow only session A's instructions."),
			createSkill(rootA, "a-only", "Available only to session A."),
		]);
		const skillsB = await Promise.all([
			createSkill(rootB, "proof", "Follow only session B's instructions."),
			createSkill(rootB, "b-only", "Available only to session B."),
		]);
		const enteredA = Promise.withResolvers<void>();
		const releaseA = Promise.withResolvers<void>();
		function activationCalls(context: Context, ownName: string): AssistantMessage["content"] {
			if (context.messages.at(-1)?.role !== "user") return [{ type: "text", text: "OK" }];
			return ["proof", ownName, "missing"].map((name) => ({
				type: "toolCall" as const, id: `activate-${name}`, name: "cursor_activate_skill", arguments: { name },
			}));
		}
		const { session: a } = await createNativeSkillSession(rootA, skillsA, async (context) => {
			if (context.messages.at(-1)?.role === "user") {
				enteredA.resolve();
				await releaseA.promise;
			}
			return activationCalls(context, "a-only");
		});
		let b: typeof a | undefined;
		let pendingA: Promise<void> | undefined;
		function expectOwnedActivation(session: typeof a, skills: Skill[], owner: string): void {
			const results = session.messages.filter((message) => message.role === "toolResult").slice(-3);
			expect(results).toHaveLength(3);
			for (const [index, skill] of skills.entries()) {
				expect(results[index]).toMatchObject({
					toolName: "cursor_activate_skill", isError: false,
					details: { filePath: skill.filePath, availableSkillNames: skills.map((item) => item.name).sort() },
				});
			}
			expect(results[0]?.content).toEqual([
				{ type: "text", text: expect.stringContaining(`Follow only session ${owner}'s instructions.`) },
			]);
			expect(results[2]).toMatchObject({
				isError: true,
				content: [{ type: "text", text: `Skill not available: missing. Available skills: ${skills.map((skill) => skill.name).sort().join(", ")}.` }],
			});
		}
		try {
			pendingA = a.prompt("Activate my skills and report unavailable names.");
			await enteredA.promise;
			// A's native request already exposes its tool; sibling lifecycle must not change its catalog.
			const sibling = await createNativeSkillSession(rootB, skillsB, (context) => activationCalls(context, "b-only"));
			b = sibling.session;
			if (siblingEvent !== "session_start") {
				await b.prompt("Activate my skills and report unavailable names.");
				expectOwnedActivation(b, skillsB, "B");
			}
			if (siblingEvent === "model_select") {
				await b.setModel(sibling.services.modelRuntime.getModel("cursor", "alternate")!);
				expect(b.getActiveToolNames()).not.toContain("cursor_activate_skill");
			}
			expect(a.getActiveToolNames()).toContain("cursor_activate_skill");
			releaseA.resolve();
			await pendingA;
			expectOwnedActivation(a, skillsA, "A");
			await b.prompt("Activate my own skills after A finishes.");
			expectOwnedActivation(b, skillsB, "B");
		} finally {
			releaseA.resolve();
			await pendingA;
			a.dispose();
			b?.dispose();
			await Promise.all([rm(rootA, { recursive: true, force: true }), rm(rootB, { recursive: true, force: true })]);
		}
	},
	15000,
);
