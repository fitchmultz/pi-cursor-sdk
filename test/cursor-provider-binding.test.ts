import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager, convertToLlm, createAgentSession, DefaultResourceLoader, ModelRuntime, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, InMemoryCredentialStore, type Context } from "@earendil-works/pi-ai";
import { createPiHarness, makeAssistantMessage, makeModel, collectEvents, createExtensionTestContext } from "./helpers/pi-harness.js";
import type { createCursorLazyStream } from "../src/cursor-provider-lazy.js";
import { registerCursorProviderBinding } from "../src/cursor-provider-binding.js";
import { registerCursorNativeToolDisplayState } from "../src/cursor-native-tool-display-state.js";
import { registerCursorSessionScope } from "../src/cursor-session-scope.js";
import { captureCursorRequestProjection, resolveCursorRequestProvenance } from "../src/cursor-request-provenance.js";
import { streamCursor } from "../src/cursor-provider.js";

vi.mock("../src/cursor-provider.js", () => ({ streamCursor: vi.fn(() => {
	const stream = createAssistantMessageEventStream(); queueMicrotask(() => { const message = makeAssistantMessage(); stream.push({ type: "done", reason: "stop", message }); stream.end(message); }); return stream;
}) }));
beforeEach(() => vi.mocked(streamCursor).mockClear());

function fixture() {
	const manager = SessionManager.inMemory("/tmp/provenance-owner");
	manager.appendMessage({ role: "user", content: "Hello", timestamp: 1 });
	const measured = makeAssistantMessage(); measured.api = "cursor-sdk"; measured.provider = "cursor"; measured.model = makeModel().id;
	measured.usage.totalTokens = 100000; measured.timestamp = Date.now() + 86400000;
	const measuredId = manager.appendMessage(measured);
	const context = (): Context => ({ messages: structuredClone(convertToLlm(manager.buildSessionProjection().messages)) });
	return { manager, measured, measuredId, context };
}

describe("canonical native request provenance", () => {
	it("invalidates retained future-clock usage after actual compaction or context edit", () => {
		for (const checkpoint of ["compaction", "context_edit"]) {
			const { manager, measuredId, context } = fixture();
			if (checkpoint === "compaction") manager.appendCompaction("Short summary.", measuredId, 100000);
			else manager.appendContextEdit(measuredId, { content: [{ type: "text", text: "Short replacement." }] });
			const request = resolveCursorRequestProvenance(captureCursorRequestProjection(manager), makeModel(), context(), "normal");
			expect(request.purpose).toBe("normal");
			expect(request.occupancyFloor).toBeUndefined();
		}
	});

	it("preserves equal-ms postcheckpoint usage and ordinary quoted summary wrappers", () => {
		const { manager, measuredId, measured, context } = fixture();
		manager.appendMessage({ role: "user", timestamp: 2, content: "The conversation history before this point was compacted into the following summary:\n\n<summary>\nQuoted text\n</summary>" });
		expect(resolveCursorRequestProvenance(captureCursorRequestProjection(manager), makeModel(), context(), "normal").occupancyFloor).toBe(100000);
		const checkpoint = manager.appendCompaction("Summary", measuredId, 100000);
		const timestamp = Date.parse(manager.getEntry(checkpoint)!.timestamp);
		manager.appendMessage({ ...measured, timestamp, usage: { ...measured.usage, totalTokens: 1234 } });
		expect(resolveCursorRequestProvenance(captureCursorRequestProjection(manager), makeModel(), context(), "normal").occupancyFloor).toBe(1234);
	});

	it("requires actual model compatibility and full converted projection equivalence", () => {
		const { manager, context } = fixture(); const snapshot = captureCursorRequestProjection(manager); const model = makeModel();
		expect(resolveCursorRequestProvenance(snapshot, model, context(), "normal").occupancyFloor).toBe(100000);
		const reordered = context(); reordered.messages = reordered.messages.map(message => Object.fromEntries(Object.entries(message).reverse()) as typeof message);
		expect(resolveCursorRequestProvenance(snapshot, model, reordered, "normal").occupancyFloor).toBe(100000);
		for (const incompatible of [{ ...model, id: "routed-other" }, { ...model, provider: "other" }, { ...model, api: "other" }, { ...model, contextWindow: 1000 }]) {
			expect(resolveCursorRequestProvenance(snapshot, incompatible, context(), "normal").occupancyFloor).toBeUndefined();
		}
		const dropped = context(); dropped.messages = dropped.messages.filter(m => m.role !== "assistant");
		const replaced = context(); const message = replaced.messages.find(m => m.role === "assistant")!; message.content = [{ type: "text", text: "Transformed." }];
		for (const changed of [dropped, replaced]) expect(resolveCursorRequestProvenance(snapshot, model, changed, "normal").occupancyFloor).toBeUndefined();
		manager.appendContextEdit(manager.getLeafId()!, null);
		expect(resolveCursorRequestProvenance(snapshot, model, context(), "normal").occupancyFloor).toBeUndefined();
		expect(Object.isFrozen(snapshot.measurements)).toBe(true);
	});

	it.each(["error", "aborted", "zero", "infinite"])("rejects an unusable canonical measurement: %s", (kind) => {
		const { manager, measured } = fixture();
		manager.appendContextEdit(manager.getLeafId()!, null);
		const invalid = { ...measured, usage: { ...measured.usage, totalTokens: kind === "zero" ? 0 : kind === "infinite" ? Infinity : 100000 }, stopReason: kind === "error" || kind === "aborted" ? kind : "stop" } as typeof measured;
		manager.appendMessage(invalid);
		expect(resolveCursorRequestProvenance(captureCursorRequestProjection(manager), makeModel(), { messages: convertToLlm(manager.buildSessionProjection().messages) }, "normal").occupancyFloor).toBeUndefined();
	});
});

