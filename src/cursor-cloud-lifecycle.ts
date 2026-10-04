import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { resolveCursorApiKey } from "./cursor-api-key.js";
import {
	MAX_CLOUD_REPORT_BRANCHES,
	type CursorCloudRunReport,
} from "./cursor-cloud-reporting.js";
import {
	CLOUD_AGENT_ID_PATTERN,
	CLOUD_LIFECYCLE_ENTRY_TYPE,
	CLOUD_LIFECYCLE_JOURNAL_PREFIX,
} from "../shared/cursor-cloud-lifecycle-constants.mjs";
import { createRegularFileExclusive, fsyncExistingRegularFile, openExistingRegularFileNoFollow } from "./cursor-durable-fs.js";
import { truncateCursorDisplayLine } from "./cursor-display-text.js";
import { asRecord, getString } from "./cursor-record-utils.js";
import { scrubSensitiveText } from "./cursor-sensitive-text.js";
import { loadCursorSdk } from "./cursor-sdk-runtime.js";

export { CLOUD_LIFECYCLE_ENTRY_TYPE };

const MAX_LEDGER_AGENT_ID_LENGTH = 256;
const MAX_LEDGER_RUN_ID_LENGTH = 256;
const MAX_LEDGER_TIMESTAMP_LENGTH = 64;
const MAX_LEDGER_BRANCH_LENGTH = 160;
const MAX_LEDGER_PR_URL_LENGTH = 240;
const MAX_LIST_RECORDS = 25;
const MAX_CLOUD_AGENT_ID_ERROR_LENGTH = 256;
const DURABLE_LEDGER_VERSION = 1;
const DURABLE_LEDGER_PREFIX = CLOUD_LIFECYCLE_JOURNAL_PREFIX;

type CloudLifecycleAction = "record" | "archive_intent" | "delete_intent" | "archive" | "delete";

interface CursorCloudLifecycleBranchEntry {
	branch?: string;
	prUrl?: string;
}

export interface CursorCloudLifecycleEntryData {
	action: CloudLifecycleAction;
	runtime: "cloud";
	agentId: string;
	runId?: string;
	timestamp: string;
	branches?: CursorCloudLifecycleBranchEntry[];
}

export interface CursorCloudLifecycleAgentRecord {
	agentId: string;
	runId?: string;
	timestamp: string;
	archived: boolean;
	deleted: boolean;
	branches: CursorCloudLifecycleBranchEntry[];
	pendingAction?: "archive" | "delete";
}

type CloudLifecycleApi = Pick<ExtensionAPI, "appendEntry" | "on">;
type CloudLifecycleCommandContext = Pick<ExtensionCommandContext, "modelRegistry" | "sessionManager" | "ui">;
type CloudLifecycleSessionContext = Pick<ExtensionContext, "sessionManager">;
type CloudLifecycleSdkOperations = {
	archive(agentId: string, options?: { apiKey?: string }): Promise<void>;
	delete(agentId: string, options?: { apiKey?: string }): Promise<void>;
};

interface DurableCloudLifecycleEntry extends CursorCloudLifecycleEntryData {
	version: 1;
	sessionId: string;
	sessionFile: string;
	anchorEntryId: string | null;
}

interface ParsedDurableCloudLifecycleEntry {
	data: CursorCloudLifecycleEntryData;
	sessionFile: string;
	anchorEntryId: string | null;
}

interface CloudLifecycleSessionState {
	sessionFile?: string;
	sessionId?: string;
	getBranch?: () => SessionEntry[];
}

const cloudBindings = new Map<object, { api: CloudLifecycleApi; session: CloudLifecycleSessionState }>();
let cloudLifecycleApi: CloudLifecycleApi | undefined;
let cloudLifecycleSession: CloudLifecycleSessionState = {};
let durableWriterForTests: ((data: CursorCloudLifecycleEntryData) => boolean) | undefined;
let sessionFsyncForTests: (() => boolean) | undefined;
let runtimeApiKeyResolverForTests: (() => Promise<string | undefined>) | undefined;
let sdkOperationsForTests: CloudLifecycleSdkOperations | undefined;

function isCloudLifecycleAction(value: unknown): value is CloudLifecycleAction {
	return value === "record" ||
		value === "archive_intent" ||
		value === "delete_intent" ||
		value === "archive" ||
		value === "delete";
}

function sanitizeLedgerString(value: string, maxLength: number, apiKey?: string): string {
	return truncateCursorDisplayLine(scrubSensitiveText(value, apiKey), maxLength);
}

