import type {
	ExtensionHandler,
	SessionBeforeTreeEvent,
	SessionCompactEvent,
	SessionShutdownEvent,
	SessionTreeEvent,
} from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import type { AgentModeOption, ModelSelection, SDKAgent, SettingSource } from "@cursor/sdk";
import type { Context } from "@earendil-works/pi-ai";
import {
	getRegisteredCursorPiToolBridge,
	type CursorPiBridgeToolRequest,
	type CursorPiToolBridgeRun,
} from "./cursor-pi-tool-bridge.js";
import { computeCursorContextFingerprint } from "./context.js";
import { getCursorSessionScopeKey, onCursorSessionScopeKeyChange } from "./cursor-session-scope.js";
import type { CursorSdkEventDebugRecorder } from "./cursor-sdk-event-debug.js";
import { loadCursorSdk, type CursorSdkModule } from "./cursor-sdk-runtime.js";

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
	sendState: SessionCursorAgentSendState;
	created: boolean;
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
}

interface SessionCursorAgentBusyEntry extends SessionCursorAgentPoolEntryBase {
	status: "busy";
	agent: SDKAgent;
	bridgeRun?: CursorPiToolBridgeRun;
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
	if (terminalDisposedScopeKeys.has(scopeKey)) {
		throw new SessionCursorAgentScopeClosedError();
	}
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
	onBridgeToolRequest?: (request: CursorPiBridgeToolRequest) => void;
	debugRecorder?: CursorSdkEventDebugRecorder;
	createAgent?: CursorSdkModule["Agent"]["create"];
}

interface CursorSessionAgentExtensionApi {
	on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>): void;
	on(event: "session_compact", handler: ExtensionHandler<SessionCompactEvent>): void;
	on(event: "session_before_tree", handler: ExtensionHandler<SessionBeforeTreeEvent>): void;
	on(event: "session_tree", handler: ExtensionHandler<SessionTreeEvent>): void;
	on(event: "model_select", handler: ExtensionHandler<{ model: unknown }>): void;
}

const sessionAgentsByScope = new Map<string, SessionCursorAgentPoolEntry>();
const invalidatedScopeKeys = new Set<string>();
const terminalDisposedScopeKeys = new Set<string>();
const scopeCreationGenerations = new Map<string, number>();
const EMPTY_POOL_STATE: SessionCursorAgentPoolState = { status: "empty" };
let nextSessionAgentInstanceId = 1;

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
		buildApiKeyPoolKeyFingerprint(params.apiKey),
		buildBridgePoolKeySuffix(),
	].join("\0");
}

async function disposePoolEntry(entry: SessionCursorAgentPoolEntry): Promise<void> {
	if (!isActivePoolEntry(entry)) return;
	entry.bridgeRun?.cancel("Cursor session agent disposed");
	try {
		await entry.bridgeRun?.dispose();
	} catch {
		// disposal failure should not block session replacement
	}
	try {
		await entry.agent[Symbol.asyncDispose]();
	} catch {
		// disposal failure should not block session replacement
	}
}

