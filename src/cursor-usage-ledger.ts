import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { AgentUsage, SDKAgent, TokenUsage, UsageCost } from "@cursor/sdk";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendDurableFrame, fsyncExistingRegularFile, readDurableFramePrefix } from "./cursor-durable-fs.js";
import { fetchCursorSdkAgentUsage, readCursorBilledSnapshot, readCursorUsageTokens, type CursorBillingObservation } from "./cursor-sdk-billed-usage.js";
import { asRecord } from "./cursor-record-utils.js";

export type CursorUsageApi = Pick<ExtensionAPI, "appendEntry">;
export type CursorUsageLedgerApi = Pick<ExtensionAPI, "appendEntry" | "on">;
const CUSTOM_TYPE = "pi-cursor-sdk:usage-v1";
const CLAIM_TYPE = "pi-cursor-sdk:usage-origin-v1";
const JOURNAL_LIMIT = "16MiB per origin session";
export interface CursorUsageOrigin {
	sessionFile?: string;
	sessionId: string;
	anchorId: string | null;
}
export interface CursorUsageStart {
	agent: SDKAgent;
	runtime: "local" | "cloud";
	model: Pick<Model<Api>, "id" | "provider" | "cost">;
	modelSelection: unknown;
	purpose: "normal" | "compaction" | "tree";
	storeIdentity?: string;
	resumed: boolean;
	newlyCreated: boolean;
}
export interface CursorUsageTurnRecorder {
	observeRawTurn(usage: unknown): void;
	recordRun(ids: { runId?: string; requestId?: string }): Promise<void>;
	recordTerminal(result: { status: "success" | "error" | "abort" | "abandon"; waitUsage?: unknown; handleUsage?: unknown }): Promise<CursorBillingObservation | undefined>;
	recordSnapshot(): Promise<CursorBillingObservation>;
	notePersistenceFailure(error: unknown): void;
}
export interface CursorUsageRecorder {
	start(input: CursorUsageStart): Promise<CursorUsageTurnRecorder>;
	notePersistenceFailure(error: unknown): void;
}
type StartData = Omit<CursorUsageStart, "agent" | "modelSelection"> & {
	agentId: string;
	modelSelection: { id: string; params?: { id: string; value: string }[] };
};
type BillingRevision =
	| Extract<CursorBillingObservation, { status: "unavailable" }>
	| { status: "observed-pending-settlement"; usage: TokenUsage; cost?: UsageCost; upsertRuns: AgentUsage["runs"]; deletedRunIds: string[] };
type Event =
	| { kind: "start"; data: StartData }
	| { kind: "raw"; reported: TokenUsage; reportedTotalSource: "sdk" | "derived-additive"; normalization: "local-full-prompt" | "invalid-local-partition" | "cloud-unqualified"; corrected?: TokenUsage }
	| { kind: "run"; runId?: string; requestId?: string }
	| { kind: "terminal"; status: "success" | "error" | "abort" | "abandon"; waitUsage?: TokenUsage; handleUsage?: TokenUsage; invalidReportedUsage?: boolean }
	| { kind: "billing"; observation: BillingRevision }
	| { kind: "refresh"; agentId: string; sourceOrigin: CursorUsageOrigin; observation: BillingRevision };