function isValidExactCloudAgentId(value: unknown): value is string {
	return typeof value === "string" && CLOUD_AGENT_ID_PATTERN.test(value);
}

function requiredBoundedString(record: Record<string, unknown>, key: string, maxLength: number): string | undefined {
	const value = record[key];
	if (typeof value !== "string") return undefined;
	const sanitized = sanitizeLedgerString(value, maxLength);
	return sanitized || undefined;
}

function optionalString(
	record: Record<string, unknown>,
	key: string,
	maxLength: number,
	apiKey?: string,
): string | undefined | false {
	const value = record[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string") return false;
	return sanitizeLedgerString(value, maxLength, apiKey) || undefined;
}

function parseBranch(value: unknown, apiKey?: string): CursorCloudLifecycleBranchEntry | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const branch = optionalString(record, "branch", MAX_LEDGER_BRANCH_LENGTH, apiKey);
	const prUrl = optionalString(record, "prUrl", MAX_LEDGER_PR_URL_LENGTH, apiKey);
	if (branch === false || prUrl === false || (!branch && !prUrl)) return undefined;
	return {
		...(branch ? { branch } : {}),
		...(prUrl ? { prUrl } : {}),
	};
}

function parseArray<T>(value: unknown, parseItem: (item: unknown) => T | undefined): T[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) return undefined;
	const parsed = value.map(parseItem).filter((item): item is T => item !== undefined);
	return parsed.length > 0 ? parsed : undefined;
}

function parseCloudLifecycleEntryData(value: unknown): CursorCloudLifecycleEntryData | undefined {
	const record = asRecord(value);
	if (!record || !isCloudLifecycleAction(record.action) || record.runtime !== "cloud") return undefined;
	const agentId = record.agentId;
	const timestamp = requiredBoundedString(record, "timestamp", MAX_LEDGER_TIMESTAMP_LENGTH);
	if (!isValidExactCloudAgentId(agentId) || !timestamp) return undefined;
	const runId = optionalString(record, "runId", MAX_LEDGER_RUN_ID_LENGTH);
	if (runId === false) return undefined;
	const branches = parseArray(record.branches, (branch) => parseBranch(branch))?.slice(0, MAX_CLOUD_REPORT_BRANCHES);
	return {
		action: record.action,
		runtime: "cloud",
		agentId,
		timestamp,
		...(runId ? { runId } : {}),
		...(branches ? { branches } : {}),
	};
}

function buildBranchEntries(report: Pick<CursorCloudRunReport, "branches">, apiKey?: string): CursorCloudLifecycleBranchEntry[] | undefined {
	if (!Array.isArray(report.branches)) return undefined;
	return parseArray(report.branches.slice(0, MAX_CLOUD_REPORT_BRANCHES), (branch) => parseBranch(branch, apiKey));
}

function buildBaseEntry(agentId: string, action: CloudLifecycleAction): CursorCloudLifecycleEntryData | undefined {
	if (!isValidExactCloudAgentId(agentId)) return undefined;
	return {
		action,
		runtime: "cloud",
		agentId,
		timestamp: new Date().toISOString(),
	};
}

function captureCloudLifecycleSession(ctx: CloudLifecycleSessionContext): CloudLifecycleSessionState {
	const manager = ctx.sessionManager;
	return {
		sessionFile: manager.getSessionFile() ?? undefined,
		sessionId: manager.getSessionId(),
		getBranch: () => manager.getBranch(),
	};
}

function durableLedgerPath(sessionFile: string, sessionId: string): string {
	const sessionHash = createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
	return join(dirname(sessionFile), `${DURABLE_LEDGER_PREFIX}-${sessionHash}.journal`);
}

function fsyncCloudLifecycleSessionFile(session: CloudLifecycleSessionState): boolean {
	if (sessionFsyncForTests) return sessionFsyncForTests();
	const sessionFile = session.sessionFile;
	if (!sessionFile || !existsSync(sessionFile)) return true;
	return fsyncExistingRegularFile(sessionFile);
}

