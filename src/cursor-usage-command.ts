import { closeSync, constants, fsyncSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRegularFileExclusive } from "./cursor-durable-fs.js";
import { fetchCursorSdkAgentUsage } from "./cursor-sdk-billed-usage.js";
import { resolveCursorApiKey } from "./cursor-api-key.js";
import { loadCursorSdk } from "./cursor-sdk-runtime.js";
import { readCursorUsageView, refreshCursorUsageView, type CursorUsageView } from "./cursor-usage-ledger.js";

const HELP = [
	"/cursor-usage — current branch telemetry (native footer unchanged)",
	"/cursor-usage refresh — public getUsage only; up to 32 agents, 5 seconds each; no model sends or automatic polling",
	"/cursor-usage export <new-file.json> — exclusive private JSON export; never overwrites a file",
	"/cursor-usage help — this help",
	"Storage ceiling: 16MiB per origin session. At the ceiling or after an incomplete trailing frame, new sends fail before spend. A torn tail is retained unchanged; view/export preserve validated prior frames and mark accounting incomplete. Malformed complete frames remain fail-closed.",
	"Recovery: export readable facts and retain the original journal/session unchanged. Use Pi's native fork to preserve the conversation under a new session origin, or start a new native session. Never delete, truncate, or rewrite journals or native sessions to continue the old origin.",
	"Other-branch facts have valid native claims elsewhere in this session; unclaimed facts have no surviving claim here and are not branch usage. Inherited records without a claim in this session retain unknown ownership; no sibling sessions are scanned. Fileless sessions are ephemeral.",
].join("\n");
export function renderCursorUsageView(view: CursorUsageView): string {
	return [
		`Cursor usage — ${view.durability}; persistence ${view.persistenceStatus}; current branch telemetry`,
		view.nativeConfiguredEstimates,
		`Recorded corrected LOCAL raw tokens: ${view.correctedRawTotal.totalTokens} (input ${view.correctedRawTotal.inputTokens}, cache read ${view.correctedRawTotal.cacheReadTokens}, cache write ${view.correctedRawTotal.cacheWriteTokens}, output ${view.correctedRawTotal.outputTokens}).`,
		`Original telemetry: ${view.records.filter(record => record.kind === "raw").length} raw turns; normalization unavailable/invalid: ${view.records.filter(record => record.kind === "raw" && !record.corrected).length}; ${view.records.filter(record => record.kind === "terminal").length} terminal facts (not added to raw).`,
		`Other-branch journal records: ${view.otherBranchRecords.length}; unclaimed records: ${view.unclaimedRecords.length}; inherited records with unknown claim ownership: ${view.inheritedUnclaimedRecords.length}; inherited journal gaps: ${view.lineageGaps.length}; incomplete trailing frames: ${view.incompleteJournals.length}. Export retains these facts without billing them to this branch.`,
		...view.lineageGaps,
		...view.agents.slice(0, 32).map(agent => {
			const missing = agent.billingStatus === "ambiguous-shared-lineage" ? "ambiguous" : agent.billingStatus === "unavailable" ? "unavailable" : agent.billingStatus === "pending" ? "pending" : "unknown";
			const remainder = agent.billingStatus === "ambiguous-shared-lineage" ? "ambiguous" : agent.observationsByOrigin.some(observation => observation.incompleteHistory) ? "unknown (incomplete run history)" : agent.aggregateOnly?.totalTokens ?? missing;
			return [
				`${agent.agentId}: ${agent.billingStatus}${agent.unknownHistory ? "; unknown historical baseline" : ""}`,
				agent.sharedAcrossBranches ? "; shared lineage, not attributable to this branch" : "; whole-agent facts, no client-run billing join",
				`. Latest known billed tokens: ${agent.latestAggregate?.usage.totalTokens ?? missing}; SDK charged cents: ${agent.latestAggregate ? agent.latestAggregate.cost?.chargedCents ?? "not reported" : missing}; aggregate-only tokens: ${remainder}.`,
				...agent.observationsByOrigin.map(observation => {
					const absent = observation.lastAttempt.status === "unavailable" ? "unavailable" : "unknown";
					return ` Origin ${observation.origin.sessionId}: ${observation.lastAttempt.status}${observation.incompleteHistory ? "; incomplete run history" : ""}; latest known billed tokens ${observation.latestAggregate?.usage.totalTokens ?? absent}; charged cents ${observation.latestAggregate ? observation.latestAggregate.cost?.chargedCents ?? "not reported" : absent}.`;
				}),
			].join("");
		}),
		...(view.agents.length > 32 ? [`${view.agents.length - 32} further agents retained in export.`] : []),
		"Snapshots are observations, not final invoices. Multiple origin journals have no qualified global revision ordering. Cloud raw normalization is unqualified.",
		`Journal ceiling: ${view.journalLimit}. See /cursor-usage help for recovery. Export contains no prompts or tool content.`,
	].join("\n");
}
export function registerCursorUsageCommand(pi: Pick<ExtensionAPI, "appendEntry" | "registerCommand">): void {
	pi.registerCommand("cursor-usage", {
		description: "View Cursor telemetry; refresh public billing or export to a new JSON file",
		handler: async (args, ctx) => {
			const show = (message: string, error = false) => {
				if (ctx.hasUI) ctx.ui.notify(message, error ? "error" : "info");
				else process.stderr.write(`${message}\n`); // Keep non-UI stdout/RPC framing untouched.
			};
			try {
				const argument = args.trim();
				if (["help", "-h", "--help"].includes(argument)) { show(HELP); return; }
				if (argument && argument !== "refresh" && !argument.startsWith("export ")) { show(HELP, true); return; }
				let view = readCursorUsageView(pi, ctx);
				if (argument === "refresh") {
					const { Agent } = await loadCursorSdk();
					const apiKey = resolveCursorApiKey(await ctx.modelRegistry.getApiKeyForProvider("cursor"));
					view = await refreshCursorUsageView(pi, ctx, agentId => fetchCursorSdkAgentUsage({ getUsage: () => Agent.getUsage(agentId, { apiKey }) }));
				} else if (argument.startsWith("export ")) {
					const path = resolve(ctx.cwd, argument.slice(7).trim());
					const fd = createRegularFileExclusive(path, constants.O_WRONLY, 0o600);
					try { writeFileSync(fd, `${JSON.stringify(view, null, 2)}\n`); fsyncSync(fd); }
					finally { closeSync(fd); }
					show(`Cursor usage exported to ${path}.`);
					return;
				}
				show(renderCursorUsageView(view));
			} catch {
				show("Cursor usage could not be read, persisted, refreshed, or exported. Existing files were not replaced; accounting may be incomplete. See /cursor-usage help for storage limits and recovery.", true);
			}
		},
	});
}