export type CursorUsageRecord = Event & { version: 1; id: string; turnId: string; timestamp: string; origin: CursorUsageOrigin };
type UsageAggregate = Pick<AgentUsage, "usage" | "cost">;
type OriginObservation = { origin: CursorUsageOrigin; lastAttempt: BillingRevision; latestAggregate?: UsageAggregate; wholeAgent?: AgentUsage; incompleteHistory: boolean };
export interface CursorUsageAgentView {
	agentId: string;
	unknownHistory: boolean;
	sharedAcrossBranches: boolean;
	billingStatus: "pending" | "unavailable" | "observed-pending-settlement" | "ambiguous-shared-lineage";
	observationsByOrigin: OriginObservation[];
	lastAttempt?: BillingRevision;
	latestAggregate?: UsageAggregate;
	wholeAgent?: AgentUsage;
	aggregateOnly?: TokenUsage;
	aggregateOnlyCost?: UsageCost;
	costReconciliation?: "not-reported" | "observed" | "inconsistent";
}
export interface CursorUsageView {
	version: 1;
	durability: "durable" | "ephemeral";
	origin: CursorUsageOrigin;
	persistenceStatus: "ok" | "incomplete";
	lineageGaps: string[];
	journalLimit: string;
	nativeConfiguredEstimates: string;
	records: CursorUsageRecord[];
	otherBranchRecords: CursorUsageRecord[];
	unclaimedRecords: CursorUsageRecord[];
	inheritedUnclaimedRecords: CursorUsageRecord[];
	incompleteJournals: string[];
	agents: CursorUsageAgentView[];
	correctedRawTotal: TokenUsage;
}
const bindings = new WeakMap<CursorUsageApi, ExtensionContext>();
const failures = new WeakMap<CursorUsageApi, Set<string>>();
const ephemeral = new WeakMap<CursorUsageApi, Map<string, CursorUsageRecord[]>>();
const tokenKeys = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens"] as const;
const zero = (): TokenUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 });
const ownerKey = (origin: CursorUsageOrigin) => JSON.stringify([origin.sessionFile, origin.sessionId]);
function originOf(ctx: ExtensionContext): CursorUsageOrigin {
	const manager = ctx.sessionManager;
	return { sessionFile: manager.getSessionFile(), sessionId: manager.getSessionId(), anchorId: manager.getLeafId() };
}
function journalPath(origin: CursorUsageOrigin): string | undefined {
	if (!origin.sessionFile) return undefined;
	const digest = createHash("sha256").update(origin.sessionId).digest("hex").slice(0, 32);
	return join(dirname(origin.sessionFile), `cursor-usage-${digest}.journal`);
}
const storageKey = (origin: CursorUsageOrigin) => journalPath(origin) ?? origin.sessionId;
function text(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f]/.test(value);
}
function only(record: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(record).every(key => keys.includes(key));
}
function validateOrigin(value: unknown): CursorUsageOrigin {
	const origin = asRecord(value);
	if (!origin || !only(origin, ["sessionFile", "sessionId", "anchorId"]) || !text(origin.sessionId) ||
		(origin.sessionFile !== undefined && (!text(origin.sessionFile) || !isAbsolute(origin.sessionFile))) ||
		(origin.anchorId !== null && !text(origin.anchorId))) throw new Error("invalid Cursor usage origin");
	return structuredClone(value) as CursorUsageOrigin;
}
function cleanSelection(value: unknown): StartData["modelSelection"] {
	const selection = asRecord(value);
	if (!selection || !only(selection, ["id", "params"]) || !text(selection.id) || (selection.params !== undefined && !Array.isArray(selection.params))) throw new Error("invalid Cursor model selection");
	return {
		id: selection.id,
		...(Array.isArray(selection.params) ? { params: selection.params.map(item => {
			const parameter = asRecord(item);
			if (!parameter || !only(parameter, ["id", "value"]) || !text(parameter.id) || !text(parameter.value)) throw new Error("invalid Cursor model parameter");
			return { id: parameter.id, value: parameter.value };
		}) } : {}),
	};
}
function cleanModel(value: unknown): CursorUsageStart["model"] {
	const model = asRecord(value);
	const cost = asRecord(model?.cost);
	const rateKeys = ["input", "output", "cacheRead", "cacheWrite"];
	const ratesValid = (rates: Record<string, unknown>) => rateKeys.every(key => typeof rates[key] === "number" && Number.isFinite(rates[key]) && (rates[key] as number) >= 0);
	if (!model || !only(model, ["id", "provider", "cost"]) || !text(model.id) || !text(model.provider) || !cost || !only(cost, [...rateKeys, "tiers"]) || !ratesValid(cost)) throw new Error("invalid Cursor model pricing");
	if (cost.tiers !== undefined && (!Array.isArray(cost.tiers) || !cost.tiers.every(item => {
		const tier = asRecord(item);
		return tier && only(tier, [...rateKeys, "inputTokensAbove"]) && ratesValid(tier) && Number.isSafeInteger(tier.inputTokensAbove) && (tier.inputTokensAbove as number) >= 0;
	}))) throw new Error("invalid Cursor model pricing tiers");
	return structuredClone(value) as CursorUsageStart["model"];
}
function validateRecord(value: unknown): CursorUsageRecord {
	const record = asRecord(value);
	const fields: Record<string, string[]> = {
		start: ["data"], raw: ["reported", "reportedTotalSource", "normalization", "corrected"], run: ["runId", "requestId"],
		terminal: ["status", "waitUsage", "handleUsage", "invalidReportedUsage"], billing: ["observation"], refresh: ["agentId", "sourceOrigin", "observation"],
	};
	if (!record || record.version !== 1 || !text(record.id) || !text(record.turnId) || !text(record.timestamp) || !Number.isFinite(Date.parse(record.timestamp)) ||
		!fields[String(record.kind)] || !only(record, ["version", "id", "turnId", "timestamp", "origin", "kind", ...fields[String(record.kind)]!])) throw new Error("invalid Cursor usage journal record");
	validateOrigin(record.origin);
	let valid = false;
	switch (record.kind) {
		case "start": {
			const data = asRecord(record.data);
			valid = !!data && only(data, ["agentId", "runtime", "model", "modelSelection", "purpose", "storeIdentity", "resumed", "newlyCreated"]) && text(data.agentId) &&
				["local", "cloud"].includes(String(data.runtime)) && ["normal", "compaction", "tree"].includes(String(data.purpose)) &&
				typeof data.resumed === "boolean" && typeof data.newlyCreated === "boolean" && !(data.resumed && data.newlyCreated) && (data.storeIdentity === undefined || text(data.storeIdentity));
			if (valid) { cleanModel(data!.model); cleanSelection(data!.modelSelection); }
			break;
		}
		case "raw":
			valid = !!readCursorUsageTokens(record.reported) && ["sdk", "derived-additive"].includes(String(record.reportedTotalSource)) &&
				["local-full-prompt", "invalid-local-partition", "cloud-unqualified"].includes(String(record.normalization)) &&
				(record.normalization === "local-full-prompt" ? !!readCursorUsageTokens(record.corrected) : record.corrected === undefined);
			break;
		case "run": valid = (record.runId === undefined || text(record.runId)) && (record.requestId === undefined || text(record.requestId)); break;
		case "terminal":
			valid = (record.invalidReportedUsage === undefined || typeof record.invalidReportedUsage === "boolean") && ["success", "error", "abort", "abandon"].includes(String(record.status)) &&
				(record.waitUsage === undefined || !!readCursorUsageTokens(record.waitUsage)) && (record.handleUsage === undefined || !!readCursorUsageTokens(record.handleUsage));
			break;
		case "refresh":
			if (!text(record.agentId)) throw new Error("invalid Cursor usage refresh agent");
			validateOrigin(record.sourceOrigin);
		case "billing": {
			const observation = asRecord(record.observation);
			if (!observation) break;
			if (observation.status === "unavailable") {
				valid = only(observation, ["status", "reason"]) && ["timeout", "unsupported", "request-failed", "invalid-response"].includes(String(observation.reason));
				break;
			}
			const snapshot = readCursorBilledSnapshot({ usage: observation.usage, cost: observation.cost, runs: observation.upsertRuns });
			const deleted = observation.deletedRunIds;
			valid = observation.status === "observed-pending-settlement" && only(observation, ["status", "usage", "cost", "upsertRuns", "deletedRunIds"]) &&
				!!snapshot && Array.isArray(deleted) && deleted.every(id => text(id) && id.length <= 256) &&
				new Set(deleted).size === deleted.length && !snapshot.runs.some(row => deleted.includes(row.runId));
			break;
		}
	}
	if (!valid) throw new Error("invalid Cursor usage journal payload");
	const clean = structuredClone(value) as CursorUsageRecord;
	if ((clean.kind === "billing" || clean.kind === "refresh") && clean.observation.status === "observed-pending-settlement") {
		const snapshot = readCursorBilledSnapshot({ usage: clean.observation.usage, cost: clean.observation.cost, runs: clean.observation.upsertRuns })!;
		clean.observation = { ...clean.observation, usage: snapshot.usage, cost: snapshot.cost, upsertRuns: snapshot.runs };
	}
	if (clean.kind === "raw") { clean.reported = readCursorUsageTokens(clean.reported)!; clean.corrected = readCursorUsageTokens(clean.corrected); }
	if (clean.kind === "terminal") { clean.waitUsage = readCursorUsageTokens(clean.waitUsage); clean.handleUsage = readCursorUsageTokens(clean.handleUsage); }
	return clean;
}
function applyBillingRevision(revision: BillingRevision, previous?: AgentUsage): CursorBillingObservation {
	if (revision.status === "unavailable") return revision;
	const rows = new Map(previous?.runs.map(row => [row.runId, row]));
	for (const id of revision.deletedRunIds) rows.delete(id);
	for (const row of revision.upsertRuns) rows.set(row.runId, row);
	const snapshot = readCursorBilledSnapshot({ usage: revision.usage, cost: revision.cost, runs: [...rows.values()] });
	if (!snapshot) throw new Error("invalid Cursor billing revision history");
	return { status: "observed-pending-settlement", snapshot };
}
function latestAgentSnapshot(records: CursorUsageRecord[], agentId: string): AgentUsage | undefined {
	const turns = new Map<string, string>();
	let snapshot: AgentUsage | undefined;
	for (const record of records) {
		if (record.kind === "start") turns.set(record.turnId, record.data.agentId);
		if (record.kind === "refresh") turns.set(record.turnId, record.agentId);
		if ((record.kind === "billing" || record.kind === "refresh") && turns.get(record.turnId) === agentId) {
			const observation = applyBillingRevision(record.observation, snapshot);
			if (observation.status === "observed-pending-settlement") snapshot = observation.snapshot;
		}
	}
	return snapshot;
}
function billingRevision(observation: CursorBillingObservation, previous?: AgentUsage): BillingRevision {
	if (observation.status === "unavailable") return observation;
	const { usage, cost, runs } = observation.snapshot;
	const oldRows = new Map(previous?.runs.map(row => [row.runId, row]));
	const newIds = new Set(runs.map(row => row.runId));
	return {
		status: observation.status, usage, cost,
		upsertRuns: runs.filter(row => JSON.stringify(oldRows.get(row.runId)) !== JSON.stringify(row)),
		deletedRunIds: [...oldRows.keys()].filter(id => !newIds.has(id)),
	};
}
function validateHistory(values: unknown[], origin: CursorUsageOrigin): CursorUsageRecord[] {
	const records = values.map(validateRecord);
	const ids = new Set<string>();
	const starts = new Map<string, CursorUsageRecord & ({ kind: "start" } | { kind: "refresh" })>();
	for (const record of records) {
		if (record.origin.sessionId !== origin.sessionId || ids.has(record.id)) throw new Error("Cursor usage journal origin or identity mismatch");
		ids.add(record.id);
		if (record.kind === "start" || record.kind === "refresh") {
			if (starts.has(record.turnId)) throw new Error("duplicate Cursor usage turn");
			starts.set(record.turnId, record);
		} else {
			const start = starts.get(record.turnId);
			if (!start || JSON.stringify(start.origin) !== JSON.stringify(record.origin)) throw new Error("Cursor usage lineage mismatch");
			if (record.kind === "raw" && record.corrected) {
				const expected = record.reported.inputTokens - record.reported.cacheReadTokens - record.reported.cacheWriteTokens;
				if (start.kind !== "start" || start.data.runtime !== "local" || record.corrected.inputTokens !== expected ||
					record.corrected.totalTokens !== expected + record.reported.cacheReadTokens + record.reported.cacheWriteTokens + record.reported.outputTokens ||
					["outputTokens", "cacheReadTokens", "cacheWriteTokens"].some(key => record.corrected![key as keyof TokenUsage] !== record.reported[key as keyof TokenUsage])) throw new Error("Cursor usage raw partition mismatch");
			}
		}
	}
	const snapshots = new Map<string, AgentUsage>();
	for (const record of records) if (record.kind === "billing" || record.kind === "refresh") {
		const start = starts.get(record.turnId)!;
		const agentId = start.kind === "start" ? start.data.agentId : start.agentId;
		const observation = applyBillingRevision(record.observation, snapshots.get(agentId));
		if (observation.status === "observed-pending-settlement") snapshots.set(agentId, observation.snapshot);
	}
	return records;
}
function readOrigin(pi: CursorUsageApi, origin: CursorUsageOrigin): CursorUsageRecord[] {
	const path = journalPath(origin);
	return validateHistory(path ? readDurableFramePrefix(path).frames : ephemeral.get(pi)?.get(origin.sessionId) ?? [], origin);
}
function persist(pi: CursorUsageApi, record: CursorUsageRecord): void {
	const path = journalPath(record.origin);
	if (path) {
		// ponytail: bounded 16MiB journals are revalidated per append; migrate to indexed framed storage when this explicit ceiling is reached.
		appendDurableFrame(path, record, values => { validateHistory(values, record.origin); });
	} else {
		let sessions = ephemeral.get(pi);
		if (!sessions) { sessions = new Map(); ephemeral.set(pi, sessions); }
		const records = sessions.get(record.origin.sessionId) ?? [];
		validateHistory([...records, record], record.origin);
		records.push(structuredClone(record));
		sessions.set(record.origin.sessionId, records);
	}
}
function currentMatches(pi: CursorUsageApi, origin: CursorUsageOrigin): boolean {
	const ctx = bindings.get(pi);
	if (!ctx) return false;
	const current = originOf(ctx);
	return ownerKey(current) === ownerKey(origin) && (origin.anchorId ? ctx.sessionManager.getBranch().some(entry => entry.id === origin.anchorId) : current.anchorId === null);
}
function claimOrigin(pi: CursorUsageApi, captured: CursorUsageOrigin, turnId: string): CursorUsageOrigin {
	if (!currentMatches(pi, captured)) throw new Error("Cursor usage origin changed before operation");
	pi.appendEntry(CLAIM_TYPE, { version: 1, turnId, origin: captured });
	const current = bindings.get(pi)!;
	const entry = current.sessionManager.getLeafEntry();
	if (entry?.type !== "custom" || entry.customType !== CLAIM_TYPE || asRecord(entry.data)?.turnId !== turnId) throw new Error("Cursor usage origin claim was not appended");
	const origin = originOf(current);
	if (ownerKey(origin) !== ownerKey(captured)) throw new Error("Cursor usage origin changed during claim");
	if (origin.sessionFile && existsSync(origin.sessionFile) && !fsyncExistingRegularFile(origin.sessionFile)) throw new Error("Cursor usage origin claim was not durable");
	return origin;
}
export function captureCursorUsageRecorder(pi: CursorUsageApi, ctx: ExtensionContext): CursorUsageRecorder {
	const captured = originOf(ctx);
	bindings.set(pi, ctx);
	const notePersistenceFailure = (_error: unknown) => {
		let owners = failures.get(pi);
		if (!owners) { owners = new Set(); failures.set(pi, owners); }
		const key = ownerKey(captured);
		if (owners.has(key)) return;
		owners.add(key);
		if (currentMatches(pi, captured)) bindings.get(pi)?.ui.notify("Cursor usage persistence failed; accounting is incomplete. New sends require a recorded origin. See /cursor-usage help for recovery.", "warning");
	};
	return { notePersistenceFailure, async start(input) {
		const turnId = randomUUID();
		const data: StartData = {
			agentId: input.agent.agentId, runtime: input.runtime,
			model: cleanModel({ id: input.model.id, provider: input.model.provider, cost: input.model.cost }),
			modelSelection: cleanSelection(input.modelSelection), purpose: input.purpose,
			storeIdentity: input.storeIdentity, resumed: input.resumed, newlyCreated: input.newlyCreated,
		};
		if (input.resumed && input.newlyCreated) throw new Error("Cursor usage lineage cannot be both resumed and newly created");
		// Unique public branch claim before spend; ordinary optional mirrors cannot establish ownership.
		const origin = claimOrigin(pi, captured, turnId);
		const write = (event: Event) => {
			const record: CursorUsageRecord = { ...event, version: 1, id: randomUUID(), turnId, timestamp: new Date().toISOString(), origin: structuredClone(origin) };
			persist(pi, record);
			if (currentMatches(pi, origin)) {
				try { pi.appendEntry(CUSTOM_TYPE, record); } catch { /* Fsynced journal and unique native claim are authoritative. */ }
			}
		};
		write({ kind: "start", data });
		const recordSnapshot = async () => {
			const observation = await fetchCursorSdkAgentUsage(input.agent);
			write({ kind: "billing", observation: billingRevision(observation, latestAgentSnapshot(readOrigin(pi, origin), input.agent.agentId)) });
			return observation;
		};
		return {
			observeRawTurn(value) {
				const raw = asRecord(value);
				if (!raw) return;
				const reported = readCursorUsageTokens({ ...raw, totalTokens: raw.totalTokens ?? Number(raw.inputTokens) + Number(raw.outputTokens) + Number(raw.cacheReadTokens) + Number(raw.cacheWriteTokens) });
				if (!reported) throw new Error("invalid Cursor raw numeric usage");
				const reportedTotalSource = raw.totalTokens === undefined ? "derived-additive" as const : "sdk" as const;
				if (input.runtime === "cloud") { write({ kind: "raw", reported, reportedTotalSource, normalization: "cloud-unqualified" }); return; }
				const inputTokens = reported.inputTokens - reported.cacheReadTokens - reported.cacheWriteTokens;
				const corrected = readCursorUsageTokens({ ...reported, inputTokens, totalTokens: inputTokens + reported.cacheReadTokens + reported.cacheWriteTokens + reported.outputTokens });
				write({ kind: "raw", reported, reportedTotalSource, normalization: corrected ? "local-full-prompt" : "invalid-local-partition", ...(corrected ? { corrected } : {}) });
			},
			async recordRun(ids) { write({ kind: "run", ...ids }); },
			async recordTerminal(result) {
				const waitUsage = readCursorUsageTokens(result.waitUsage);
				const handleUsage = readCursorUsageTokens(result.handleUsage);
				write({ kind: "terminal", status: result.status, waitUsage, handleUsage,
					...((result.waitUsage !== undefined && !waitUsage) || (result.handleUsage !== undefined && !handleUsage) ? { invalidReportedUsage: true } : {}) });
				return result.status === "abandon" ? undefined : recordSnapshot();
			},
			recordSnapshot, notePersistenceFailure,
		};
	} };
}