function appendDurableCloudLifecycleEntry(data: CursorCloudLifecycleEntryData, anchorEntryId: string, session: CloudLifecycleSessionState): boolean {
	if (durableWriterForTests) return durableWriterForTests(data);
	const { sessionFile, sessionId } = session;
	if (!sessionFile || !sessionId) return false;
	const entry: DurableCloudLifecycleEntry = {
		...data,
		version: DURABLE_LEDGER_VERSION,
		sessionId,
		sessionFile,
		anchorEntryId: existsSync(sessionFile) ? anchorEntryId : null,
	};
	const path = durableLedgerPath(sessionFile, sessionId);
	let created = false;
	let fd: number | undefined;
	let directoryFd: number | undefined;
	try {
		const flags = constants.O_RDWR | constants.O_APPEND;
		try {
			fd = createRegularFileExclusive(path, flags, 0o600);
			created = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			fd = openExistingRegularFileNoFollow(path, flags);
		}
		if (process.platform !== "win32") fchmodSync(fd, 0o600);
		const { size } = fstatSync(fd);
		const lastByte = Buffer.allocUnsafe(1);
		const needsFrameBoundary = size > 0 && readSync(fd, lastByte, 0, 1, size - 1) === 1 && lastByte[0] !== 0x0a;
		writeFileSync(fd, `${needsFrameBoundary ? "\n" : ""}${JSON.stringify(entry)}\n`);
		fsyncSync(fd);
		if (created && process.platform !== "win32") {
			directoryFd = openSync(dirname(path), "r");
			fsyncSync(directoryFd);
		}
		return true;
	} catch {
		return false;
	} finally {
		for (const openFd of [fd, directoryFd]) {
			if (openFd === undefined) continue;
			try {
				closeSync(openFd);
			} catch {
				// fsync already established the durability decision.
			}
		}
	}
}

function appendCloudLifecycleEntry(pi: CloudLifecycleApi, data: CursorCloudLifecycleEntryData | undefined, session: CloudLifecycleSessionState): boolean {
	if (!data || (!durableWriterForTests && (!session.sessionFile || !session.sessionId))) return false;
	let anchorEntryId: string | undefined;
	try {
		const previousEntryId = durableWriterForTests ? undefined : session.getBranch?.().at(-1)?.id;
		pi.appendEntry<CursorCloudLifecycleEntryData>(CLOUD_LIFECYCLE_ENTRY_TYPE, data);
		const anchor = session.getBranch?.().at(-1);
		anchorEntryId = durableWriterForTests
			? "test-cloud-lifecycle-entry"
			: anchor?.type === "custom" &&
				anchor.customType === CLOUD_LIFECYCLE_ENTRY_TYPE &&
				anchor.id !== previousEntryId
				? anchor.id
				: undefined;
	} catch {
		return false;
	}
	return anchorEntryId !== undefined &&
		fsyncCloudLifecycleSessionFile(session) &&
		appendDurableCloudLifecycleEntry(data, anchorEntryId, session);
}

function appendCloudLifecycleMutationEntry(
	pi: CloudLifecycleApi | undefined,
	data: CursorCloudLifecycleEntryData | undefined,
	session: CloudLifecycleSessionState,
	anchorEntryId: string | undefined,
): boolean {
	if (!data || !anchorEntryId || !fsyncCloudLifecycleSessionFile(session) || !appendDurableCloudLifecycleEntry(data, anchorEntryId, session)) return false;
	try {
		pi?.appendEntry<CursorCloudLifecycleEntryData>(CLOUD_LIFECYCLE_ENTRY_TYPE, data);
	} catch {
		// The fsynced mutation journal is authoritative.
	}
	return true;
}

export function registerCursorCloudLifecycleLedger(pi: CloudLifecycleApi): void {
	cloudLifecycleApi = pi;
	const binding = { api: pi, session: {} as CloudLifecycleSessionState };
	cloudBindings.set(pi, binding);
	const capture = (ctx: CloudLifecycleSessionContext) => {
		binding.session = captureCloudLifecycleSession(ctx);
		cloudLifecycleSession = binding.session;
	};
	pi.on("session_start", (_event, ctx) => capture(ctx));
	pi.on("before_agent_start", (_event, ctx) => capture(ctx));
	pi.on("session_tree", (_event, ctx) => capture(ctx));
	pi.on("session_shutdown", () => { cloudBindings.delete(pi); });
}

export function recordCursorCloudLifecycleRun(
	report: Omit<CursorCloudRunReport, "runId"> & { runId?: string },
	options: { apiKey?: string; binding?: { api: CloudLifecycleApi; session: CloudLifecycleSessionState } } = {},
): boolean {
	const api = options.binding?.api ?? cloudLifecycleApi;
	if (!api) return false;
	const baseEntry = buildBaseEntry(report.agentId, "record");
	if (!baseEntry) return false;
	const branches = buildBranchEntries(report, options.apiKey);
	const runId = typeof report.runId === "string"
		? sanitizeLedgerString(report.runId, MAX_LEDGER_RUN_ID_LENGTH, options.apiKey)
		: "";
	return appendCloudLifecycleEntry(api, {
		...baseEntry,
		...(runId ? { runId } : {}),
		...(branches ? { branches } : {}),
	}, options.binding?.session ?? cloudLifecycleSession);
}

