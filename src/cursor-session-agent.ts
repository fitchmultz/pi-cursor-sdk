import { createHash } from "node:crypto";
import type { AgentModeOption, LocalAgentOptions, LocalAgentStore, ModelSelection, SDKAgent, SettingSource } from "@cursor/sdk";
import type { Context } from "@earendil-works/pi-ai/compat";
import {
	getRegisteredCursorPiToolBridge,
	type CursorPiBridgeToolRequest,
	type CursorPiToolBridgeRun,
} from "./cursor-pi-tool-bridge.js";
import { computeCursorContextFingerprint } from "./context.js";
import { getCursorSessionFile, getCursorSessionScopeGeneration, getCursorSessionScopeKey } from "./cursor-session-scope.js";
import {
	getMatchingCursorSessionAgentResumeHandle,
	persistCursorSessionAgentResumeHandle,
} from "./cursor-session-agent-resume.js";
import type { CursorSdkEventDebugRecorder } from "./cursor-sdk-event-debug.js";
import { loadCursorSdk, type CursorSdkModule } from "./cursor-sdk-runtime.js";
import {
	cursorSessionStoreIdentitiesEqual,
	openCursorSessionStore,
	openCursorSessionStoreForScope,
	type CursorSessionStoreIdentity,
	type OpenCursorSessionStore,
} from "./cursor-session-store.js";

export interface SessionCursorAgentSendState {
	bootstrapped: boolean;
	contextFingerprint: string;
	incrementalSendCount: number;
}

export interface SessionCursorAgentLease {
	scopeKey: string;
	poolKey: string;
	instanceId: number;
	agent: SDKAgent;
	bridgeRun?: CursorPiToolBridgeRun;
	store: LocalAgentStore;
	storeIdentity: CursorSessionStoreIdentity;
	sendState: SessionCursorAgentSendState;
	created: boolean;
	resumed?: boolean;
	resumeNotice?: string;
	commitSend(context: Context, bootstrapped: boolean): void;
	trackRunCompletion(completion: Promise<unknown>): void;
}

interface SessionCursorAgentPoolEntryBase {
	poolKey: string;
	instanceId: number;
	scopeKey: string;
	sendState: SessionCursorAgentSendState;
}

interface SessionCursorAgentCreatingEntry extends SessionCursorAgentPoolEntryBase {
	status: "creating";
	creating: Promise<SessionCursorAgentReadyEntry>;
	creationGeneration: number;
}

interface SessionCursorAgentReadyEntry extends SessionCursorAgentPoolEntryBase {
	status: "ready";
	agent: SDKAgent;
	bridgeRun?: CursorPiToolBridgeRun;
	sessionStore: OpenCursorSessionStore;
	resumeEnabled: boolean;
	resumed: boolean;
	resumeNotice?: string;
}

interface SessionCursorAgentBusyEntry extends SessionCursorAgentPoolEntryBase {
	status: "busy";
	agent: SDKAgent;
	bridgeRun?: CursorPiToolBridgeRun;
	sessionStore: OpenCursorSessionStore;
	resumeEnabled: boolean;
	resumed: boolean;
	resumeNotice?: string;
	completionSettled: Promise<void>;
	pendingCompletion: Promise<void>;
	releaseBusyWait: () => void;
	busyGeneration: number;
}

type SessionCursorAgentActiveEntry = SessionCursorAgentReadyEntry | SessionCursorAgentBusyEntry;
type SessionCursorAgentPoolEntry =
	| SessionCursorAgentCreatingEntry
	| SessionCursorAgentReadyEntry
	| SessionCursorAgentBusyEntry;

type SessionCursorAgentPoolState = { status: "empty" } | SessionCursorAgentPoolEntry;

class SessionCursorAgentCreationSupersededError extends Error {
	constructor() {
		super("Cursor session agent creation was superseded");
		this.name = "SessionCursorAgentCreationSupersededError";
	}
}

export class SessionCursorAgentScopeClosedError extends Error {
	constructor() {
		super("Cursor session agent scope is closed");
		this.name = "SessionCursorAgentScopeClosedError";
	}
}

function assertScopeAcceptsAcquire(scopeKey: string): void {
	const terminalGeneration = terminalDisposedScopeGenerations.get(scopeKey);
	if (terminalGeneration === undefined) return;
	if (terminalGeneration >= getCursorSessionScopeGeneration(scopeKey)) {
		throw new SessionCursorAgentScopeClosedError();
	}
	terminalDisposedScopeGenerations.delete(scopeKey);
}

