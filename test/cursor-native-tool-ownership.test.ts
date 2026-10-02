import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKAgent } from "@cursor/sdk";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	createBashToolDefinition,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type CreateAgentSessionRuntimeFactory,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { registerCursorNativeToolDisplay } from "../src/cursor-native-tool-display-registration.js";
import { canRenderCursorToolNatively, nativeToolResults } from "../src/cursor-native-tool-display-state.js";
import { registerCursorSessionScope } from "../src/cursor-session-scope.js";
import { CursorPartialContentEmitter } from "../src/cursor-partial-content-emitter.js";
import { CursorTurnDisplayRouter } from "../src/cursor-provider-turn-display-router.js";
import { cursorLiveRuns, drainCursorLiveRunTurn } from "../src/cursor-provider-live-run-drain.js";
import { makeAssistantMessage } from "./helpers/context-fixtures.js";
import { makeModel, makeProviderModelConfig } from "./helpers/model-fixtures.js";

it.each(["named", "unnamed"])("tracks the real %s tool owner across native new/resume/reload and model changes", async (factoryMode) => {
	const root = mkdtempSync(join(tmpdir(), "cursor-native-ownership-"));
	const cwdA = join(root, "a");
	const cwdB = join(root, "b");
	const agentDir = join(root, "agent");
	const sessionDir = join(root, "sessions");
	for (const dir of [cwdA, cwdB, agentDir, sessionDir]) mkdirSync(dir);
	const thirdPartyCalls: string[] = [];
	const extensionErrors: unknown[] = [];
	const model = makeModel("offline");

	function cursor(api: ExtensionAPI) {
		api.registerProvider("cursor", {
			api: "cursor-sdk", baseUrl: "http://unused.invalid", apiKey: "offline-test-only",
			models: [makeProviderModelConfig(model.id)],
		});
		api.on("before_provider_request", () => { throw new Error("No model requests in this regression"); });
		registerCursorSessionScope(api);
		registerCursorNativeToolDisplay(api);
	}
	function thirdParty(api: ExtensionAPI) {
		api.registerTool({
			...createBashToolDefinition(cwdB),
			async execute(id, args, signal, onUpdate, ctx) {
				thirdPartyCalls.push(id);
				return createBashToolDefinition(ctx.cwd).execute(id, args, signal, onUpdate, ctx);
			},
		});
	}
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd, agentDir,
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, enableInstallTelemetry: false }),
			resourceLoaderOptions: {
				noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
				extensionFactories: factoryMode === "unnamed"
					? [...(cwd === cwdB ? [thirdParty] : []), cursor]
					: [...(cwd === cwdB ? [{ name: "third-party", factory: thirdParty }] : []), { name: "cursor", factory: cursor }],
			},
		});
		expect(services.diagnostics).toEqual([]);
		const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model });
		expect(result.extensionsResult.errors).toEqual([]);
		return { ...result, services, diagnostics: services.diagnostics };
	};
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: cwdA, agentDir, sessionManager: SessionManager.create(cwdA, sessionDir),
	});
	const bind = (session: AgentSession) => session.bindExtensions({ mode: "json", onError: error => extensionErrors.push(error) });
	runtime.setRebindSession(bind);

	function seed(sessionManager: SessionManager, label: string): string {
		sessionManager.appendModelChange(model.provider, model.id);
		sessionManager.appendMessage(makeAssistantMessage(label));
		const path = sessionManager.getSessionFile()!;
		expect(readFileSync(path, "utf8")).toContain(label);
		return path;
	}
	async function check(label: string, thirdPartyOwns = false) {
		const marker = join(runtime.cwd, `${label}.txt`);
		writeFileSync(marker, "ALREADY_EXECUTED\n");
		const owner = runtime.session.getAllTools().find(tool => tool.name === "bash")!.sourceInfo;
		// Unnamed factories reuse the same positional path for a different owner after the switch.
		expect(owner.path).toBe(factoryMode === "unnamed" ? "<inline:1>" : thirdPartyOwns ? "<inline:third-party>" : "<inline:cursor>");
		const bash = runtime.session.agent.state.tools.find(tool => tool.name === "bash")!;
		const callsBefore = thirdPartyCalls.length;
		const ordinary = await bash.execute(`ordinary-${label}`, { command: "printf ORDINARY_OK" });
		expect(ordinary.content).toEqual([{ type: "text", text: "ORDINARY_OK" }]);
		expect(thirdPartyCalls.length - callsBefore).toBe(thirdPartyOwns ? 1 : 0);

		const partial = makeAssistantMessage("");
		partial.content = [];
		const stream = createAssistantMessageEventStream();
		// This run represents already-completed SDK work; only the real display/drain pipeline runs.
		const run = cursorLiveRuns.start({ id: `cursor-replay-${Date.now()}-1`, agent: {} as SDKAgent, promptInputTokens: 0 });
		cursorLiveRuns.markFinished(run, "");
		const router = new CursorTurnDisplayRouter({
			cwd: runtime.cwd, liveRun: run, useNativeToolReplay: true,
			activeToolNames: new Set(runtime.session.getActiveToolNames()), nativeReplayId: run.id,
			contentEmitter: new CursorPartialContentEmitter(stream, partial),
		});
		try {
			const action = router.routeCompletedToolCall({
				name: "shell", args: { command: `printf 'DUPLICATED\\n' >> '${marker}'` },
				result: { status: "success", value: { stdout: "RECORDED_ONLY", stderr: "", exitCode: 0 } },
			})!;
			router.emitDisplayAction(action);
			await drainCursorLiveRunTurn(stream, partial, model, {
				messages: [], tools: runtime.session.getAllTools(),
			}, run, 0, { mode: "emit" });
			for (const call of partial.content) {
				if (call.type !== "toolCall") continue;
				const result = await bash.execute(call.id, call.arguments);
				if (!thirdPartyOwns) {
					expect(result.content).toEqual([{ type: "text", text: "RECORDED_ONLY" }]);
					expect(nativeToolResults.has(call.id)).toBe(false);
				}
			}
			expect(readFileSync(marker, "utf8")).toBe("ALREADY_EXECUTED\n");
			expect(thirdPartyCalls.length - callsBefore).toBe(thirdPartyOwns ? 1 : 0);
			expect(canRenderCursorToolNatively("bash")).toBe(!thirdPartyOwns);
			expect(action.disposition).toBe(thirdPartyOwns ? "transcript_trace" : "queue_replay");
			expect(partial.content.some(block => block.type === "toolCall")).toBe(!thirdPartyOwns);
			if (thirdPartyOwns) expect(JSON.stringify(partial.content)).toContain("RECORDED_ONLY");
		} finally {
			await cursorLiveRuns.release(run);
		}
	}
	try {
		await bind(runtime.session);
		const firstFile = seed(runtime.session.sessionManager, "initial");
		await check("startup");
		await runtime.session.setModel(model);
		await runtime.session.setModel(model);
		await check("model-sync");
		await runtime.session.reload();
		await check("reload");
		expect(await runtime.newSession()).toEqual({ cancelled: false });
		await check("new");
		expect(await runtime.switchSession(firstFile)).toEqual({ cancelled: false });
		await check("resume");
		const otherFile = seed(SessionManager.create(cwdB, sessionDir), "third-party-session");
		expect(await runtime.switchSession(otherFile)).toEqual({ cancelled: false });
		await check("third-party", true);
		await runtime.session.setModel(model);
		await runtime.session.setModel(model);
		await check("third-party-model-sync", true);
		await runtime.session.reload();
		await check("third-party-reload", true);
		expect(await runtime.newSession()).toEqual({ cancelled: false });
		await check("third-party-new", true);
		expect(await runtime.switchSession(firstFile)).toEqual({ cancelled: false });
		await check("cursor-again");
		await runtime.session.reload();
		await check("cursor-again-reload");
		expect(extensionErrors).toEqual([]);
	} finally {
		await runtime.dispose();
		rmSync(root, { recursive: true, force: true });
	}
}, 30_000);