export type CursorCloudLifecycleRecorder = (
	report: { agentId: string; runId?: string; branches?: CursorCloudRunReport["branches"] },
	apiKey: string | undefined,
) => boolean;

export function captureCursorCloudLifecycleRecorder(owner?: object): CursorCloudLifecycleRecorder {
	const current = owner ? cloudBindings.get(owner) : undefined;
	const api = current?.api ?? (owner ? undefined : cloudLifecycleApi);
	const session = { ...(current?.session ?? (owner ? {} : cloudLifecycleSession)) };
	return (report, apiKey) => {
		if (!api) return false;
		try {
			return recordCursorCloudLifecycleRun({ ...report, branches: report.branches ?? [] }, { apiKey, binding: { api, session } });
		} catch {
			return false;
		}
	};
}

export function createCursorCloudLifecyclePersistenceError(
	agentId: string,
	phase: "intent" | "run",
	cancellationConfirmed: boolean | undefined,
	apiKey: string | undefined,
): Error {
	const boundedAgentId = truncateCursorDisplayLine(scrubSensitiveText(agentId, apiKey), MAX_CLOUD_AGENT_ID_ERROR_LENGTH);
	const cancellation = phase === "intent"
		? "No run was started."
		: cancellationConfirmed
			? "Cancellation requested/confirmed."
			: "Cancellation requested but unconfirmed.";
	return new Error(scrubSensitiveText(
		`Cursor Cloud ${phase === "intent" ? "send intent" : "run"} blocked because its lifecycle record could not be persisted for agent ${boundedAgentId}. Cloud requires a writable persisted pi session; do not use --no-session. ${cancellation} Open the Cursor Cloud dashboard and manually archive or delete agent ${boundedAgentId} before retrying.`,
		apiKey,
	));
}

function compareLifecycleTimestamps(left: string, right: string): number {
	const leftTime = Date.parse(left);
	const rightTime = Date.parse(right);
	if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return leftTime - rightTime;
	return left.localeCompare(right);
}

function pickNewerRunId(newer: boolean, dataRunId: string | undefined, existingRunId: string | undefined): string | undefined {
	return newer ? dataRunId ?? existingRunId : existingRunId ?? dataRunId;
}

function mergeCloudLifecycleRecordBranches(
	newer: boolean,
	dataBranches: CursorCloudLifecycleBranchEntry[] | undefined,
	existingBranches: CursorCloudLifecycleBranchEntry[] | undefined,
): CursorCloudLifecycleBranchEntry[] {
	if (newer) return dataBranches ?? existingBranches ?? [];
	return existingBranches?.length ? existingBranches : dataBranches ?? [];
}

function reduceCloudLifecycleEntries(entries: readonly CursorCloudLifecycleEntryData[]): CursorCloudLifecycleAgentRecord[] {
	type MutationState = { status: "intent" | "result"; timestamp: string };
	const agents = new Map<string, CursorCloudLifecycleAgentRecord>();
	const mutations = new Map<string, { archive?: MutationState; delete?: MutationState }>();
	for (const data of entries) {
		if (data.action === "record") {
			const existing = agents.get(data.agentId);
			const newer = !existing || compareLifecycleTimestamps(data.timestamp, existing.timestamp) >= 0;
			agents.set(data.agentId, {
				agentId: data.agentId,
				runId: pickNewerRunId(newer, data.runId, existing?.runId),
				timestamp: newer || !existing ? data.timestamp : existing.timestamp,
				archived: false,
				deleted: false,
				branches: mergeCloudLifecycleRecordBranches(newer, data.branches, existing?.branches),
			});
			continue;
		}
		const action = data.action.startsWith("archive") ? "archive" : "delete";
		const status = data.action.endsWith("_intent") ? "intent" : "result";
		const agentMutations = mutations.get(data.agentId) ?? {};
		const current = agentMutations[action];
		const comparison = current ? compareLifecycleTimestamps(data.timestamp, current.timestamp) : 1;
		if (comparison > 0 || (comparison === 0 && status === "result" && current?.status === "intent")) {
			agentMutations[action] = { status, timestamp: data.timestamp };
			mutations.set(data.agentId, agentMutations);
		}
	}
	for (const [agentId, agent] of agents) {
		const agentMutations = mutations.get(agentId);
		const archive = agentMutations?.archive;
		const deletion = agentMutations?.delete;
		const pending = [
			...(archive?.status === "intent" ? [{ action: "archive" as const, timestamp: archive.timestamp }] : []),
			...(deletion?.status === "intent" ? [{ action: "delete" as const, timestamp: deletion.timestamp }] : []),
		].sort((left, right) => compareLifecycleTimestamps(right.timestamp, left.timestamp))[0];
		const mutationTimestamps = [archive?.timestamp, deletion?.timestamp].filter((value): value is string => value !== undefined);
		const timestamp = mutationTimestamps.reduce(
			(latest, value) => compareLifecycleTimestamps(value, latest) > 0 ? value : latest,
			agent.timestamp,
		);
		agents.set(agentId, {
			...agent,
			timestamp,
			archived: archive?.status === "result",
			deleted: deletion?.status === "result",
			...(pending ? { pendingAction: pending.action } : {}),
		});
	}
	return [...agents.values()].filter((agent) => !agent.deleted);
}

