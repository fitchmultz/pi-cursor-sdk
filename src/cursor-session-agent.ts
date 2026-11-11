import { createHash } from "node:crypto";
import type { AgentModeOption, AgentOptions, LocalAgentOptions, LocalAgentStore, ModelSelection, SDKAgent, SettingSource } from "@cursor/sdk";
import type { Context } from "@earendil-works/pi-ai";
import { normalizeCursorCustomStoreRoot } from "./cursor-custom-store-path.js";
import { claimCursorLocalAgent } from "./cursor-local-agent-ownership.js";
import {
	getRegisteredCursorPiToolBridge,
	type CursorPiToolBridge,
	type CursorPiToolBridgeRun,
	type CursorPiToolRequestHandler,
} from "./cursor-pi-tool-bridge.js";
import { computeCursorContextFingerprint } from "./context.js";
import { getCursorSessionScopeSnapshot, getCursorSessionScopeGeneration, getCursorSessionScopeKey, type CursorTurnScope } from "./cursor-session-scope.js";
import {
	captureCursorSessionAgentResumeOrigin,
	getMatchingCursorSessionAgentResumeHandle,
	type CursorSessionAgentResumeOrigin,
	type CursorSessionAgentResumePublication,
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

/** A fresh agent has no successful bootstrap send; only successful sends advance a bootstrapped agent. */
export type SessionCursorAgentSendState =
	| { readonly bootstrapped: false }
	| SessionCursorAgentBootstrappedSendState;

export interface SessionCursorAgentBootstrappedSendState {
	readonly bootstrapped: true;
	readonly contextFingerprint: string;
	readonly incrementalSendCount: number;
}

export interface SessionCursorAgentLease {
	scopeKey: string;
	poolKey: string;
	instanceId: number;
	agent: SDKAgent;
	bridgeRun?: CursorPiToolBridgeRun;
	store: LocalAgentStore;
	storeIdentity: CursorSessionStoreIdentity;
	/** Latest committed send state of the leased agent instance. */
	readonly sendState: SessionCursorAgentSendState;
	created: boolean;
	resumed?: boolean;
	resumeNotice?: string;
	/** Advances the send state; a resume-enabled send returns its handle for the turn that delivers its terminal output. */
	commitSend(context: Context, bootstrapped: boolean): CursorSessionAgentResumePublication | undefined;
	trackRunCompletion(completion: Promise<unknown>): void;
}

/** One SDK agent and its owned resources; ready and busy entries share it, so commits survive pool transitions. */
interface SessionCursorAgentInstance {
	readonly scopeKey: string;
	readonly poolKey: string;
	readonly storeRoot: string | undefined;
	readonly instanceId: number;
	readonly agent: SDKAgent;
	readonly bridgeRun?: CursorPiToolBridgeRun;
	readonly sessionStore: OpenCursorSessionStore;
	readonly resumed: boolean;
	readonly releaseAgentClaim: () => void;
	resumeNotice?: string;
	sendState: SessionCursorAgentSendState;
}

interface SessionCursorAgentCreatingEntry {
	status: "creating";
	poolKey: string;
	storeRoot: string | undefined;
	creating: Promise<SessionCursorAgentInstance>;
}

interface SessionCursorAgentReadyEntry {
	status: "ready";
	instance: SessionCursorAgentInstance;
}

interface SessionCursorAgentBusyEntry {
	status: "busy";
	instance: SessionCursorAgentInstance;
	completionSettled: Promise<void>;
	pendingCompletion: Promise<void>;
	releaseBusyWait: () => void;
}

type SessionCursorAgentActiveEntry = SessionCursorAgentReadyEntry | SessionCursorAgentBusyEntry;
type SessionCursorAgentPoolEntry =
	| SessionCursorAgentCreatingEntry
	| SessionCursorAgentReadyEntry
	| SessionCursorAgentBusyEntry;

type SessionCursorAgentPoolState = { status: "empty" } | SessionCursorAgentPoolEntry;

/** Per-scope pool facts that outlive any one entry. */
interface SessionCursorAgentScope {
	state: SessionCursorAgentPoolState;
	/** Lifecycle invalidation retires the entry at the next acquire; a dead transport bounds its SDK disposal wait. */
	invalidation?: "stale" | "deadTransport";
	/** Terminal disposal closes admission until a newer session generation binds the scope key. */
	closedAtSessionGeneration?: number;
}

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
	const scope = sessionAgentScopes.get(scopeKey);
	if (scope?.closedAtSessionGeneration === undefined) return;
	if (scope.closedAtSessionGeneration >= getCursorSessionScopeGeneration(scopeKey)) {
		throw new SessionCursorAgentScopeClosedError();
	}
	scope.closedAtSessionGeneration = undefined;
	pruneIdleSessionCursorAgentScope(scopeKey);
}

