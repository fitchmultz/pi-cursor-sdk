import type { AgentUsage, SDKAgent, TokenUsage, UsageCost } from "@cursor/sdk";
import { asRecord } from "./cursor-record-utils.js";

export type CursorBillingObservation =
	| { status: "observed-pending-settlement"; snapshot: AgentUsage }
	| { status: "unavailable"; reason: "timeout" | "unsupported" | "request-failed" | "invalid-response" };

const fields = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens"] as const;
export function readCursorUsageTokens(value: unknown): TokenUsage | undefined {
	const record = asRecord(value);
	if (!record || fields.some(key => !Number.isSafeInteger(record[key]) || (record[key] as number) < 0)) return undefined;
	if (record.reasoningTokens !== undefined && (!Number.isSafeInteger(record.reasoningTokens) || (record.reasoningTokens as number) < 0 || (record.reasoningTokens as number) > (record.outputTokens as number))) return undefined;
	return { inputTokens: record.inputTokens as number, outputTokens: record.outputTokens as number, cacheReadTokens: record.cacheReadTokens as number, cacheWriteTokens: record.cacheWriteTokens as number, totalTokens: record.totalTokens as number, ...(record.reasoningTokens === undefined ? {} : { reasoningTokens: record.reasoningTokens as number }) };
}
function readCost(value: unknown): UsageCost | undefined {
	const record = asRecord(value);
	if (!record || ["rawCostCents", "chargedCents"].some(key => typeof record[key] !== "number" || !Number.isFinite(record[key]) || (record[key] as number) < 0)) return undefined;
	return { rawCostCents: record.rawCostCents as number, chargedCents: record.chargedCents as number };
}
function billedTokens(value: unknown): TokenUsage | undefined {
	const usage = readCursorUsageTokens(value);
	if (!usage || usage.totalTokens !== usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens) return undefined;
	return usage;
}
export function readCursorBilledSnapshot(value: unknown): AgentUsage | undefined {
	const record = asRecord(value);
	const usage = billedTokens(record?.usage);
	if (!record || !usage || !Array.isArray(record.runs)) return undefined;
	const cost = record.cost === undefined ? undefined : readCost(record.cost);
	if (record.cost !== undefined && !cost) return undefined;
	const runs: AgentUsage["runs"] = [];
	const ids = new Set<string>();
	for (const item of record.runs) {
		const row = asRecord(item);
		const tokens = billedTokens(row?.usage);
		const rowCost = row?.cost === undefined ? undefined : readCost(row.cost);
		if (!row || typeof row.runId !== "string" || !row.runId || row.runId.length > 256 || ids.has(row.runId) || !tokens || (row.cost !== undefined && !rowCost)) return undefined;
		ids.add(row.runId);
		runs.push({ runId: row.runId, usage: tokens, ...(rowCost ? { cost: rowCost } : {}) });
	}
	if (fields.some(key => runs.reduce((sum, row) => sum + row.usage[key], 0) > usage[key])) return undefined;
	return { usage, runs, ...(cost ? { cost } : {}) };
}

/** Fetch is only observation; the origin journal owns recognition. No run-ID guesses or private fallback. */
export async function fetchCursorSdkAgentUsage(agent: Pick<SDKAgent, "getUsage">): Promise<CursorBillingObservation> {
	if (typeof agent.getUsage !== "function") return { status: "unavailable", reason: "unsupported" };
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const timeout = new Promise<CursorBillingObservation>(resolve => {
			timer = setTimeout(() => resolve({ status: "unavailable", reason: "timeout" }), 5000);
			timer.unref?.();
		});
		return await Promise.race([Promise.resolve().then(() => agent.getUsage()).then(value => {
			const snapshot = readCursorBilledSnapshot(value);
			return snapshot ? { status: "observed-pending-settlement" as const, snapshot } : { status: "unavailable" as const, reason: "invalid-response" as const };
		}, () => ({ status: "unavailable" as const, reason: "request-failed" as const })), timeout]);
	} finally { if (timer) clearTimeout(timer); }
}