function readCursorCloudLifecycleEntries(entries: readonly SessionEntry[]): CursorCloudLifecycleEntryData[] {
	return entries.flatMap((entry) => {
		if (entry.type !== "custom" || entry.customType !== CLOUD_LIFECYCLE_ENTRY_TYPE) return [];
		const data = parseCloudLifecycleEntryData(entry.data);
		return data ? [data] : [];
	});
}

export function readCursorCloudLifecycleAgents(entries: readonly SessionEntry[]): CursorCloudLifecycleAgentRecord[] {
	return reduceCloudLifecycleEntries(readCursorCloudLifecycleEntries(entries));
}

function readDurableCloudLifecycleJournal(session: CloudLifecycleSessionState): ParsedDurableCloudLifecycleEntry[] {
	const { sessionFile, sessionId } = session;
	if (!sessionFile || !sessionId) return [];
	let fd: number | undefined;
	let lines: string[];
	try {
		fd = openExistingRegularFileNoFollow(durableLedgerPath(sessionFile, sessionId), constants.O_RDONLY);
		lines = readFileSync(fd, "utf8").split(/\r?\n/);
	} catch {
		return [];
	} finally {
		if (fd !== undefined) {
			try { closeSync(fd); } catch { return []; }
		}
	}
	const entries: ParsedDurableCloudLifecycleEntry[] = [];
	for (const line of lines) {
		if (!line) continue;
		let raw: Record<string, unknown> | undefined;
		try {
			raw = asRecord(JSON.parse(line));
		} catch {
			continue;
		}
		if (raw?.version !== DURABLE_LEDGER_VERSION || raw.sessionId !== sessionId || typeof raw.sessionFile !== "string") continue;
		const anchorEntryId = raw.anchorEntryId;
		if (anchorEntryId !== null && typeof anchorEntryId !== "string") continue;
		const data = parseCloudLifecycleEntryData(raw);
		if (data) entries.push({ data, sessionFile: raw.sessionFile, anchorEntryId });
	}
	return entries;
}

function readDurableCloudLifecycleEntries(session: CloudLifecycleSessionState): CursorCloudLifecycleEntryData[] {
	const { sessionFile } = session;
	if (!sessionFile) return [];
	const fileless = !existsSync(sessionFile);
	const branchIds = new Set((session.getBranch?.() ?? []).map((entry) => entry.id));
	return readDurableCloudLifecycleJournal(session).flatMap((entry) => {
		if (entry.data.action !== "record") return [entry.data];
		if (fileless) return entry.anchorEntryId === null ? [entry.data] : [];
		return entry.anchorEntryId !== null && branchIds.has(entry.anchorEntryId) ? [entry.data] : [];
	});
}

function cloudLifecycleEntryKey(data: CursorCloudLifecycleEntryData): string {
	return JSON.stringify([data.action, data.agentId, data.runId, data.timestamp, data.branches]);
}