/** Append chronology owns revisions. Wall clocks are display metadata, never reconciliation authority. */
export function readCursorUsageView(pi: CursorUsageApi, ctx: ExtensionContext): CursorUsageView {
	const origin = originOf(ctx);
	const branch = ctx.sessionManager.getBranch();
	const mirrors = branch.flatMap(entry => entry.type === "custom" && entry.customType === CUSTOM_TYPE ? [validateRecord(entry.data)] : []);
	const readClaims = (entries: typeof branch) => entries.flatMap(entry => {
		if (entry.type !== "custom" || entry.customType !== CLAIM_TYPE) return [];
		const data = asRecord(entry.data);
		if (!data || !only(data, ["version", "turnId", "origin"]) || data.version !== 1 || !text(data.turnId)) throw new Error("invalid Cursor usage origin claim");
		return [{ entryId: entry.id, turnId: data.turnId, origin: validateOrigin(data.origin) }];
	});
	const claims = readClaims(branch);
	const sessionClaims = readClaims(ctx.sessionManager.getEntries());
	const origins = new Map<string, CursorUsageOrigin>();
	for (const inherited of [...claims.map(claim => claim.origin), ...mirrors.map(record => record.origin), origin]) origins.set(storageKey(inherited), inherited);
	const groups = new Map<string, CursorUsageRecord[]>();
	const incompleteGroups = new Set<string>();
	const lineageGaps: string[] = [];
	const incompleteJournals: string[] = [];
	for (const [key, owner] of origins) {
		let records: CursorUsageRecord[];
		try {
			const path = journalPath(owner);
			const prefix = path ? readDurableFramePrefix(path) : undefined;
			records = prefix ? validateHistory(prefix.frames, owner) : readOrigin(pi, owner);
			if (prefix?.incompleteTail) incompleteJournals.push(owner.sessionId);
			if (!records.length && (mirrors.some(record => storageKey(record.origin) === key) || claims.some(claim => storageKey(claim.origin) === key))) {
				records = mirrors.filter(record => storageKey(record.origin) === key);
				incompleteGroups.add(key);
				lineageGaps.push(`Origin ${owner.sessionId}: journal missing or without recognized frames; only native branch claim/mirror facts remain, accounting is incomplete.`);
			}
		} catch {
			if (key === storageKey(origin)) throw new Error("current Cursor usage journal unavailable or invalid");
			// The inherited branch is the authority for these mirror facts, not a directory guess or sibling scan.
			records = mirrors.filter(record => storageKey(record.origin) === key);
			incompleteGroups.add(key);
			lineageGaps.push(`Inherited origin ${owner.sessionId}: journal unavailable; preserved branch mirrors may be incomplete.`);
		}
		groups.set(key, records);
	}
	const all = [...groups.values()].flat();
	const claimedTurns = (items: typeof claims) => new Set(items.filter(claim => all.some(record => (record.kind === "start" || record.kind === "refresh") && record.turnId === claim.turnId && record.origin.anchorId === claim.entryId && ownerKey(record.origin) === ownerKey(claim.origin))).map(claim => claim.turnId));
	const selected = claimedTurns(claims);
	const knownClaims = claimedTurns(sessionClaims);
	const records = all.filter(record => selected.has(record.turnId));
	const outsideBranch = all.filter(record => !selected.has(record.turnId));
	const otherBranchRecords = outsideBranch.filter(record => knownClaims.has(record.turnId));
	const unclaimedRecords = outsideBranch.filter(record => !knownClaims.has(record.turnId) && storageKey(record.origin) === storageKey(origin));
	const inheritedUnclaimedRecords = outsideBranch.filter(record => !knownClaims.has(record.turnId) && storageKey(record.origin) !== storageKey(origin));
	const agents = new Map<string, CursorUsageAgentView>();
	const turnAgents = new Map<string, string>();
	const correctedRawTotal = zero();
	for (const record of all) {
		if (record.kind === "start") turnAgents.set(record.turnId, record.data.agentId);
		if (record.kind === "refresh") turnAgents.set(record.turnId, record.agentId);
	}
	for (const record of records) {
		if (record.kind === "raw" && record.corrected) for (const key of tokenKeys) {
			correctedRawTotal[key] += record.corrected[key];
			if (!Number.isSafeInteger(correctedRawTotal[key])) throw new Error("Cursor usage total exceeds safe integer range");
		}
		const agentId = record.kind === "start" ? record.data.agentId : record.kind === "refresh" ? record.agentId : undefined;
		if (agentId && !agents.has(agentId)) agents.set(agentId, {
			agentId, unknownHistory: true, sharedAcrossBranches: false, billingStatus: "pending", observationsByOrigin: [],
		});
	}
	for (const agent of agents.values()) {
		const agentRecords = all.filter(record => turnAgents.get(record.turnId) === agent.agentId);
		agent.sharedAcrossBranches = agentRecords.some(record => !selected.has(record.turnId)) || new Set(agentRecords.map(record => ownerKey(record.origin))).size > 1;
		agent.unknownHistory = !agentRecords.some(record => record.kind === "start" && record.data.newlyCreated);
		for (const [key, group] of groups) {
			let observation: OriginObservation | undefined;
			const incompleteHistory = incompleteGroups.has(key);
			const rows = new Map<string, AgentUsage["runs"][number]>();
			for (const record of group) if ((record.kind === "billing" || record.kind === "refresh") && turnAgents.get(record.turnId) === agent.agentId) {
				const revision = record.observation;
				let wholeAgent = observation?.wholeAgent;
				let latestAggregate = observation?.latestAggregate;
				if (revision.status === "observed-pending-settlement") {
					latestAggregate = { usage: revision.usage, cost: revision.cost };
					if (!incompleteHistory) {
						for (const id of revision.deletedRunIds) rows.delete(id);
						for (const row of revision.upsertRuns) rows.set(row.runId, row);
						wholeAgent = readCursorBilledSnapshot({ ...latestAggregate, runs: [...rows.values()] });
					}
				}
				observation = { origin: record.origin, lastAttempt: revision, latestAggregate, wholeAgent, incompleteHistory };
			}
			if (observation) agent.observationsByOrigin.push(observation);
		}
		if (agent.observationsByOrigin.length > 1) { agent.billingStatus = "ambiguous-shared-lineage"; continue; }
		const observation = agent.observationsByOrigin[0];
		if (!observation) continue;
		agent.lastAttempt = observation.lastAttempt;
		agent.latestAggregate = observation.latestAggregate;
		agent.wholeAgent = observation.wholeAgent;
		agent.billingStatus = observation.lastAttempt.status;
		if (!agent.wholeAgent || observation.incompleteHistory) continue;
		const remainder = { ...agent.wholeAgent.usage };
		for (const row of agent.wholeAgent.runs) for (const key of tokenKeys) remainder[key] -= row.usage[key];
		agent.aggregateOnly = remainder;
		agent.costReconciliation = "not-reported";
		if (agent.wholeAgent.cost && agent.wholeAgent.runs.every(row => row.cost)) {
			const cost = {
				rawCostCents: agent.wholeAgent.cost.rawCostCents - agent.wholeAgent.runs.reduce((sum, row) => sum + row.cost!.rawCostCents, 0),
				chargedCents: agent.wholeAgent.cost.chargedCents - agent.wholeAgent.runs.reduce((sum, row) => sum + row.cost!.chargedCents, 0),
			};
			if (cost.rawCostCents >= 0 && cost.chargedCents >= 0) { agent.aggregateOnlyCost = cost; agent.costReconciliation = "observed"; }
			else agent.costReconciliation = "inconsistent";
		}
	}
	return {
		version: 1, durability: origin.sessionFile ? "durable" : "ephemeral", origin,
		persistenceStatus: failures.get(pi)?.has(ownerKey(origin)) || lineageGaps.length || incompleteJournals.length ? "incomplete" : "ok",
		lineageGaps, incompleteJournals, journalLimit: JOURNAL_LIMIT, records, otherBranchRecords, unclaimedRecords, inheritedUnclaimedRecords, agents: [...agents.values()], correctedRawTotal,
		nativeConfiguredEstimates: "Native Pi /stats retains configured-price estimates for emitted messages, not full Cursor invoice totals. Raw telemetry and whole-agent billed snapshots are separate overlapping sources; do not sum them.",
	};
}
export async function refreshCursorUsageView(pi: CursorUsageApi, ctx: ExtensionContext, fetchAgent: (agentId: string) => Promise<CursorBillingObservation>): Promise<CursorUsageView> {
	const view = readCursorUsageView(pi, ctx);
	bindings.set(pi, ctx);
	for (const agent of view.agents.slice(0, 32)) {
		const source = view.records.find(record => (record.kind === "start" && record.data.agentId === agent.agentId) || (record.kind === "refresh" && record.agentId === agent.agentId));
		if (!source) continue;
		const turnId = randomUUID();
		const origin = claimOrigin(pi, view.origin, turnId);
		// Refresh belongs to the invoking branch, never to an inherited or switched sibling journal.
		const record: CursorUsageRecord = {
			version: 1, id: randomUUID(), turnId, timestamp: new Date().toISOString(), origin,
			kind: "refresh", agentId: agent.agentId, sourceOrigin: source.origin, observation: billingRevision(await fetchAgent(agent.agentId), latestAgentSnapshot(readOrigin(pi, origin), agent.agentId)),
		};
		persist(pi, record);
		if (currentMatches(pi, origin)) { try { pi.appendEntry(CUSTOM_TYPE, record); } catch { /* Unique claim retains ownership. */ } }
	}
	return readCursorUsageView(pi, ctx);
}
export function registerCursorUsageLedger(pi: CursorUsageLedgerApi): void {
	const capture = (_event: unknown, ctx: ExtensionContext) => { bindings.set(pi, ctx); };
	pi.on("session_start", capture);
	pi.on("session_tree", capture);
	pi.on("session_compact", capture);
	pi.on("before_agent_start", capture);
	pi.on("session_info_changed", capture);
	pi.on("session_shutdown", () => { bindings.delete(pi); });
}