async function disposePoolEntryForScope(scopeKey: string, options?: { terminal?: boolean }): Promise<void> {
	invalidateScopeCreations(scopeKey);
	if (options?.terminal) {
		terminalDisposedScopeKeys.add(scopeKey);
	}
	const entry = sessionAgentsByScope.get(scopeKey);
	invalidatedScopeKeys.delete(scopeKey);
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
	await disposePoolEntry(entry);
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
		return;
	}
	entry.sendState.incrementalSendCount += 1;
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
	bindBridgeToolRequest(entry, params.onBridgeToolRequest);
	entry.bridgeRun?.setDebugRecorder(params.debugRecorder);
	return {
		scopeKey,
		poolKey: entry.poolKey,
		instanceId: entry.instanceId,
		agent: entry.agent,
		bridgeRun: entry.bridgeRun,
		sendState: entry.sendState,
		created,
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
	instanceId: number,
	sendState: SessionCursorAgentSendState,
	params: SessionCursorAgentCreateParams,
): Promise<SessionCursorAgentReadyEntry> {
	const registeredBridge = getRegisteredCursorPiToolBridge();
	let bridgeRun: CursorPiToolBridgeRun | undefined;
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
	const createAgent = params.createAgent ?? (await loadCursorSdk()).Agent.create;
	let agent: SDKAgent;
	try {
		agent = await createAgent({
			apiKey: params.apiKey,
			model: params.modelSelection,
			mode: params.agentMode,
			local: params.settingSources ? { cwd: params.cwd, settingSources: params.settingSources } : { cwd: params.cwd },
			...(bridgeRun?.mcpServers ? { mcpServers: bridgeRun.mcpServers } : {}),
		});
	} catch (error) {
		if (bridgeRun) {
			bridgeRun.cancel("Cursor session agent create failed");
			try {
				await bridgeRun.dispose();
			} catch {
				// bridge disposal failure should not mask agent create failure
			}
		}
		throw error;
	}

	return {
		status: "ready",
		poolKey: resolvedPoolKey,
		instanceId,
		scopeKey,
		agent,
		bridgeRun,
		sendState,
	};
}

export {
	buildCursorSessionSendPrompt,
	MAX_COMPLETED_INCREMENTAL_SENDS_BEFORE_REBOOTSTRAP,
	planCursorSessionSend,
	type CursorSessionSendPlan,
} from "./cursor-session-send-policy.js";
export { shouldBootstrapCursorContext, shouldBootstrapCursorSend } from "./context.js";

export function invalidateSessionAgent(scopeKey: string = getCursorSessionScopeKey()): void {
	invalidatedScopeKeys.add(scopeKey);
}

export async function acquireSessionCursorAgent(params: SessionCursorAgentCreateParams): Promise<SessionCursorAgentLease> {
	const scopeKey = getCursorSessionScopeKey();

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
		const creating = createSessionAgentEntry(scopeKey, instanceId, sendState, params).then(async (createdEntry) => {
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

export async function resetSessionCursorAgent(scopeKey: string = getCursorSessionScopeKey()): Promise<void> {
	await disposePoolEntryForScope(scopeKey);
}

export async function disposeSessionCursorAgent(scopeKey: string = getCursorSessionScopeKey()): Promise<void> {
	await disposePoolEntryForScope(scopeKey, { terminal: true });
}

export async function disposeAllSessionCursorAgents(): Promise<void> {
	const scopeKeys = [...new Set([...sessionAgentsByScope.keys(), ...terminalDisposedScopeKeys])];
	await Promise.all(scopeKeys.map((scopeKey) => disposePoolEntryForScope(scopeKey, { terminal: true })));
	invalidatedScopeKeys.clear();
	terminalDisposedScopeKeys.clear();
}

export function registerCursorSessionAgent(_pi: CursorSessionAgentExtensionApi): void {
	onCursorSessionScopeKeyChange((previousScopeKey) => {
		void disposePoolEntryForScope(previousScopeKey, { terminal: true });
	});
	_pi.on("session_shutdown", async (event) => {
		if (event.reason === "reload") {
			await resetSessionCursorAgent();
			return;
		}
		await disposeSessionCursorAgent();
	});
	_pi.on("session_compact", () => {
		invalidateSessionAgent();
	});
	_pi.on("session_before_tree", () => {
		invalidateSessionAgent();
	});
	_pi.on("session_tree", async () => {
		await resetSessionCursorAgent();
	});
	_pi.on("model_select", () => {
		invalidateSessionAgent();
	});
}

export const __testUtils = {
	sessionAgentsByScope,
	getSessionCursorAgentPoolState,
	invalidateSessionAgent,
	disposeSessionCursorAgent,
	resetSessionCursorAgent,
	disposeAllSessionCursorAgents,
	buildApiKeyPoolKeyFingerprint,
	buildSessionAgentPoolKey,
	SessionCursorAgentCreationSupersededError,
	SessionCursorAgentScopeClosedError,
};