function rethrowSupersededWhenReplacedByDifferentPoolKey(scopeKey: string, poolKey: string, error: unknown): void {
	if (!(error instanceof SessionCursorAgentCreationSupersededError)) return;
	const replacement = sessionAgentsByScope.get(scopeKey);
	if (replacement && replacement.poolKey !== poolKey) {
		throw error;
	}
}

interface SessionCursorAgentCreateParams {
	apiKey: string;
	agentMode: AgentModeOption;
	cwd: string;
	modelSelection: ModelSelection;
	settingSources?: SettingSource[];
	localSafety?: CursorLocalSafetyOptions;
	useHttp1ForAgent?: boolean;
	onBridgeToolRequest?: (request: CursorPiBridgeToolRequest) => void;
	debugRecorder?: CursorSdkEventDebugRecorder;
	localResume?: boolean;
	forceCreate?: boolean;
	createAgent?: CursorSdkModule["Agent"]["create"];
	resumeAgent?: CursorSdkModule["Agent"]["resume"];
}

const sessionAgentsByScope = new Map<string, SessionCursorAgentPoolEntry>();
const invalidatedScopeKeys = new Set<string>();
const deadTransportScopeKeys = new Set<string>();
let deadTransportAgentDisposeTimeoutMs = 3000;
const terminalDisposedScopeGenerations = new Map<string, number>();
const scopeCreationGenerations = new Map<string, number>();
const EMPTY_POOL_STATE: SessionCursorAgentPoolState = { status: "empty" };
const LOCAL_RESUME_FALLBACK_NOTICE = "Could not resume prior Cursor agent; continuing from current pi transcript in a new Cursor agent.";
let nextSessionAgentInstanceId = 1;

export interface CursorLocalSafetyOptions {
	autoReview?: boolean;
	sandboxEnabled?: boolean;
}

export function buildCursorLocalAgentOptions(options: {
	cwd: string;
	settingSources?: SettingSource[];
	localSafety?: CursorLocalSafetyOptions;
	store?: LocalAgentStore;
}): LocalAgentOptions {
	return {
		cwd: options.cwd,
		...(options.store ? { store: options.store } : {}),
		...(options.settingSources ? { settingSources: options.settingSources } : {}),
		...(options.localSafety?.autoReview === true ? { autoReview: true } : {}),
		...(options.localSafety?.sandboxEnabled === true ? { sandboxOptions: { enabled: true } } : {}),
	};
}

function allocateSessionAgentInstanceId(): number {
	return nextSessionAgentInstanceId++;
}

function getSessionCursorAgentPoolState(scopeKey: string): SessionCursorAgentPoolState {
	return sessionAgentsByScope.get(scopeKey) ?? EMPTY_POOL_STATE;
}

function isActivePoolEntry(entry: SessionCursorAgentPoolEntry | undefined): entry is SessionCursorAgentActiveEntry {
	return entry?.status === "ready" || entry?.status === "busy";
}

function getScopeCreationGeneration(scopeKey: string): number {
	return scopeCreationGenerations.get(scopeKey) ?? 0;
}

function invalidateScopeCreations(scopeKey: string): void {
	scopeCreationGenerations.set(scopeKey, getScopeCreationGeneration(scopeKey) + 1);
}

function buildModelPoolKey(modelSelection: ModelSelection): string {
	return JSON.stringify(modelSelection);
}

function buildSettingSourcesPoolKey(settingSources?: SettingSource[]): string {
	return settingSources?.join(",") ?? "";
}

function buildLocalSafetyPoolKey(localSafety?: CursorLocalSafetyOptions): string {
	return JSON.stringify({
		autoReview: localSafety?.autoReview === true,
		sandboxEnabled: localSafety?.sandboxEnabled === true,
	});
}