function reconcileDurableCloudLifecycleOrphans(pi: CloudLifecycleApi, session: CloudLifecycleSessionState): boolean {
	const { sessionFile } = session;
	if (!sessionFile || !existsSync(sessionFile)) return true;
	const journal = readDurableCloudLifecycleJournal(session);
	const claimedAgentIds = new Set(journal.flatMap((entry) =>
		entry.data.action === "record" && entry.anchorEntryId !== null ? [entry.data.agentId] : []));
	const latestOrphanByAgent = new Map<string, ParsedDurableCloudLifecycleEntry>();
	for (const entry of journal) {
		if (entry.data.action === "record" && entry.anchorEntryId === null) latestOrphanByAgent.set(entry.data.agentId, entry);
	}
	const branch = session.getBranch?.() ?? [];
	for (const [agentId, orphan] of latestOrphanByAgent) {
		if (claimedAgentIds.has(agentId)) continue;
		let matchingEntry: SessionEntry | undefined;
		for (let index = branch.length - 1; index >= 0; index -= 1) {
			const entry = branch[index];
			if (entry.type !== "custom" || entry.customType !== CLOUD_LIFECYCLE_ENTRY_TYPE) continue;
			const data = parseCloudLifecycleEntryData(entry.data);
			if (data !== undefined && cloudLifecycleEntryKey(data) === cloudLifecycleEntryKey(orphan.data)) {
				matchingEntry = entry;
				break;
			}
		}
		if (matchingEntry) {
			if (!fsyncCloudLifecycleSessionFile(session) || !appendDurableCloudLifecycleEntry(orphan.data, matchingEntry.id, session)) return false;
			continue;
		}
		if (orphan.sessionFile !== sessionFile && !appendCloudLifecycleEntry(pi, orphan.data, session)) return false;
	}
	return true;
}

function reconcileDurableCloudLifecycleOrphansForCommand(pi: CloudLifecycleApi, ctx: CloudLifecycleCommandContext, session: CloudLifecycleSessionState): boolean {
	if (reconcileDurableCloudLifecycleOrphans(pi, session)) return true;
	ctx.ui.notify("Unable to reconcile the durable Cursor cloud lifecycle journal with this session branch.", "error");
	return false;
}

function readRecordedCloudAgents(session: CloudLifecycleSessionState): CursorCloudLifecycleAgentRecord[] {
	const durableEntries = readDurableCloudLifecycleEntries(session);
	const durableKeys = new Set(durableEntries.map(cloudLifecycleEntryKey));
	const branchOnlyEntries = readCursorCloudLifecycleEntries(session.getBranch?.() ?? [])
		.filter((entry) => !durableKeys.has(cloudLifecycleEntryKey(entry)));
	return reduceCloudLifecycleEntries([...durableEntries, ...branchOnlyEntries]);
}

function validateCloudAgentIdSyntax(agentId: string): string | undefined {
	if (!agentId) return "Missing Cursor cloud agent ID.";
	if (!agentId.startsWith("bc-")) return "Cursor cloud agent IDs must start with bc-.";
	if (agentId.length > MAX_LEDGER_AGENT_ID_LENGTH) return "Cursor cloud agent ID is too long.";
	if (!isValidExactCloudAgentId(agentId)) return "Pass exactly one valid recorded Cursor cloud agent ID.";
	return undefined;
}

function validateRecordedCloudAgentId(
	agentId: string,
	records: readonly CursorCloudLifecycleAgentRecord[],
	action?: "archive" | "delete",
): string | undefined {
	const syntaxError = validateCloudAgentIdSyntax(agentId);
	if (syntaxError) return syntaxError;
	const record = records.find((candidate) => candidate.agentId === agentId);
	if (!record) return `Cursor cloud agent ${agentId} is not recorded in this session branch.`;
	if (record.pendingAction) {
		return `Cursor cloud agent ${agentId} has an unresolved ${record.pendingAction} request; inspect it in the Cursor Cloud dashboard before retrying.`;
	}
	if (action === "archive" && record.archived) return `Cursor cloud agent ${agentId} is already archived.`;
	return undefined;
}

function tokenizeArgs(args: string): string[] {
	return args.trim().split(/\s+/).filter(Boolean);
}

function formatCloudAgentRecord(record: CursorCloudLifecycleAgentRecord): string {
	const agentId = sanitizeLedgerString(record.agentId, MAX_LEDGER_AGENT_ID_LENGTH);
	const status = [record.archived ? "archived" : undefined, record.pendingAction ? `${record.pendingAction} pending` : undefined]
		.filter(Boolean)
		.join(", ");
	const parts = [`- ${agentId}${status ? ` (${status})` : ""}`];
	if (record.runId) parts.push(`run ${sanitizeLedgerString(record.runId, MAX_LEDGER_RUN_ID_LENGTH)}`);
	const branch = record.branches.find((candidate) => candidate.branch || candidate.prUrl);
	if (branch?.branch) parts.push(`branch ${sanitizeLedgerString(branch.branch, MAX_LEDGER_BRANCH_LENGTH)}`);
	if (branch?.prUrl) parts.push(`PR ${sanitizeLedgerString(branch.prUrl, MAX_LEDGER_PR_URL_LENGTH)}`);
	return parts.join(" · ");
}