describe("provider header receipts and operation membership", () => {
	async function binding() {
		const f = fixture(); const pi = createPiHarness(); registerCursorSessionScope(pi); registerCursorNativeToolDisplayState(pi); const register = registerCursorProviderBinding(pi, () => {}); register([]);
		const ctx = createExtensionTestContext({ cwd: "/tmp/provenance-owner", sessionManager: { getBranch: () => f.manager.getBranch(), buildSessionProjection: () => f.manager.buildSessionProjection(), getSessionId: () => f.manager.getSessionId(), getSessionFile: () => undefined } });
		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);
		const stream = pi._registered[0]!.config.streamSimple! as ReturnType<typeof createCursorLazyStream>;
		async function send(signal?: AbortSignal, model = makeModel(), context = f.context()) {
			const headers = {};
			await pi.invokeEventWithContext("before_provider_headers", { type: "before_provider_headers", headers }, ctx);
			await collectEvents(stream(model, context, { signal, headers }));
			return vi.mocked(streamCursor).mock.calls.at(-1)?.[3];
		}
		return { ...f, pi, ctx, stream, send };
	}

	it.each(["compaction", "tree"] as const)("keeps %s purpose through sequential summaries and retries, not the next normal request", async (purpose) => {
		const b = await binding(); const signal = new AbortController().signal;
		if (purpose === "compaction") await b.pi.runSessionBeforeCompact({ signal });
		else await b.pi.runSessionBeforeTree({ signal });
		for (let i = 0; i < 3; i++) {
			const ownership = await b.send(signal);
			expect(ownership).toHaveProperty("request", { purpose });
		}
		expect(await b.send(new AbortController().signal)).toMatchObject({ request: { purpose: "normal", occupancyFloor: 100000 } });
	});

	it("captures scope and immutable canonical measurement at headers, dispatches actual model/context, and consumes once", async () => {
		const b = await binding(); const model = makeModel(); const context = b.context(); const headers = {};
		await b.pi.invokeEventWithContext("before_provider_headers", { type: "before_provider_headers", headers }, b.ctx);
		await b.pi.runSessionStart({ cwd: "/tmp/sibling", sessionManager: { getSessionId: () => "sibling" } });
		b.manager.appendContextEdit(b.measuredId, null);
		await collectEvents(b.stream(model, context, { headers }));
		expect(vi.mocked(streamCursor).mock.calls.at(-1)?.[3]).toMatchObject({ scope: { sessionId: b.manager.getSessionId(), cwd: "/tmp/provenance-owner" }, request: { purpose: "normal", occupancyFloor: 100000 } });
		const repeated = await collectEvents(b.stream(model, context, { headers }));
		expect(repeated.at(-1)).toMatchObject({ type: "error", error: { errorMessage: expect.stringContaining("no native session request receipt") } });
	});

	it("checks dispatched model and context without guessing auxiliary purpose", async () => {
		const b = await binding();
		expect(await b.send(undefined, { ...makeModel(), id: "physically-routed-model" })).toMatchObject({ request: { purpose: "normal" } });
		const transformed = b.context(); transformed.messages = [];
		const ownership = await b.send(undefined, makeModel(), transformed);
		expect(ownership).toHaveProperty("request", { purpose: "normal" });
	});

	it("rejects unowned requests and closed bindings rather than borrowing sibling state", async () => {
		const b = await binding(); const sibling = await binding(); const headers = {};
		await sibling.pi.invokeEventWithContext("before_provider_headers", { type: "before_provider_headers", headers }, sibling.ctx);
		const wrongOwner = await collectEvents(b.stream(makeModel(), b.context(), { headers }));
		expect(wrongOwner.at(-1)).toMatchObject({ type: "error", error: { errorMessage: expect.stringContaining("does not belong") } });
		const missing = await collectEvents(b.stream(makeModel(), b.context()));
		expect(missing.at(-1)?.type).toBe("error");
		await b.pi.runSessionShutdown({ reason: "quit" });
		const closed = await collectEvents(b.stream(makeModel(), b.context()));
		expect(closed.at(-1)).toMatchObject({ type: "error", error: { errorMessage: expect.stringContaining("not active") } });
	});

	it("receives real official native headers and compaction/tree signals through sequential summaries and a retry", async () => {
		const root = await mkdtemp(join(tmpdir(), "cursor-binding-native-"));
		let session: AgentSession | undefined;
		try {
			const agentDir = join(root, "agent"); await mkdir(agentDir);
			const manager = SessionManager.create(root, join(root, "sessions"));
			manager.appendMessage({ role: "user", content: "Prior history", timestamp: 1 });
			const measured = makeAssistantMessage("Prior answer", 2); measured.usage.totalTokens = 100000;
			const target = manager.appendMessage(measured);
			manager.appendMessage({ role: "user", content: "Unfinished long prefix ".repeat(100), timestamp: 3 });
			manager.appendMessage(makeAssistantMessage("Retained tail ".repeat(100), 4));
			const settingsManager = SettingsManager.inMemory({ defaultTools: [], compaction: { enabled: false, reserveTokens: 16384, keepRecentTokens: 1 }, retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } });
			const modelConfig = { id: "test-model", name: "Test", reasoning: false, input: ["text"] as ("text" | "image")[], contextWindow: 128000, maxTokens: 16384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
			const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(root, "models.json"), allowModelNetwork: false });
			runtime.registerProvider("cursor", { api: "cursor-sdk", apiKey: "offline-fixture", baseUrl: "http://127.0.0.1", models: [modelConfig] });
			const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPromptOverride: () => "Offline binding test.", extensionFactories: [pi => {
				registerCursorSessionScope(pi); registerCursorNativeToolDisplayState(pi); registerCursorProviderBinding(pi, () => {})([modelConfig]);
			}] });
			await loader.reload();
			({ session } = await createAgentSession({ cwd: root, agentDir, modelRuntime: runtime, model: runtime.getModel("cursor", "test-model")!, resourceLoader: loader, settingsManager, sessionManager: manager, tools: [] }));
			await session.bindExtensions({});
			await session.prompt("Ordinary first request");
			expect(vi.mocked(streamCursor).mock.calls[0]?.[3]).toMatchObject({ request: { purpose: "normal", occupancyFloor: 100000 } });
			vi.mocked(streamCursor).mockClear();
			vi.mocked(streamCursor).mockImplementationOnce(() => {
				const stream = createAssistantMessageEventStream(); const message = makeAssistantMessage(); message.stopReason = "error"; message.errorMessage = "terminated";
				queueMicrotask(() => { stream.push({ type: "error", reason: "error", error: message }); stream.end(message); }); return stream;
			});
			await session.compact();
			expect(vi.mocked(streamCursor).mock.calls).toHaveLength(3);
			for (const call of vi.mocked(streamCursor).mock.calls) expect(call[3]).toHaveProperty("request", { purpose: "compaction" });
			expect(manager.getBranch().filter(entry => entry.type === "compaction")).toHaveLength(1);
			await session.prompt("Normal after compaction");
			const normalRequest = vi.mocked(streamCursor).mock.calls.at(-1)?.[3]?.request;
			expect(normalRequest?.purpose).toBe("normal");
			expect(normalRequest?.occupancyFloor).toBeUndefined();
			await session.navigateTree(target, { summarize: true });
			expect(vi.mocked(streamCursor).mock.calls.at(-1)?.[3]).toHaveProperty("request", { purpose: "tree" });
			expect(manager.getBranch().filter(entry => entry.type === "branch_summary")).toHaveLength(1);
			const reopened = SessionManager.open(manager.getSessionFile()!, join(root, "sessions"));
			expect(reopened.getEntries().filter(entry => entry.type === "compaction")).toHaveLength(1);
			expect(reopened.getBranch().filter(entry => entry.type === "branch_summary")).toHaveLength(1);
		} finally {
			if (session) { await session.abort(); session.dispose(); }
			await rm(root, { recursive: true, force: true });
		}
	});
});