it.each([
	{ label: "allowlist", tools: ["read", "bash"] },
	{ label: "exclusions", excludeTools: ["grep", "find", "ls", "cursor", "edit", "write"] },
	{ label: "no-tools", noTools: "all" as const },
])("registers filtered replay wrappers once per native extension API ($label)", async ({ label, ...toolOptions }) => {
	const root = mkdtempSync(join(tmpdir(), "cursor-filtered-registration-"));
	const agentDir = join(root, "agent");
	const model = makeModel("offline");
	const alternateModel = makeModel("alternate");
	const registrations: Array<{ count: number }> = [];
	const extensionErrors: unknown[] = [];
	let providerRequests = 0;
	function cursor(api: ExtensionAPI) {
		const registration = { count: 0 };
		registrations.push(registration);
		const registerTool = api.registerTool;
		api.registerTool = (...args) => {
			registration.count++;
			registerTool(...args);
		};
		api.registerProvider("cursor", {
			api: "cursor-sdk", baseUrl: "http://unused.invalid", apiKey: "offline-test-only",
			models: [makeProviderModelConfig(model.id), makeProviderModelConfig(alternateModel.id)],
			streamSimple(selectedModel) {
				providerRequests++;
				const message = { ...makeAssistantMessage("OK"), model: selectedModel.id };
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
					stream.end();
				});
				return stream;
			},
		});
		registerCursorNativeToolDisplay(api);
	}
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd, agentDir,
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, enableInstallTelemetry: false }),
			resourceLoaderOptions: {
				noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
				extensionFactories: [cursor],
			},
		});
		const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model, ...toolOptions });
		return { ...result, services, diagnostics: services.diagnostics };
	};
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: root, agentDir, sessionManager: SessionManager.create(root, join(root, "sessions")),
	});
	const bind = (session: AgentSession) => session.bindExtensions({ mode: "json", onError: error => extensionErrors.push(error) });
	runtime.setRebindSession(bind);
	async function check() {
		// Count the real API registrations, including names omitted by native getAllTools.
		const registration = registrations.at(-1)!;
		const initialCount = registration.count;
		expect(initialCount).toBeGreaterThan(0);
		expect(runtime.session.getAllTools().some(tool => tool.name === "cursor")).toBe(false);
		if (label === "allowlist") expect(runtime.session.getAllTools().map(tool => tool.name).sort()).toEqual(["bash", "read"]);
		for (let index = 0; index < 200; index++) await runtime.session.setModel(index % 2 ? model : alternateModel);
		expect(registration.count).toBe(initialCount);
		await runtime.session.prompt("First filtered turn");
		await runtime.session.prompt("Second filtered turn");
		expect(registration.count).toBe(initialCount);
	}
	try {
		await bind(runtime.session);
		await check();
		const firstFile = runtime.session.sessionManager.getSessionFile()!;
		let previousRegistration = registrations.at(-1);
		await runtime.session.reload();
		expect(registrations.at(-1)).not.toBe(previousRegistration);
		await check();
		previousRegistration = registrations.at(-1);
		expect(await runtime.newSession()).toEqual({ cancelled: false });
		expect(registrations.at(-1)).not.toBe(previousRegistration);
		await check();
		previousRegistration = registrations.at(-1);
		expect(await runtime.switchSession(firstFile)).toEqual({ cancelled: false });
		expect(registrations.at(-1)).not.toBe(previousRegistration);
		await check();
		expect(providerRequests).toBe(8);
		expect(extensionErrors).toEqual([]);
	} finally {
		await runtime.dispose();
		rmSync(root, { recursive: true, force: true });
	}
}, 30_000);
