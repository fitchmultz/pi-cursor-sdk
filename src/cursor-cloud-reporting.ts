import type { Run, RunResult, SDKAgent, SDKArtifact, TokenUsage } from "@cursor/sdk";
import { truncateCursorDisplayLine } from "./cursor-display-text.js";
import { scrubSensitiveText } from "./cursor-sensitive-text.js";
import { asRecord, getArray, getNumber, getRecord, getString } from "./cursor-record-utils.js";

const DEFAULT_CURSOR_CLOUD_API_BASE_URL = "https://api.cursor.com";
const CLOUD_REPORT_TIMEOUT_MS = 5000;
const MAX_CLOUD_ID_DISPLAY_LENGTH = 160;
const MAX_CLOUD_REPO_DISPLAY_LENGTH = 240;
const MAX_CLOUD_BRANCH_DISPLAY_LENGTH = 160;
const MAX_CLOUD_ARTIFACT_DISPLAY_LENGTH = 240;
export const MAX_CLOUD_REPORT_BRANCHES = 5;
export const MAX_CLOUD_REPORT_ARTIFACTS = 10;

export interface CursorCloudUsageReport {
	totalUsage?: TokenUsage;
	runUsage?: TokenUsage;
}

export interface CursorCloudRunBranch {
	repoUrl: string;
	branch?: string;
	prUrl?: string;
}

export interface CursorCloudRunReport {
	agentId: string;
	runId: string;
	branches: CursorCloudRunBranch[];
	artifacts?: SDKArtifact[];
	usage?: CursorCloudUsageReport;
}

export interface FetchCursorCloudRawUsageOptions {
	agentId: string;
	runId?: string;
	apiKey: string | undefined;
	baseUrl?: string;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs = CLOUD_REPORT_TIMEOUT_MS): Promise<T | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<undefined>((resolve) => {
		timer = setTimeout(() => resolve(undefined), timeoutMs);
		timer.unref?.();
	});
	return Promise.race([promise.catch(() => undefined), timeout]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

function fetchJsonWithAbortTimeout(
	fetchImpl: typeof fetch,
	url: URL,
	init: RequestInit,
	timeoutMs = CLOUD_REPORT_TIMEOUT_MS,
): Promise<unknown> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const request = (async () => {
		const response = await fetchImpl(url, { ...init, signal: controller.signal });
		if (!response.ok) return undefined;
		return response.json();
	})().catch(() => undefined);
	const timeout = new Promise<undefined>((resolve) => {
		timer = setTimeout(() => {
			controller.abort();
			resolve(undefined);
		}, timeoutMs);
		timer.unref?.();
	});
	return Promise.race([request, timeout]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

function readNonnegativeNumber(record: Record<string, unknown> | undefined, key: string): number | undefined {
	const value = getNumber(record, key);
	return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readTokenUsage(value: unknown): TokenUsage | undefined {
	const record = asRecord(value);
	const inputTokens = readNonnegativeNumber(record, "inputTokens");
	const outputTokens = readNonnegativeNumber(record, "outputTokens");
	const cacheReadTokens = readNonnegativeNumber(record, "cacheReadTokens");
	const cacheWriteTokens = readNonnegativeNumber(record, "cacheWriteTokens");
	const totalTokens = readNonnegativeNumber(record, "totalTokens");
	if (
		inputTokens === undefined ||
		outputTokens === undefined ||
		cacheReadTokens === undefined ||
		cacheWriteTokens === undefined ||
		totalTokens === undefined
	) return undefined;
	const reasoningTokens = readNonnegativeNumber(record, "reasoningTokens");
	return {
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		totalTokens,
		...(reasoningTokens === undefined ? {} : { reasoningTokens }),
	};
}

function readNonemptyString(record: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = getString(record, key);
	return value && truncateCursorDisplayLine(value) ? value : undefined;
}

function normalizeBranches(value: unknown): CursorCloudRunBranch[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		const record = asRecord(item);
		const repoUrl = readNonemptyString(record, "repoUrl");
		if (!repoUrl) return [];
		const branch = readNonemptyString(record, "branch");
		const prUrl = readNonemptyString(record, "prUrl");
		return branch || prUrl ? [{ repoUrl, ...(branch ? { branch } : {}), ...(prUrl ? { prUrl } : {}) }] : [];
	});
}

function normalizeArtifacts(value: unknown): SDKArtifact[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) return undefined;
	return value.flatMap((item) => {
		const record = asRecord(item);
		const path = readNonemptyString(record, "path");
		const sizeBytes = readNonnegativeNumber(record, "sizeBytes");
		const updatedAt = readNonemptyString(record, "updatedAt");
		return path && sizeBytes !== undefined && updatedAt ? [{ path, sizeBytes, updatedAt }] : [];
	});
}