function samePoolIdentity(entry: SessionCursorAgentPoolEntry, poolKey: string, capturedStoreRoot: string | undefined): boolean {
	const identity = entry.status === "creating" ? entry : entry.instance;
	return identity.poolKey === poolKey && identity.storeRoot === capturedStoreRoot;
}

function rethrowSupersededWhenReplacedByDifferentPoolIdentity(scopeKey: string, poolKey: string, storeRoot: string | undefined, error: unknown): void {
	if (!(error instanceof SessionCursorAgentCreationSupersededError)) return;
	const replacement = getSessionCursorAgentPoolState(scopeKey);
	if (replacement.status !== "empty" && !samePoolIdentity(replacement, poolKey, storeRoot)) {
		throw error;
	}
}

interface SessionCursorAgentCreateParams {
	scope?: CursorTurnScope;
	bridge?: CursorPiToolBridge;
	apiKey: string;
	agentMode: AgentModeOption;
	cwd: string;
	modelSelection: ModelSelection;
	settingSources?: SettingSource[];
	localSafety?: CursorLocalSafetyOptions;
	agents?: AgentOptions["agents"];
	/** Captured by the turn owner before asynchronous acquisition. */
	nativeToolsEnabled?: boolean;
	useHttp1ForAgent?: boolean;
	onBridgeToolRequest?: CursorPiToolRequestHandler;
	debugRecorder?: CursorSdkEventDebugRecorder;
	localResume?: boolean;
	storeRoot?: string;
	forceCreate?: boolean;
	createAgent?: CursorSdkModule["Agent"]["create"];
	resumeAgent?: CursorSdkModule["Agent"]["resume"];
}

const sessionAgentScopes = new Map<string, SessionCursorAgentScope>();
const DEAD_TRANSPORT_AGENT_DISPOSE_TIMEOUT_MS = 3000;
const EMPTY_POOL_STATE: SessionCursorAgentPoolState = { status: "empty" };
const FRESH_SEND_STATE: SessionCursorAgentSendState = { bootstrapped: false };
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

function getSessionCursorAgentScope(scopeKey: string): SessionCursorAgentScope {
	let scope = sessionAgentScopes.get(scopeKey);
	if (!scope) {
		scope = { state: EMPTY_POOL_STATE };
		sessionAgentScopes.set(scopeKey, scope);
	}
	return scope;
}

/** Forgets a scope record once it holds no entry, invalidation, or closure. */
function pruneIdleSessionCursorAgentScope(scopeKey: string): void {
	const scope = sessionAgentScopes.get(scopeKey);
	if (scope?.state.status === "empty" && !scope.invalidation && scope.closedAtSessionGeneration === undefined) {
		sessionAgentScopes.delete(scopeKey);
	}
}

function getSessionCursorAgentPoolState(scopeKey: string): SessionCursorAgentPoolState {
	return sessionAgentScopes.get(scopeKey)?.state ?? EMPTY_POOL_STATE;
}