function formatCloudLifecycleRecords(records: readonly CursorCloudLifecycleAgentRecord[]): string {
	if (records.length === 0) return "No recorded Cursor cloud agents for this session branch.";
	const visibleRecords = records.slice(0, MAX_LIST_RECORDS);
	const lines = ["Recorded Cursor cloud agents for this session branch:", ...visibleRecords.map(formatCloudAgentRecord)];
	if (records.length > MAX_LIST_RECORDS) lines.push(`- +${records.length - MAX_LIST_RECORDS} more recorded agents`);
	return lines.join("\n");
}

export function formatCursorCloudLifecycleList(entries: readonly SessionEntry[]): string {
	return formatCloudLifecycleRecords(readCursorCloudLifecycleAgents(entries));
}

async function getSdkOperations(): Promise<CloudLifecycleSdkOperations> {
	if (sdkOperationsForTests) return sdkOperationsForTests;
	const { Agent } = await loadCursorSdk();
	return {
		archive: (agentId, options) => Agent.archive(agentId, options),
		delete: (agentId, options) => Agent.delete(agentId, options),
	};
}

function formatCloudLifecycleError(error: unknown, apiKey: string | undefined): string {
	return truncateCursorDisplayLine(scrubSensitiveText(getString(asRecord(error), "message") ?? String(error), apiKey));
}

async function resolveCloudLifecycleMutationApiKey(ctx: CloudLifecycleCommandContext): Promise<string | undefined> {
	const apiKey = resolveCursorApiKey(await (runtimeApiKeyResolverForTests?.() ?? ctx.modelRegistry.getApiKeyForProvider("cursor")));
	if (apiKey) return apiKey;
	ctx.ui.notify("Cursor cloud lifecycle mutations require a Cursor API key; run /login or set CURSOR_API_KEY, then retry.", "error");
	return undefined;
}

async function mutateRecordedCloudAgent(params: {
	pi: CloudLifecycleApi;
	ctx: CloudLifecycleCommandContext;
	agentId: string;
	action: "archive" | "delete";
	session: CloudLifecycleSessionState;
}): Promise<void> {
	const manager = params.ctx.sessionManager;
	const ui = params.ctx.ui;
	const modelRegistry = params.ctx.modelRegistry;
	const binding = cloudBindings.get(params.pi);
	let anchorEntryId = manager.getBranch().at(-1)?.id;
	// Include recoverable fileless records before auth, without writing anything
	// until credentials are available. General provider recording stays live.
	const readAuthority = () => JSON.stringify([readRecordedCloudAgents(params.session), readDurableCloudLifecycleJournal(params.session)]);
	let authority = readAuthority();
	const isOriginCurrent = (): boolean => {
		try {
			return cloudBindings.get(params.pi) === binding &&
				params.ctx.sessionManager === manager &&
				manager.getSessionFile() === params.session.sessionFile &&
				manager.getSessionId() === params.session.sessionId &&
				manager.getBranch().at(-1)?.id === anchorEntryId;
		} catch {
			return false; // Pi invalidates the command context on owning reload.
		}
	};
	const checkAuthority = (): boolean => {
		if (isOriginCurrent() && readAuthority() === authority) return true;
		ui.notify(`Cursor cloud ${params.action} was not started because its originating session branch or authority changed. Retry from the intended branch.`, "error");
		return false;
	};
	const apiKey = await resolveCloudLifecycleMutationApiKey({ modelRegistry, ui, sessionManager: manager });
	if (!apiKey || !checkAuthority()) return;
	if (!reconcileDurableCloudLifecycleOrphansForCommand(params.pi, { modelRegistry, ui, sessionManager: manager }, params.session)) return;
	// Reconciliation may append only the unchanged, captured orphan authority.
	anchorEntryId = manager.getBranch().at(-1)?.id;
	authority = readAuthority();
	const validationError = validateRecordedCloudAgentId(params.agentId, readRecordedCloudAgents(params.session), params.action);
	if (validationError) {
		ui.notify(validationError, "error");
		return;
	}
	let operations: CloudLifecycleSdkOperations;
	try {
		operations = await getSdkOperations();
	} catch (error) {
		ui.notify(`Failed to prepare Cursor cloud ${params.action}: ${formatCloudLifecycleError(error, apiKey)}`, "error");
		return;
	}
	if (!checkAuthority()) return;
	if (!appendCloudLifecycleMutationEntry(
		params.pi,
		buildBaseEntry(params.agentId, params.action === "archive" ? "archive_intent" : "delete_intent"),
		params.session,
		anchorEntryId,
	)) {
		ui.notify(`Cursor cloud ${params.action} was not started because its durable intent could not be recorded.`, "error");
		return;
	}
	// After SDK start the actual result belongs to this journal and post-intent
	// anchor, even if Pi replaces the context or selects another branch.
	anchorEntryId = manager.getBranch().at(-1)?.id;
	try {
		await operations[params.action](params.agentId, { apiKey });
	} catch (error) {
		ui.notify(
			`Cursor cloud ${params.action} for agent ${params.agentId} is unresolved: ${formatCloudLifecycleError(error, apiKey)} Inspect it in the Cursor Cloud dashboard before retrying.`,
			"error",
		);
		return;
	}
	if (!appendCloudLifecycleMutationEntry(isOriginCurrent() ? params.pi : undefined, buildBaseEntry(params.agentId, params.action), params.session, anchorEntryId)) {
		ui.notify(
			`Cursor cloud agent ${params.agentId} ${params.action === "archive" ? "archived" : "deleted"}, but its durable result could not be recorded. Inspect it in the Cursor Cloud dashboard before retrying.`,
			"error",
		);
		return;
	}
	ui.notify(`Cursor cloud agent ${params.agentId} ${params.action === "archive" ? "archived" : "deleted"}.`, "info");
}