function normalizeUsage(value: unknown): CursorCloudUsageReport | undefined {
	const record = asRecord(value);
	const totalUsage = readTokenUsage(getRecord(record, "totalUsage"));
	const runUsage = readTokenUsage(getRecord(record, "runUsage"));
	return totalUsage || runUsage ? { ...(totalUsage ? { totalUsage } : {}), ...(runUsage ? { runUsage } : {}) } : undefined;
}

export async function fetchCursorCloudRawUsage(
	options: FetchCursorCloudRawUsageOptions,
): Promise<CursorCloudUsageReport | undefined> {
	if (!options.apiKey || typeof options.fetchImpl !== "function" && typeof fetch !== "function") return undefined;
	try {
		const baseUrl = options.baseUrl ?? DEFAULT_CURSOR_CLOUD_API_BASE_URL;
		const url = new URL(`/v1/agents/${encodeURIComponent(options.agentId)}/usage`, baseUrl);
		if (options.runId) url.searchParams.set("runId", options.runId);
		const fetchImpl = options.fetchImpl ?? fetch;
		const body = asRecord(await fetchJsonWithAbortTimeout(fetchImpl, url, {
			headers: {
				Authorization: `Bearer ${options.apiKey}`,
				"x-cursor-client-type": "sdk",
			},
		}, options.timeoutMs));
		const runs = getArray(body, "runs") ?? [];
		const matchingRun = options.runId
			? runs.map(asRecord).find((run) => getString(run, "id") === options.runId)
			: undefined;
		return normalizeUsage({
			totalUsage: getRecord(body, "totalUsage"),
			runUsage: getRecord(matchingRun, "usage"),
		});
	} catch {
		return undefined;
	}
}

function mapCursorSdkAgentUsageToCloudReport(value: unknown, runId?: string): CursorCloudUsageReport | undefined {
	const record = asRecord(value);
	const runs = (getArray(record, "runs") ?? []).map(asRecord);
	const matchingRun = runId ? runs.find((run) => getString(run, "runId") === runId) : undefined;
	return normalizeUsage({
		totalUsage: getRecord(record, "usage"),
		runUsage: getRecord(matchingRun, "usage"),
	});
}

export async function collectCursorCloudRunReport(options: {
	agent: SDKAgent;
	run: Run;
	waitResult: RunResult;
	apiKey: string | undefined;
	agentUsage?: unknown;
}): Promise<CursorCloudRunReport> {
	const listArtifacts = options.agent.listArtifacts;
	const sdkUsage =
		options.agentUsage !== undefined
			? mapCursorSdkAgentUsageToCloudReport(options.agentUsage, options.run.id)
			: typeof options.agent.getUsage === "function"
				? mapCursorSdkAgentUsageToCloudReport(
					await withTimeout(Promise.resolve(options.agent.getUsage({ runId: options.run.id }))),
					options.run.id,
				)
				: undefined;
	const [artifactResult, restUsage] = await Promise.all([
		typeof listArtifacts === "function" ? withTimeout(listArtifacts.call(options.agent)) : undefined,
		sdkUsage ? undefined : fetchCursorCloudRawUsage({ agentId: options.run.agentId, runId: options.run.id, apiKey: options.apiKey }),
	]);
	const usage = sdkUsage ?? restUsage;
	const waitBranches = getArray(getRecord(asRecord(options.waitResult), "git"), "branches");
	const runBranches = getArray(getRecord(asRecord(options.run), "git"), "branches");
	return {
		agentId: options.run.agentId,
		runId: options.run.id,
		branches: normalizeBranches(waitBranches ?? runBranches),
		artifacts: normalizeArtifacts(artifactResult),
		usage: normalizeUsage(usage),
	};
}