function buildApiKeyPoolKeyFingerprint(apiKey: string): string {
	return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

function buildBridgePoolKeySuffix(): string {
	const registeredBridge = getRegisteredCursorPiToolBridge();
	if (!registeredBridge) return "bridge:absent";
	return registeredBridge.getToolSurfaceSignature();
}

function buildSessionAgentPoolKey(scopeKey: string, params: SessionCursorAgentCreateParams): string {
	return [
		scopeKey,
		params.cwd,
		buildModelPoolKey(params.modelSelection),
		buildSettingSourcesPoolKey(params.settingSources),
		buildLocalSafetyPoolKey(params.localSafety),
		params.useHttp1ForAgent === undefined
			? "http1:default"
			: params.useHttp1ForAgent
				? "http1:on"
				: "http1:off",
		buildApiKeyPoolKeyFingerprint(params.apiKey),
		buildBridgePoolKeySuffix(),
	].join("\0");
}

async function disposePoolEntry(entry: SessionCursorAgentPoolEntry, options?: { deadTransport?: boolean }): Promise<void> {
	if (!isActivePoolEntry(entry)) return;
	entry.bridgeRun?.cancel("Cursor session agent disposed");
	try {
		await entry.bridgeRun?.dispose();
	} catch {
		// disposal failure should not block session replacement
	}
	try {
		const disposal = Promise.resolve(entry.agent[Symbol.asyncDispose]()).catch(() => undefined);
		// A dead local transport may never settle SDK disposal; bound the wait so the
		// next acquire recreates instead of hanging on the dead agent.
		await (options?.deadTransport
			? Promise.race([
					disposal,
					new Promise<void>((resolve) => setTimeout(resolve, deadTransportAgentDisposeTimeoutMs).unref?.()),
				])
			: disposal);
	} catch {
		// disposal failure should not block session replacement
	}
	await entry.sessionStore.dispose().catch(() => undefined);
}

async function disposePoolEntryForScope(scopeKey: string, options?: { terminal?: boolean }): Promise<void> {
	invalidateScopeCreations(scopeKey);
	if (options?.terminal) {
		terminalDisposedScopeGenerations.set(scopeKey, getCursorSessionScopeGeneration(scopeKey));
	}
	const entry = sessionAgentsByScope.get(scopeKey);
	invalidatedScopeKeys.delete(scopeKey);
	const deadTransport = deadTransportScopeKeys.delete(scopeKey);
	if (!entry) return;
	sessionAgentsByScope.delete(scopeKey);
	if (entry.status === "busy") {
		entry.releaseBusyWait();
	}
	if (entry.status === "creating") {
		entry.creating.catch(() => {
			// In-flight Agent.create was orphaned by scope disposal; active waiters surface errors elsewhere.
		});
		return;
	}
	await disposePoolEntry(entry, { deadTransport });
}

function createInitialSendState(): SessionCursorAgentSendState {
	return { bootstrapped: false, contextFingerprint: "", incrementalSendCount: 0 };
}

function bindBridgeToolRequest(
	entry: SessionCursorAgentActiveEntry,
	onBridgeToolRequest?: (request: CursorPiBridgeToolRequest) => void,
): void {
	entry.bridgeRun?.setOnToolRequest(onBridgeToolRequest);
}

function commitSessionAgentSendForLease(
	scopeKey: string,
	poolKey: string,
	instanceId: number,
	context: Context,
	bootstrapped: boolean,
): void {
	const entry = sessionAgentsByScope.get(scopeKey);
	if (!isActivePoolEntry(entry)) return;
	if (entry.poolKey !== poolKey || entry.instanceId !== instanceId) return;
	entry.sendState.bootstrapped = bootstrapped || entry.sendState.bootstrapped;
	entry.sendState.contextFingerprint = computeCursorContextFingerprint(context);
	if (bootstrapped) {
		entry.sendState.incrementalSendCount = 0;
	} else {
		entry.sendState.incrementalSendCount += 1;
	}
	if (entry.resumeEnabled) {
		persistCursorSessionAgentResumeHandle({
			runtime: "local",
			agentId: entry.agent.agentId,
			poolKey: entry.poolKey,
			sendState: entry.sendState,
			storeIdentity: entry.sessionStore.identity,
		});
	}
}

function normalizeRunCompletion(completion: Promise<unknown>): Promise<void> {
	return Promise.resolve(completion).then(
		() => undefined,
		() => undefined,
	);
}

function buildBusyPoolEntry(
	entry: SessionCursorAgentActiveEntry,
	completionSettled: Promise<void>,
): SessionCursorAgentBusyEntry {
	let releaseBusyWait = (): void => {};
	const releaseSignal = new Promise<"released">((resolve) => {
		releaseBusyWait = () => resolve("released");
	});
	const pendingCompletion = Promise.race([
		completionSettled.then(() => "completed" as const),
		releaseSignal,
	]).then((outcome) => {
		const current = sessionAgentsByScope.get(entry.scopeKey);
		if (
			outcome === "completed" &&
			current?.status === "busy" &&
			current.poolKey === entry.poolKey &&
			current.instanceId === entry.instanceId &&
			current.pendingCompletion === pendingCompletion
		) {
			sessionAgentsByScope.set(entry.scopeKey, { ...current, status: "ready" });
		}
	});

	return {
		...entry,
		status: "busy",
		completionSettled,
		pendingCompletion,
		releaseBusyWait,
		busyGeneration: getScopeCreationGeneration(entry.scopeKey),
	};
}

function trackSessionAgentRunCompletionForLease(
	scopeKey: string,
	poolKey: string,
	instanceId: number,
	completion: Promise<unknown>,
): void {
	const entry = sessionAgentsByScope.get(scopeKey);
	if (!isActivePoolEntry(entry)) return;
	if (entry.poolKey !== poolKey || entry.instanceId !== instanceId) return;

	const completionToTrack = normalizeRunCompletion(completion);
	const completionSettled = (entry.status === "busy"
		? Promise.all([entry.completionSettled, completionToTrack]).then(() => undefined)
		: completionToTrack
	);
	if (entry.status === "busy") {
		entry.releaseBusyWait();
	}

	sessionAgentsByScope.set(scopeKey, buildBusyPoolEntry(entry, completionSettled));
}

function leaseFromEntry(
	entry: SessionCursorAgentReadyEntry,
	scopeKey: string,
	params: SessionCursorAgentCreateParams,
	created: boolean,
): SessionCursorAgentLease {
	entry.resumeEnabled = params.localResume === true;
	bindBridgeToolRequest(entry, params.onBridgeToolRequest);
	entry.bridgeRun?.setDebugRecorder(params.debugRecorder);
	const resumeNotice = entry.resumeNotice;
	entry.resumeNotice = undefined;
	return {
		scopeKey,
		poolKey: entry.poolKey,
		instanceId: entry.instanceId,
		agent: entry.agent,
		bridgeRun: entry.bridgeRun,
		store: entry.sessionStore.store,
		storeIdentity: entry.sessionStore.identity,
		sendState: entry.sendState,
		created,
		resumed: entry.resumed,
		...(resumeNotice ? { resumeNotice } : {}),
		commitSend: (context, bootstrapped) => {
			commitSessionAgentSendForLease(scopeKey, entry.poolKey, entry.instanceId, context, bootstrapped);
		},
		trackRunCompletion: (completion) => {
			trackSessionAgentRunCompletionForLease(scopeKey, entry.poolKey, entry.instanceId, completion);
		},
	};
}

function getCurrentReadyPoolEntry(scopeKey: string, poolKey: string): SessionCursorAgentReadyEntry | undefined {
	const current = sessionAgentsByScope.get(scopeKey);
	if (current?.status !== "ready") return undefined;
	if (current.poolKey !== poolKey) return undefined;
	return current;
}

async function tryLeaseReadyEntry(
	entry: SessionCursorAgentActiveEntry,
	scopeKey: string,
	params: SessionCursorAgentCreateParams,
	poolKey: string,
	created: boolean,
): Promise<SessionCursorAgentLease | undefined> {
	if (entry.status === "busy") {
		await entry.pendingCompletion;
	}
	assertScopeAcceptsAcquire(scopeKey);
	if (invalidatedScopeKeys.has(scopeKey)) {
		await disposePoolEntryForScope(scopeKey);
		return undefined;
	}
	const readyEntry = getCurrentReadyPoolEntry(scopeKey, poolKey);
	if (!readyEntry) return undefined;
	return leaseFromEntry(readyEntry, scopeKey, params, created);
}

async function createSessionAgentEntry(
	scopeKey: string,
	persistentStore: boolean,
	instanceId: number,
	sendState: SessionCursorAgentSendState,
	params: SessionCursorAgentCreateParams,
): Promise<SessionCursorAgentReadyEntry> {
	let bridgeRun: CursorPiToolBridgeRun | undefined;
	let sessionStore: OpenCursorSessionStore | undefined;
	try {
		const registeredBridge = getRegisteredCursorPiToolBridge();
		if (registeredBridge) {
			bridgeRun = await registeredBridge.createRun({
				onToolRequest: params.onBridgeToolRequest,
				debugRecorder: params.debugRecorder,
			});
			if (!bridgeRun.enabled || !bridgeRun.mcpServers) {
				await bridgeRun.dispose();
				bridgeRun = undefined;
			}
		}

		const resolvedPoolKey = buildSessionAgentPoolKey(scopeKey, params);
		const resumeEligible = params.localResume === true && !params.forceCreate;
		let createAgent = params.createAgent;
		let resumeAgent = params.resumeAgent;
		if (!createAgent || (resumeEligible && !resumeAgent)) {
			const sdk = await loadCursorSdk();
			createAgent ??= sdk.Agent.create;
			resumeAgent ??= sdk.Agent.resume;
		}
		const resumeHandle = resumeEligible ? getMatchingCursorSessionAgentResumeHandle(resolvedPoolKey) : undefined;
		const storeSelection = await openCursorSessionStoreForScope({
			cwd: params.cwd,
			scopeKey,
			persistent: persistentStore,
			hasResumeHandle: resumeHandle !== undefined,
			resumeIdentity: resumeHandle?.storeIdentity,
		});
		sessionStore = storeSelection.sessionStore;
		const { identities } = storeSelection;
		const resumeAttemptAllowed = storeSelection.resumeAttemptAllowed;
		let resumeNotice = storeSelection.resumeFallback ? LOCAL_RESUME_FALLBACK_NOTICE : undefined;
		const buildAgentOptions = () => ({
			apiKey: params.apiKey,
			model: params.modelSelection,
			mode: params.agentMode,
			local: buildCursorLocalAgentOptions({
				cwd: params.cwd,
				settingSources: params.settingSources,
				localSafety: params.localSafety,
				store: sessionStore!.store,
			}),
			...(bridgeRun?.mcpServers ? { mcpServers: bridgeRun.mcpServers } : {}),
		});
		let agent: SDKAgent | undefined;
		let effectiveSendState = sendState;
		let resumed = false;
		if (resumeHandle && resumeAttemptAllowed && resumeAgent) {
			try {
				agent = await resumeAgent(resumeHandle.agentId, buildAgentOptions());
				effectiveSendState = { ...resumeHandle.sendState };
				resumed = true;
			} catch {
				if (persistentStore) resumeNotice = LOCAL_RESUME_FALLBACK_NOTICE;
				if (!cursorSessionStoreIdentitiesEqual(sessionStore.identity, identities.sessionStore)) {
					await sessionStore.dispose().catch(() => undefined);
					sessionStore = await openCursorSessionStore(params.cwd, identities.sessionStore);
				}
			}
		}
		agent ??= await createAgent(buildAgentOptions());
		if (!agent) throw new Error("Cursor SDK agent creation returned no agent");
		if (!sessionStore) throw new Error("Cursor SDK session store was not opened");

		return {
			status: "ready",
			poolKey: resolvedPoolKey,
			instanceId,
			scopeKey,
			agent,
			bridgeRun,
			sessionStore,
			sendState: effectiveSendState,
			resumeEnabled: params.localResume === true,
			resumed,
			...(resumeNotice ? { resumeNotice } : {}),
		};
	} catch (error) {
		bridgeRun?.cancel("Cursor session agent create failed");
		await bridgeRun?.dispose().catch(() => undefined);
		await sessionStore?.dispose().catch(() => undefined);
		throw error;
	}
}

export {
	buildCursorSessionSendPrompt,
	MAX_COMPLETED_INCREMENTAL_SENDS_BEFORE_REBOOTSTRAP,
	planCursorSessionSend,
	type CursorSessionSendPlan,
} from "./cursor-session-send-policy.js";

export function invalidateSessionAgent(
	scopeKey: string = getCursorSessionScopeKey(),
	options?: { deadTransport?: boolean },
): void {
	invalidatedScopeKeys.add(scopeKey);
	if (options?.deadTransport) deadTransportScopeKeys.add(scopeKey);
}

export async function acquireSessionCursorAgent(params: SessionCursorAgentCreateParams): Promise<SessionCursorAgentLease> {
	const scopeKey = getCursorSessionScopeKey();
	const persistentStore = getCursorSessionFile() !== undefined;

	while (true) {
		assertScopeAcceptsAcquire(scopeKey);
		if (invalidatedScopeKeys.has(scopeKey)) {
			await disposePoolEntryForScope(scopeKey);
		}

		const poolKey = buildSessionAgentPoolKey(scopeKey, params);
		const state = getSessionCursorAgentPoolState(scopeKey);

		if ((state.status === "ready" || state.status === "busy") && state.poolKey !== poolKey) {
			await disposePoolEntryForScope(scopeKey);
			continue;
		}

		if (state.status === "ready") {
			return leaseFromEntry(state, scopeKey, params, false);
		}

		if (state.status === "busy") {
			const busyGeneration = state.busyGeneration;
			await state.pendingCompletion;
			if (busyGeneration !== getScopeCreationGeneration(scopeKey)) continue;
			continue;
		}

		if (state.status === "creating") {
			if (state.poolKey !== poolKey) {
				await disposePoolEntryForScope(scopeKey);
				continue;
			}
			try {
				await state.creating;
			} catch (error) {
				if (error instanceof SessionCursorAgentCreationSupersededError) {
					assertScopeAcceptsAcquire(scopeKey);
					rethrowSupersededWhenReplacedByDifferentPoolKey(scopeKey, poolKey, error);
					continue;
				}
				throw error;
			}
			continue;
		}

		assertScopeAcceptsAcquire(scopeKey);
		const creationGeneration = getScopeCreationGeneration(scopeKey);
		const instanceId = allocateSessionAgentInstanceId();
		const sendState = createInitialSendState();
		let placeholder: SessionCursorAgentCreatingEntry;
		const creating = createSessionAgentEntry(scopeKey, persistentStore, instanceId, sendState, params).then(async (createdEntry) => {
			const stillCurrent =
				sessionAgentsByScope.get(scopeKey) === placeholder &&
				getScopeCreationGeneration(scopeKey) === placeholder.creationGeneration;
			if (!stillCurrent) {
				await disposePoolEntry(createdEntry);
				if (sessionAgentsByScope.get(scopeKey) === placeholder) {
					sessionAgentsByScope.delete(scopeKey);
				}
				throw new SessionCursorAgentCreationSupersededError();
			}
			sessionAgentsByScope.set(scopeKey, createdEntry);
			return createdEntry;
		});
		placeholder = {
			status: "creating",
			poolKey,
			instanceId,
			scopeKey,
			sendState,
			creationGeneration,
			creating,
		};
		sessionAgentsByScope.set(scopeKey, placeholder);

		try {
			const createdEntry = await creating;
			const lease = await tryLeaseReadyEntry(createdEntry, scopeKey, params, poolKey, true);
			if (lease) return lease;
			continue;
		} catch (error) {
			if (sessionAgentsByScope.get(scopeKey) === placeholder) {
				sessionAgentsByScope.delete(scopeKey);
			}
			if (error instanceof SessionCursorAgentCreationSupersededError) {
				assertScopeAcceptsAcquire(scopeKey);
				rethrowSupersededWhenReplacedByDifferentPoolKey(scopeKey, poolKey, error);
				continue;
			}
			throw error;
		}
	}
}

export type RefreshSessionCursorAgentConfigResult = "reloaded" | "no-agent" | "busy" | "unsupported";

export async function refreshSessionCursorAgentConfig(scopeKey: string = getCursorSessionScopeKey()): Promise<RefreshSessionCursorAgentConfigResult> {
	const entry = sessionAgentsByScope.get(scopeKey);
	if (!entry || entry.status === "creating") return "no-agent";
	if (entry.status === "busy") return "busy";
	if (typeof entry.agent.reload !== "function") return "unsupported";
	await entry.agent.reload();
	return "reloaded";
}

export async function resetSessionCursorAgent(scopeKey: string = getCursorSessionScopeKey()): Promise<void> {
	await disposePoolEntryForScope(scopeKey);
}

export async function disposeSessionCursorAgent(scopeKey: string = getCursorSessionScopeKey()): Promise<void> {
	await disposePoolEntryForScope(scopeKey, { terminal: true });
}

export async function disposeAllSessionCursorAgents(): Promise<void> {
	const scopeKeys = [...new Set([...sessionAgentsByScope.keys(), ...terminalDisposedScopeGenerations.keys()])];
	await Promise.all(scopeKeys.map((scopeKey) => disposePoolEntryForScope(scopeKey, { terminal: true })));
	invalidatedScopeKeys.clear();
	deadTransportScopeKeys.clear();
	terminalDisposedScopeGenerations.clear();
}

export const __testUtils = {
	sessionAgentsByScope,
	getSessionCursorAgentPoolState,
	invalidateSessionAgent,
	disposeSessionCursorAgent,
	resetSessionCursorAgent,
	refreshSessionCursorAgentConfig,
	disposeAllSessionCursorAgents,
	buildApiKeyPoolKeyFingerprint,
	buildSessionAgentPoolKey,
	setDeadTransportAgentDisposeTimeoutMs(ms: number): number {
		const previous = deadTransportAgentDisposeTimeoutMs;
		deadTransportAgentDisposeTimeoutMs = ms;
		return previous;
	},
	SessionCursorAgentCreationSupersededError,
	SessionCursorAgentScopeClosedError,
};