export async function runCursorCloudLifecycleCommand(pi: CloudLifecycleApi, args: string, ctx: CloudLifecycleCommandContext): Promise<void> {
	const session = captureCloudLifecycleSession(ctx);
	const usage = "Usage: /cursor-cloud list | archive <bc-agentId> | delete <bc-agentId> --yes";
	const tokens = tokenizeArgs(args);
	const [subcommand, agentId, ...rest] = tokens;
	if (!subcommand || subcommand === "list") {
		if (tokens.length > (subcommand ? 1 : 0)) {
			ctx.ui.notify(`Invalid Cursor cloud arguments. ${usage}`, "error");
			return;
		}
		if (!reconcileDurableCloudLifecycleOrphansForCommand(pi, ctx, session)) return;
		ctx.ui.notify(formatCloudLifecycleRecords(readRecordedCloudAgents(session)), "info");
		return;
	}
	if (subcommand === "archive") {
		if (!agentId || rest.length > 0) {
			ctx.ui.notify(`Invalid Cursor cloud archive arguments. ${usage}`, "error");
			return;
		}
		const validationError = validateCloudAgentIdSyntax(agentId);
		if (validationError) {
			ctx.ui.notify(validationError, "error");
			return;
		}
		await mutateRecordedCloudAgent({ pi, ctx, agentId, action: "archive", session });
		return;
	}
	if (subcommand === "delete") {
		if (!agentId || rest.length !== 1 || rest[0] !== "--yes") {
			ctx.ui.notify(`Delete requires exactly one recorded bc- cloud agent ID and --yes. ${usage}`, "error");
			return;
		}
		const validationError = validateCloudAgentIdSyntax(agentId);
		if (validationError) {
			ctx.ui.notify(validationError, "error");
			return;
		}
		await mutateRecordedCloudAgent({ pi, ctx, agentId, action: "delete", session });
		return;
	}
	ctx.ui.notify(`Invalid Cursor cloud command. ${usage}`, "error");
}

export const __testUtils = {
	reset: () => {
		cloudBindings.clear();
		cloudLifecycleApi = undefined;
		cloudLifecycleSession = {};
		durableWriterForTests = undefined;
		sessionFsyncForTests = undefined;
		runtimeApiKeyResolverForTests = undefined;
		sdkOperationsForTests = undefined;
	},
	setDurableWriter: (writer: ((data: CursorCloudLifecycleEntryData) => boolean) | undefined) => {
		durableWriterForTests = writer;
	},
	setSessionFsync: (fsync: (() => boolean) | undefined) => {
		sessionFsyncForTests = fsync;
	},
	setRuntimeApiKeyResolver: (resolver: (() => Promise<string | undefined>) | undefined) => {
		runtimeApiKeyResolverForTests = resolver;
	},
	durableLedgerPath,
	setSdkOperations: (operations: CloudLifecycleSdkOperations | undefined) => {
		sdkOperationsForTests = operations;
	},
};