function formatTokenUsage(usage: TokenUsage): string {
	const parts = [
		`input ${usage.inputTokens.toLocaleString("en-US")}`,
		`output ${usage.outputTokens.toLocaleString("en-US")}`,
		`cache read ${usage.cacheReadTokens.toLocaleString("en-US")}`,
		`cache write ${usage.cacheWriteTokens.toLocaleString("en-US")}`,
		`total ${usage.totalTokens.toLocaleString("en-US")}`,
	];
	if (usage.reasoningTokens !== undefined) parts.splice(2, 0, `reasoning ${usage.reasoningTokens.toLocaleString("en-US")}`);
	return parts.join(", ");
}

function remoteDisplayString(value: unknown, maxLength: number, apiKey: string | undefined): string {
	return typeof value === "string" ? truncateCursorDisplayLine(scrubSensitiveText(value, apiKey), maxLength) : "";
}

function formatBranchLine(branch: CursorCloudRunBranch, apiKey: string | undefined): string[] {
	const lines: string[] = [];
	const branchName = remoteDisplayString(branch.branch, MAX_CLOUD_BRANCH_DISPLAY_LENGTH, apiKey);
	const repoUrl = remoteDisplayString(branch.repoUrl, MAX_CLOUD_REPO_DISPLAY_LENGTH, apiKey);
	const prUrl = remoteDisplayString(branch.prUrl, MAX_CLOUD_REPO_DISPLAY_LENGTH, apiKey);
	if (branchName) lines.push(`- branch: ${branchName}${repoUrl ? ` (${repoUrl})` : ""}`);
	if (prUrl) lines.push(`- PR: ${prUrl}`);
	return lines;
}

export function formatCursorCloudRunReport(report: CursorCloudRunReport, options: { apiKey?: string } = {}): string {
	const agentId = remoteDisplayString(report.agentId, MAX_CLOUD_ID_DISPLAY_LENGTH, options.apiKey) || "unknown";
	const runId = remoteDisplayString(report.runId, MAX_CLOUD_ID_DISPLAY_LENGTH, options.apiKey) || "unknown";
	const branches = normalizeBranches(report.branches);
	const artifacts = normalizeArtifacts(report.artifacts);
	const lines = ["Cursor cloud run:", `- agent: ${agentId}`, `- run: ${runId}`];
	for (const branch of branches.slice(0, MAX_CLOUD_REPORT_BRANCHES)) lines.push(...formatBranchLine(branch, options.apiKey));
	if (branches.length > MAX_CLOUD_REPORT_BRANCHES) lines.push(`- branches: +${branches.length - MAX_CLOUD_REPORT_BRANCHES} more`);
	if (artifacts) {
		if (artifacts.length === 0) {
			lines.push("- artifacts: none");
		} else {
			lines.push("- artifacts:");
			for (const artifact of artifacts.slice(0, MAX_CLOUD_REPORT_ARTIFACTS)) {
				const path = remoteDisplayString(artifact.path, MAX_CLOUD_ARTIFACT_DISPLAY_LENGTH, options.apiKey);
				const updatedAt = remoteDisplayString(artifact.updatedAt, MAX_CLOUD_ARTIFACT_DISPLAY_LENGTH, options.apiKey);
				lines.push(`  - ${path} (${artifact.sizeBytes.toLocaleString("en-US")} bytes, updated ${updatedAt})`);
			}
			if (artifacts.length > MAX_CLOUD_REPORT_ARTIFACTS) lines.push(`  - +${artifacts.length - MAX_CLOUD_REPORT_ARTIFACTS} more`);
		}
	}
	const normalizedUsage = normalizeUsage(report.usage);
	const usage = normalizedUsage?.runUsage ?? normalizedUsage?.totalUsage;
	if (usage) lines.push(`- raw usage (display only): ${formatTokenUsage(usage)}`);
	return scrubSensitiveText(`${lines.join("\n")}\n`, options.apiKey);
}