/** The pool entry still holding this instance; a replaced instance's stale lease resolves to undefined. */
function getCurrentActiveEntry(instance: SessionCursorAgentInstance): SessionCursorAgentActiveEntry | undefined {
	const state = getSessionCursorAgentPoolState(instance.scopeKey);
	return (state.status === "ready" || state.status === "busy") && state.instance === instance ? state : undefined;
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

function buildBridgePoolKeySuffix(registeredBridge: CursorPiToolBridge | undefined): string {
	if (!registeredBridge) return "bridge:absent";
	return registeredBridge.getToolSurfaceSignature();
}

function buildCustomSubagentPoolKeySuffix(agents: AgentOptions["agents"]): string[] {
	const definitions = Object.entries(agents ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
	if (!definitions.length) return [];
	const content = definitions.map(([name, entry]) => [
		name, entry.description, entry.prompt,
		entry.model === undefined ? null : entry.model === "inherit" ? "inherit" : {
			id: entry.model.id,
			params: [...(entry.model.params ?? [])].sort((a, b) =>
				a.id < b.id ? -1 : a.id > b.id ? 1 : a.value < b.value ? -1 : a.value > b.value ? 1 : 0)
				.map(({ id, value }) => ({ id, value })),
		},
	]);
	return [`subagents:${createHash("sha256").update(JSON.stringify(content)).digest("hex")}`];
}

function buildSessionAgentPoolKey(scopeKey: string, params: SessionCursorAgentCreateParams): string {
	return [
		params.scope?.persistentScopeKey ?? scopeKey,
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
		buildBridgePoolKeySuffix("bridge" in params ? params.bridge : getRegisteredCursorPiToolBridge()),
		...buildCustomSubagentPoolKeySuffix(params.agents),
		// Omit for the default so historical durable keys remain byte-for-byte stable.
		...(params.nativeToolsEnabled === false ? ["tools:mcp-only"] : []),
	].join("\0");
}

async function disposeSessionAgentInstance(instance: SessionCursorAgentInstance, options?: { deadTransport?: boolean }): Promise<void> {
	instance.bridgeRun?.cancel("Cursor session agent disposed");
	try {
		await instance.bridgeRun?.dispose();
	} catch {
		// disposal failure should not block session replacement
	}
	let disposal: Promise<unknown> | undefined;
	try {
		disposal = Promise.resolve(instance.agent[Symbol.asyncDispose]());
		// A dead local transport may never settle SDK disposal; bound the wait so the
		// next acquire recreates instead of hanging on the dead agent.
		await (options?.deadTransport
			? Promise.race([
					disposal,
					new Promise<void>((resolve) => setTimeout(resolve, DEAD_TRANSPORT_AGENT_DISPOSE_TIMEOUT_MS).unref?.()),
				])
			: disposal);
	} catch {
		// disposal failure should not block session replacement
	}
	await instance.sessionStore.dispose().catch(() => undefined);
	// Timeout/rejection is not proof of closure; only successful SDK disposal releases ownership.
	void disposal?.then(instance.releaseAgentClaim, () => {});
}

async function disposePoolEntryForScope(scopeKey: string, options?: { terminal?: boolean }): Promise<void> {
	const scope = getSessionCursorAgentScope(scopeKey);
	if (options?.terminal) {
		scope.closedAtSessionGeneration = getCursorSessionScopeGeneration(scopeKey);
	}
	const { state, invalidation } = scope;
	scope.state = EMPTY_POOL_STATE;
	scope.invalidation = undefined;
	pruneIdleSessionCursorAgentScope(scopeKey);
	if (state.status === "empty") return;
	if (state.status === "creating") {
		state.creating.catch(() => {
			// In-flight Agent.create was orphaned by scope disposal; active waiters surface errors elsewhere.
		});
		return;
	}
	if (state.status === "busy") {
		state.releaseBusyWait();
	}
	await disposeSessionAgentInstance(state.instance, { deadTransport: invalidation === "deadTransport" });
}

/** Records one successful send; an incremental send never bootstraps a fresh agent, so its next plan still bootstraps. */
function advanceSessionCursorAgentSendState(
	sendState: SessionCursorAgentSendState,
	context: Context,
	bootstrapped: boolean,
): SessionCursorAgentSendState {
	if (bootstrapped) {
		return { bootstrapped: true, contextFingerprint: computeCursorContextFingerprint(context), incrementalSendCount: 0 };
	}
	if (!sendState.bootstrapped) return sendState;
	return {
		bootstrapped: true,
		contextFingerprint: computeCursorContextFingerprint(context),
		incrementalSendCount: sendState.incrementalSendCount + 1,
	};
}

function commitSessionAgentSend(
	instance: SessionCursorAgentInstance,
	context: Context,
	bootstrapped: boolean,
	resumeOrigin: CursorSessionAgentResumeOrigin | undefined,
): CursorSessionAgentResumePublication | undefined {
	if (!getCurrentActiveEntry(instance)) return undefined;
	const sendState = advanceSessionCursorAgentSendState(instance.sendState, context, bootstrapped);
	instance.sendState = sendState;
	if (!resumeOrigin || !sendState.bootstrapped) return undefined;
	return resumeOrigin.capture({
		runtime: "local",
		agentId: instance.agent.agentId,
		poolKey: instance.poolKey,
		sendState,
		storeIdentity: instance.sessionStore.identity,
	});
}

function normalizeRunCompletion(completion: Promise<unknown>): Promise<void> {
	return Promise.resolve(completion).then(
		() => undefined,
		() => undefined,
	);
}

function buildBusyPoolEntry(
	instance: SessionCursorAgentInstance,
	completionSettled: Promise<void>,
): SessionCursorAgentBusyEntry {
	let releaseBusyWait = (): void => {};
	const releaseSignal = new Promise<"released">((resolve) => {
		releaseBusyWait = () => resolve("released");
	});
	const busyEntry: SessionCursorAgentBusyEntry = {
		status: "busy",
		instance,
		completionSettled,
		pendingCompletion: Promise.race([
			completionSettled.then(() => "completed" as const),
			releaseSignal,
		]).then((outcome) => {
			const scope = sessionAgentScopes.get(instance.scopeKey);
			if (outcome === "completed" && scope?.state === busyEntry) {
				scope.state = { status: "ready", instance };
			}
		}),
		releaseBusyWait,
	};
	return busyEntry;
}

function trackSessionAgentRunCompletion(instance: SessionCursorAgentInstance, completion: Promise<unknown>): void {
	const entry = getCurrentActiveEntry(instance);
	if (!entry) return;

	const completionToTrack = normalizeRunCompletion(completion);
	const completionSettled = (entry.status === "busy"
		? Promise.all([entry.completionSettled, completionToTrack]).then(() => undefined)
		: completionToTrack
	);
	if (entry.status === "busy") {
		entry.releaseBusyWait();
	}

	getSessionCursorAgentScope(instance.scopeKey).state = buildBusyPoolEntry(instance, completionSettled);
}

function leaseFromEntry(
	entry: SessionCursorAgentReadyEntry,
	params: SessionCursorAgentCreateParams,
	created: boolean,
): SessionCursorAgentLease {
	const { instance } = entry;
	// Each lease issues at most one send; its handle belongs to the session lineage current at issue.
	const resumeOrigin = params.localResume === true ? captureCursorSessionAgentResumeOrigin(instance.scopeKey) : undefined;
	instance.bridgeRun?.setOnToolRequest(params.onBridgeToolRequest);
	instance.bridgeRun?.setDebugRecorder(params.debugRecorder);
	const resumeNotice = instance.resumeNotice;
	instance.resumeNotice = undefined;
	return {
		scopeKey: instance.scopeKey,
		poolKey: instance.poolKey,
		instanceId: instance.instanceId,
		agent: instance.agent,
		bridgeRun: instance.bridgeRun,
		store: instance.sessionStore.store,
		storeIdentity: instance.sessionStore.identity,
		get sendState() {
			return instance.sendState;
		},
		created,
		resumed: instance.resumed,
		...(resumeNotice ? { resumeNotice } : {}),
		commitSend: (context, bootstrapped) => commitSessionAgentSend(instance, context, bootstrapped, resumeOrigin),
		trackRunCompletion: (completion) => {
			trackSessionAgentRunCompletion(instance, completion);
		},
	};
}

async function tryLeaseCreatedEntry(
	scopeKey: string,
	params: SessionCursorAgentCreateParams,
	poolKey: string,
): Promise<SessionCursorAgentLease | undefined> {
	assertScopeAcceptsAcquire(scopeKey);
	if (sessionAgentScopes.get(scopeKey)?.invalidation) {
		await disposePoolEntryForScope(scopeKey);
		return undefined;
	}
	const state = getSessionCursorAgentPoolState(scopeKey);
	if (state.status !== "ready" || !samePoolIdentity(state, poolKey, params.storeRoot)) return undefined;
	return leaseFromEntry(state, params, true);
}

async function createSessionAgentInstance(
	scopeKey: string,
	persistentStore: boolean,
	instanceId: number,
	params: SessionCursorAgentCreateParams,
): Promise<SessionCursorAgentInstance> {
	let bridgeRun: CursorPiToolBridgeRun | undefined;
	let sessionStore: OpenCursorSessionStore | undefined;
	let releaseAgentClaim: (() => void) | undefined;
	try {
		const registeredBridge = params.bridge;
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
		const resumeHandle = resumeEligible ? getMatchingCursorSessionAgentResumeHandle(resolvedPoolKey, scopeKey) : undefined;
		const storeSelection = await openCursorSessionStoreForScope({
			cwd: params.cwd,
			scopeKey: params.scope?.persistentScopeKey ?? scopeKey,
			persistent: persistentStore,
			storeRoot: params.storeRoot,
			resume: resumeHandle ? { identity: resumeHandle.storeIdentity, agentId: resumeHandle.agentId } : undefined,
		});
		sessionStore = storeSelection.sessionStore;
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
			...(params.nativeToolsEnabled === false ? { tools: ["mcp"] } : {}),
			...(bridgeRun?.mcpServers ? { mcpServers: bridgeRun.mcpServers } : {}),
			...(params.agents && Object.keys(params.agents).length ? { agents: params.agents } : {}),
		});
		let agent: SDKAgent | undefined;
		let effectiveSendState = FRESH_SEND_STATE;
		let resumed = false;
		if (resumeHandle && resumeAttemptAllowed && resumeAgent) {
			releaseAgentClaim = claimCursorLocalAgent(sessionStore.identity, resumeHandle.agentId);
		}
		if (resumeHandle && resumeAttemptAllowed && resumeAgent && releaseAgentClaim) {
			try {
				agent = await resumeAgent(resumeHandle.agentId, buildAgentOptions());
				effectiveSendState = resumeHandle.sendState;
				resumed = true;
			} catch {
				releaseAgentClaim();
				releaseAgentClaim = undefined;
				if (persistentStore) resumeNotice = LOCAL_RESUME_FALLBACK_NOTICE;
				if (storeSelection.persistent && !cursorSessionStoreIdentitiesEqual(sessionStore.identity, storeSelection.identities.sessionStore)) {
					const { identities } = storeSelection;
					const replacement = await openCursorSessionStore(params.cwd, identities.sessionStore, identities.workspaceRoot, identities.storeRoot);
					await sessionStore.dispose().catch(() => undefined);
					sessionStore = replacement;
				}
			}
		}
		agent ??= await createAgent(buildAgentOptions());
		if (!agent) throw new Error("Cursor SDK agent creation returned no agent");
		if (!sessionStore) throw new Error("Cursor SDK session store was not opened");
		releaseAgentClaim ??= claimCursorLocalAgent(sessionStore.identity, agent.agentId);
		if (!releaseAgentClaim) throw new Error("Cursor SDK agent is already owned by another runtime");

		return {
			poolKey: resolvedPoolKey,
			storeRoot: params.storeRoot,
			instanceId,
			scopeKey,
			agent,
			bridgeRun,
			sessionStore,
			sendState: effectiveSendState,
			resumed,
			releaseAgentClaim,
			...(resumeNotice ? { resumeNotice } : {}),
		};
	} catch (error) {
		bridgeRun?.cancel("Cursor session agent create failed");
		await bridgeRun?.dispose().catch(() => undefined);
		await sessionStore?.dispose().catch(() => undefined);
		releaseAgentClaim?.();
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
	scopeKey: string,
	options?: { deadTransport?: boolean },
): void {
	const scope = getSessionCursorAgentScope(scopeKey);
	scope.invalidation = (options?.deadTransport || scope.invalidation === "deadTransport") ? "deadTransport" : "stale";
}

export async function acquireSessionCursorAgent(input: SessionCursorAgentCreateParams): Promise<SessionCursorAgentLease> {
	const params = { ...input, scope: input.scope ?? getCursorSessionScopeSnapshot(), bridge: "bridge" in input ? input.bridge : getRegisteredCursorPiToolBridge() };
	const scopeKey = params.scope.scopeKey;
	const persistentStore = params.scope.sessionFile !== undefined;
	params.storeRoot = persistentStore && params.storeRoot !== undefined ? normalizeCursorCustomStoreRoot(params.storeRoot) : undefined;

	while (true) {
		assertScopeAcceptsAcquire(scopeKey);
		if (sessionAgentScopes.get(scopeKey)?.invalidation) {
			await disposePoolEntryForScope(scopeKey);
		}

		const poolKey = buildSessionAgentPoolKey(scopeKey, params);
		const state = getSessionCursorAgentPoolState(scopeKey);

		if ((state.status === "ready" || state.status === "busy") && !samePoolIdentity(state, poolKey, params.storeRoot)) {
			await disposePoolEntryForScope(scopeKey);
			continue;
		}

		if (state.status === "ready") {
			return leaseFromEntry(state, params, false);
		}

		if (state.status === "busy") {
			await state.pendingCompletion;
			continue;
		}

		if (state.status === "creating") {
			if (!samePoolIdentity(state, poolKey, params.storeRoot)) {
				await disposePoolEntryForScope(scopeKey);
				continue;
			}
			try {
				await state.creating;
			} catch (error) {
				if (error instanceof SessionCursorAgentCreationSupersededError) {
					assertScopeAcceptsAcquire(scopeKey);
					rethrowSupersededWhenReplacedByDifferentPoolIdentity(scopeKey, poolKey, params.storeRoot, error);
					continue;
				}
				throw error;
			}
			continue;
		}

		assertScopeAcceptsAcquire(scopeKey);
		const instanceId = allocateSessionAgentInstanceId();
		let placeholder: SessionCursorAgentCreatingEntry;
		const creating = createSessionAgentInstance(scopeKey, persistentStore, instanceId, params).then(async (instance) => {
			// Every reset or terminal disposal replaces the placeholder, so identity alone proves this creation is current.
			const scope = sessionAgentScopes.get(scopeKey);
			if (scope?.state !== placeholder) {
				await disposeSessionAgentInstance(instance);
				throw new SessionCursorAgentCreationSupersededError();
			}
			scope.state = { status: "ready", instance };
			return instance;
		});
		placeholder = {
			status: "creating",
			poolKey,
			storeRoot: params.storeRoot,
			creating,
		};
		getSessionCursorAgentScope(scopeKey).state = placeholder;

		try {
			await creating;
			const lease = await tryLeaseCreatedEntry(scopeKey, params, poolKey);
			if (lease) return lease;
			continue;
		} catch (error) {
			const scope = sessionAgentScopes.get(scopeKey);
			if (scope?.state === placeholder) {
				scope.state = EMPTY_POOL_STATE;
				pruneIdleSessionCursorAgentScope(scopeKey);
			}
			if (error instanceof SessionCursorAgentCreationSupersededError) {
				assertScopeAcceptsAcquire(scopeKey);
				rethrowSupersededWhenReplacedByDifferentPoolIdentity(scopeKey, poolKey, params.storeRoot, error);
				continue;
			}
			throw error;
		}
	}
}

export type RefreshSessionCursorAgentConfigResult = "reloaded" | "no-agent" | "busy" | "unsupported";

export async function refreshSessionCursorAgentConfig(scopeKey: string = getCursorSessionScopeKey()): Promise<RefreshSessionCursorAgentConfigResult> {
	const state = getSessionCursorAgentPoolState(scopeKey);
	if (state.status === "empty" || state.status === "creating") return "no-agent";
	if (state.status === "busy") return "busy";
	const { agent } = state.instance;
	if (typeof agent.reload !== "function") return "unsupported";
	await agent.reload();
	return "reloaded";
}

export async function resetSessionCursorAgent(scopeKey: string = getCursorSessionScopeKey()): Promise<void> {
	await disposePoolEntryForScope(scopeKey);
}

export async function disposeSessionCursorAgent(scopeKey: string = getCursorSessionScopeKey()): Promise<void> {
	await disposePoolEntryForScope(scopeKey, { terminal: true });
}

export async function disposeAllSessionCursorAgents(): Promise<void> {
	const scopeKeys = [...sessionAgentScopes]
		.filter(([, scope]) => scope.state.status !== "empty" || scope.closedAtSessionGeneration !== undefined)
		.map(([scopeKey]) => scopeKey);
	await Promise.all(scopeKeys.map((scopeKey) => disposePoolEntryForScope(scopeKey, { terminal: true })));
	for (const [scopeKey, scope] of sessionAgentScopes) {
		scope.invalidation = undefined;
		scope.closedAtSessionGeneration = undefined;
		pruneIdleSessionCursorAgentScope(scopeKey);
	}
}

export const __testUtils = {
	getSessionCursorAgentPoolState,
	invalidateSessionAgent,
	disposeSessionCursorAgent,
	resetSessionCursorAgent,
	refreshSessionCursorAgentConfig,
	disposeAllSessionCursorAgents,
	SessionCursorAgentCreationSupersededError,
	SessionCursorAgentScopeClosedError,
};
