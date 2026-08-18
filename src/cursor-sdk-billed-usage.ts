import type { SDKAgent } from "@cursor/sdk";
import type { CursorRuntime } from "./cursor-config.js";
import { asRecord, getArray, getString } from "./cursor-record-utils.js";
import { readCursorSdkTurnUsage, type CursorSdkTurnUsage } from "./cursor-usage-accounting.js";

const BILLED_USAGE_TIMEOUT_MS = 5000;

// ponytail: process-lifetime watermark of billed usage UUIDs per agentId; reset on process exit.
// Upgrade to session-scoped storage if multi-day processes retain enough agent IDs to matter.
const seenBilledRunIdsByAgent = new Map<string, Set<string>>();

export function isCursorSdkClientMintedRunId(runId: string): boolean {
	return runId.startsWith("run-");
}

export function sumCursorSdkTurnUsage(usages: readonly CursorSdkTurnUsage[]): CursorSdkTurnUsage | undefined {
	if (usages.length === 0) return undefined;
	return usages.reduce(
		(total, usage) => ({
			inputTokens: total.inputTokens + usage.inputTokens,
			outputTokens: total.outputTokens + usage.outputTokens,
			cacheReadTokens: total.cacheReadTokens + usage.cacheReadTokens,
			cacheWriteTokens: total.cacheWriteTokens + usage.cacheWriteTokens,
		}),
	);
}

export function peekCursorBilledUsageRunIds(agentId: string): ReadonlySet<string> {
	return seenBilledRunIdsByAgent.get(agentId) ?? new Set();
}

export function rememberCursorBilledUsageRunIds(agentId: string, runIds: readonly string[]): void {
	if (runIds.length === 0) return;
	let seen = seenBilledRunIdsByAgent.get(agentId);
	if (!seen) {
		seen = new Set();
		seenBilledRunIdsByAgent.set(agentId, seen);
	}
	for (const runId of runIds) seen.add(runId);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs = BILLED_USAGE_TIMEOUT_MS): Promise<T | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<undefined>((resolve) => {
		timer = setTimeout(() => resolve(undefined), timeoutMs);
		timer.unref?.();
	});
	return Promise.race([promise.catch(() => undefined), timeout]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

export function selectCursorBilledTurnUsage(
	agentUsage: unknown,
	options: { runtime: CursorRuntime; runId?: string; seenRunIds?: ReadonlySet<string> },
): { turn?: CursorSdkTurnUsage; runIds: string[] } {
	const runs = (getArray(asRecord(agentUsage), "runs") ?? []).flatMap((item) => {
		const record = asRecord(item);
		const runId = getString(record, "runId");
		const usage = readCursorSdkTurnUsage(record?.usage);
		return runId && usage ? [{ runId, usage }] : [];
	});
	if (options.runtime === "cloud" && options.runId) {
		const match = runs.find((run) => run.runId === options.runId);
		return match ? { turn: match.usage, runIds: [match.runId] } : { runIds: [] };
	}
	const unseen = runs.filter((run) => !options.seenRunIds?.has(run.runId));
	return { turn: sumCursorSdkTurnUsage(unseen.map((run) => run.usage)), runIds: unseen.map((run) => run.runId) };
}

export async function fetchCursorSdkAgentUsage(
	agent: SDKAgent,
	options: { runtime: CursorRuntime; runId?: string },
): Promise<unknown | undefined> {
	if (typeof agent.getUsage !== "function") return undefined;
	const query =
		options.runtime === "cloud" && options.runId && isCursorSdkClientMintedRunId(options.runId)
			? { runId: options.runId }
			: undefined;
	return withTimeout(Promise.resolve(agent.getUsage(query)));
}

export async function attachCursorSdkBilledTurnUsage(options: {
	agent: SDKAgent;
	agentId: string;
	runtime: CursorRuntime;
	runId?: string;
}): Promise<{ agentUsage?: unknown; turn?: CursorSdkTurnUsage }> {
	const agentUsage = await fetchCursorSdkAgentUsage(options.agent, {
		runtime: options.runtime,
		runId: options.runId,
	});
	if (!agentUsage) return {};
	const selected = selectCursorBilledTurnUsage(agentUsage, {
		runtime: options.runtime,
		runId: options.runtime === "cloud" ? options.runId : undefined,
		seenRunIds: peekCursorBilledUsageRunIds(options.agentId),
	});
	rememberCursorBilledUsageRunIds(options.agentId, selected.runIds);
	return { agentUsage, turn: selected.turn };
}

export const __testUtils = {
	reset(): void {
		seenBilledRunIdsByAgent.clear();
	},
};
