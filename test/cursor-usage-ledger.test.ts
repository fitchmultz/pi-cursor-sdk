import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentUsage, SDKAgent } from "@cursor/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureCursorUsageRecorder, readCursorUsageView, registerCursorUsageLedger, refreshCursorUsageView } from "../src/cursor-usage-ledger.js";
import { createExtensionCommandContext, createExtensionTestContext, createPiHarness, makeAssistantMessage, makeModel } from "./helpers/pi-harness.js";
import { registerCursorUsageCommand, renderCursorUsageView } from "../src/cursor-usage-command.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const cached = { inputTokens: 136, outputTokens: 3, cacheReadTokens: 4096, cacheWriteTokens: 0, totalTokens: 4235 };
const bill = (tokens = cached, chargedCents = 0.2): AgentUsage => ({ usage: tokens, cost: { rawCostCents: 0.3, chargedCents }, runs: [{ runId: "uuid-a", usage: tokens, cost: { rawCostCents: 0.3, chargedCents } }] });
function setup() {
	const root = mkdtempSync(join(tmpdir(), "cursor-usage-test-")); roots.push(root);
	let manager = SessionManager.create(root, root);
	manager.appendMessage({ role: "user", content: "not exported", timestamp: 1 }); manager.appendMessage(makeAssistantMessage());
	const harness = createPiHarness(); const pi = harness as unknown as ExtensionAPI;
	harness.appendEntry.mockImplementation((kind, data) => { manager.appendCustomEntry(kind, data); });
	registerCursorUsageLedger(pi);
	registerCursorUsageCommand(pi);
	const notify = vi.fn();
	const ctx = () => { const base = createExtensionTestContext({ cwd: root }); return { ...base, sessionManager: manager, ui: { ...base.ui, notify } }; };
	const start = (agent: SDKAgent, options = {}) => captureCursorUsageRecorder(pi, ctx()).start({ agent, runtime: "local", model: makeModel(), modelSelection: { id: "test-model" }, purpose: "normal", resumed: false, newlyCreated: true, ...options });
	return { root, harness, pi, ctx, start, notify, get manager() { return manager; }, replace(next: SessionManager) { manager = next; } };
}
function agent(getUsage: SDKAgent["getUsage"] = async () => bill()): SDKAgent { return { agentId: "agent-test", getUsage } as SDKAgent; }
describe("origin usage recorder and supported view", () => {
	it("keeps raw cache correction, reported snapshots, repeated/revised aggregate bills and restart separate", async () => {
		const s = setup(); const snapshots = vi.fn().mockResolvedValue(bill()); const turn = await s.start(agent(snapshots));
		turn.observeRawTurn({ inputTokens: 4232, outputTokens: 3, cacheReadTokens: 4096, cacheWriteTokens: 0 });
		await turn.recordRun({ runId: "run-client", requestId: "request-client" });
		await turn.recordTerminal({ status: "success", waitUsage: { ...cached, inputTokens: 4232, totalTokens: 8331 }, handleUsage: { ...cached, inputTokens: 4232, totalTokens: 8331 } });
		await turn.recordSnapshot();
		let view = readCursorUsageView(s.pi, s.ctx());
		expect(view.correctedRawTotal).toEqual(cached); expect(view.agents[0]?.wholeAgent?.usage).toEqual(cached);
		expect(view.records.find(record => record.kind === "terminal")).toMatchObject({ waitUsage: { totalTokens: 8331 } });
		const larger = { ...cached, outputTokens: 500003, totalTokens: 504235 };
		snapshots.mockResolvedValue({ usage: larger, cost: { rawCostCents: 0.1, chargedCents: 0.05 }, runs: [{ runId: "uuid-a", usage: cached, cost: { rawCostCents: 0.1, chargedCents: 0.05 } }] });
		await turn.recordSnapshot(); view = readCursorUsageView(s.pi, s.ctx());
		expect(view.agents[0]?.wholeAgent?.cost?.chargedCents).toBe(0.05); expect(view.agents[0]?.aggregateOnly?.outputTokens).toBe(500000);
		const reopened = SessionManager.open(s.manager.getSessionFile()!); s.replace(reopened);
		const next = await s.start(agent(snapshots), { resumed: true, newlyCreated: false }); await next.recordSnapshot();
		view = readCursorUsageView(s.pi, s.ctx()); expect(view.correctedRawTotal.totalTokens).toBe(4235); expect(view.agents[0]?.wholeAgent?.usage.totalTokens).toBe(504235); expect(view.agents[0]?.unknownHistory).toBe(false);
		expect(JSON.stringify(view)).not.toContain("not exported");
	});
	it("retains unknown inherited history, unavailable then late terminal/billing facts without fiction", async () => {
		const s = setup(); const fetch = vi.fn().mockRejectedValue(new Error("private credential")); const turn = await s.start(agent(fetch), { resumed: true, newlyCreated: false });
		expect(renderCursorUsageView(readCursorUsageView(s.pi, s.ctx()))).toContain("Latest known billed tokens: pending; SDK charged cents: pending; aggregate-only tokens: pending");
		await turn.recordTerminal({ status: "abandon" }); await turn.recordSnapshot(); let view = readCursorUsageView(s.pi, s.ctx());
		expect(view.agents[0]).toMatchObject({ billingStatus: "unavailable", unknownHistory: true }); expect(JSON.stringify(view)).not.toContain("private credential");
		expect(renderCursorUsageView(view)).toContain("Latest known billed tokens: unavailable; SDK charged cents: unavailable; aggregate-only tokens: unavailable");
		expect(renderCursorUsageView(view)).toContain("latest known billed tokens unavailable; charged cents unavailable");
		fetch.mockResolvedValue(bill()); await turn.recordTerminal({ status: "abort", waitUsage: cached });
		view = readCursorUsageView(s.pi, s.ctx()); expect(view.records.filter(record => record.kind === "terminal").map(record => record.status)).toEqual(["abandon", "abort"]);
		expect(renderCursorUsageView(view)).toContain("unknown historical baseline"); expect(renderCursorUsageView(view)).toContain("observed-pending-settlement");
		fetch.mockResolvedValue({ usage: cached, runs: [{ runId: "uuid-a", usage: cached }] }); await turn.recordSnapshot();
		expect(renderCursorUsageView(readCursorUsageView(s.pi, s.ctx()))).toContain("Latest known billed tokens: 4235; SDK charged cents: not reported; aggregate-only tokens: 0");
	});
	it("late completion persists to its original journal without writing a switched session or sibling branch", async () => {
		const s = setup(); const oldLeaf = s.manager.getLeafId()!; let resolveBill!: (value: AgentUsage) => void; const turn = await s.start(agent(() => new Promise(resolve => { resolveBill = resolve; })));
		const old = s.manager; const oldFile = old.getSessionFile()!;
		const pending = turn.recordTerminal({ status: "success" }); await Promise.resolve(); await Promise.resolve();
		const next = SessionManager.create(s.root, s.root); next.appendMessage(makeAssistantMessage()); s.replace(next);
		await s.harness.invokeEventWithContext("session_start", { type: "session_start", reason: "resume" }, s.ctx());
		const writes = s.harness.appendEntry.mock.calls.length; resolveBill(bill()); await pending;
		expect(s.harness.appendEntry).toHaveBeenCalledTimes(writes); expect(readCursorUsageView(s.pi, s.ctx()).agents).toEqual([]);
		s.replace(SessionManager.open(oldFile)); await s.harness.invokeEventWithContext("session_start", { type: "session_start", reason: "resume" }, s.ctx());
		expect(readCursorUsageView(s.pi, s.ctx()).agents[0]?.wholeAgent?.usage.totalTokens).toBe(4235);
		s.manager.branch(oldLeaf); s.manager.appendMessage({ role: "user", content: "sibling", timestamp: 2 });
		await s.harness.invokeEventWithContext("session_tree", { type: "session_tree", oldLeafId: oldLeaf, newLeafId: s.manager.getLeafId()! }, s.ctx());
		const before = s.harness.appendEntry.mock.calls.length; turn.observeRawTurn({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 });
		expect(s.harness.appendEntry).toHaveBeenCalledTimes(before); expect(readCursorUsageView(s.pi, s.ctx()).agents).toEqual([]);
	});
	it("failed persistence never advances recognized facts and exposes a guarded warning", async () => {
		const s = setup(); const turn = await s.start(agent()); const path = join(s.root, readdirSync(s.root).find(name => name.endsWith(".journal"))!); const original = readFileSync(path, "utf8");
		writeFileSync(path, `${original}{\"version\":1`);
		await expect(turn.recordSnapshot()).rejects.toThrow("incomplete journal frame"); turn.notePersistenceFailure(new Error("secret")); turn.notePersistenceFailure(new Error("secret"));
		expect(s.notify).toHaveBeenCalledTimes(1); expect(s.notify.mock.calls[0]?.[0]).not.toContain("secret");
		const view = readCursorUsageView(s.pi, s.ctx()); expect(view.agents[0]?.wholeAgent).toBeUndefined(); expect(view.persistenceStatus).toBe("incomplete"); expect(view.records.filter(record => record.kind === "billing")).toHaveLength(0);
		expect(view.incompleteJournals).toEqual([s.manager.getSessionId()]);
		const bytes = readFileSync(path);
		const command = s.harness._commands.get("cursor-usage")!;
		const exported = join(s.root, "torn-export.json");
		await command.handler(`export ${exported}`, { ...createExtensionCommandContext({ cwd: s.root }), sessionManager: s.manager });
		expect(JSON.parse(readFileSync(exported, "utf8"))).toMatchObject({ persistenceStatus: "incomplete", records: [{ kind: "start" }] });
		expect(readFileSync(path)).toEqual(bytes);
		await expect(s.start(agent())).rejects.toThrow("incomplete journal frame");
		s.replace(SessionManager.forkFrom(s.manager.getSessionFile()!, s.root, s.root));
		const recovered = await s.start(agent()); await recovered.recordSnapshot();
		const recoveryView = readCursorUsageView(s.pi, s.ctx());
		expect(recoveryView.agents[0]?.wholeAgent?.usage).toEqual(cached);
		expect(recoveryView.incompleteJournals).toHaveLength(1);
		expect(readFileSync(path)).toEqual(bytes);
	});
	it("abandon persists a terminal without fetching; the eventual terminal observes billing", async () => {
		const s = setup(); const fetch = vi.fn(async () => bill()); const turn = await s.start(agent(fetch));
		expect(await turn.recordTerminal({ status: "abandon" })).toBeUndefined();
		expect(fetch).not.toHaveBeenCalled();
		s.replace(SessionManager.open(s.manager.getSessionFile()!));
		expect(readCursorUsageView(s.pi, s.ctx()).records.filter(record => record.kind === "terminal")).toMatchObject([{ status: "abandon" }]);
		await turn.recordTerminal({ status: "abort" });
		expect(fetch).toHaveBeenCalledTimes(1);
	});
	it("stores growing snapshots linearly in real journals and native mirrors, including row revisions and deletion", async () => {
		const s = setup(); const fetch = vi.fn(); const turn = await s.start(agent(fetch));
		const path = join(s.root, readdirSync(s.root).find(name => name.endsWith(".journal"))!);
		const tokens = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2 };
		const rows: AgentUsage["runs"] = [];
		let halfJournal = 0; let halfSession = 0;
		for (let i = 1; i <= 128; i++) {
			rows.push({ runId: `uuid-${i}`, usage: tokens });
			fetch.mockResolvedValue({ usage: { ...tokens, inputTokens: i, outputTokens: i, totalTokens: i * 2 }, runs: [...rows] });
			await turn.recordSnapshot();
			if (i === 64) { halfJournal = readFileSync(path).length; halfSession = readFileSync(s.manager.getSessionFile()!).length; }
		}
		expect(readFileSync(path).length).toBeLessThan(halfJournal * 2.4);
		expect(readFileSync(s.manager.getSessionFile()!).length).toBeLessThan(halfSession * 2.4);
		expect(readCursorUsageView(s.pi, s.ctx()).agents[0]?.wholeAgent?.runs).toHaveLength(128);
		const revised = { usage: tokens, cost: { rawCostCents: 0.01, chargedCents: 0 }, runs: [{ runId: "uuid-1", usage: tokens, cost: { rawCostCents: 0.01, chargedCents: 0 } }] };
		fetch.mockResolvedValue(revised); await turn.recordSnapshot();
		s.replace(SessionManager.open(s.manager.getSessionFile()!));
		expect(readCursorUsageView(s.pi, s.ctx()).agents[0]?.wholeAgent).toEqual(revised);
		fetch.mockRejectedValue(new Error("unavailable")); await turn.recordSnapshot();
		const view = readCursorUsageView(s.pi, s.ctx());
		expect(view.agents[0]).toMatchObject({ billingStatus: "unavailable", wholeAgent: revised });
		expect(renderCursorUsageView(view)).toContain("Latest known billed tokens: 2");
		expect(view.records.filter(record => record.kind === "billing")).toHaveLength(130);
	});
	it.each(["malformed", "symlink", "directory"])("rejects %s journal safely", async kind => {
		const s = setup(); await s.start(agent()); const path = join(s.root, readdirSync(s.root).find(name => name.endsWith(".journal"))!);
		if (kind === "directory") { rmSync(path); mkdirSync(path); }
		else if (kind === "symlink") { const target = join(s.root, "target"); writeFileSync(target, "untouched"); rmSync(path); symlinkSync(target, path); }
		else writeFileSync(path, `${readFileSync(path, "utf8")}{}\n{"torn":`);
		expect(() => readCursorUsageView(s.pi, s.ctx())).toThrow();
		if (kind === "symlink") expect(readFileSync(join(s.root, "target"), "utf8")).toBe("untouched");
	});
	it("forks preserve source lineage and whole-agent facts without attributing shared spend to the new branch", async () => {
		const s = setup(); const original = await s.start(agent()); await original.recordSnapshot();
		const sourceFile = s.manager.getSessionFile()!;
		s.replace(SessionManager.forkFrom(sourceFile, s.root, s.root));
		const inherited = await s.start(agent(), { resumed: true, newlyCreated: false }); await inherited.recordSnapshot();
		const view = readCursorUsageView(s.pi, s.ctx()); expect(view.agents[0]).toMatchObject({ sharedAcrossBranches: true, unknownHistory: false, billingStatus: "ambiguous-shared-lineage" });
		expect(view.agents[0]?.wholeAgent).toBeUndefined(); expect(view.agents[0]?.observationsByOrigin).toHaveLength(2);
		expect(view.agents[0]?.latestAggregate).toBeUndefined();
		expect(view.agents[0]?.observationsByOrigin.map(observation => observation.latestAggregate?.usage)).toEqual([cached, cached]);
		expect(new Set(view.records.map(record => record.origin.sessionId)).size).toBe(2);
		expect(renderCursorUsageView(view)).toContain("not attributable to this branch");
		expect(renderCursorUsageView(view)).toContain("Latest known billed tokens: ambiguous; SDK charged cents: ambiguous; aggregate-only tokens: ambiguous");
	});
	it("keeps journal-only facts on the claimed descendant after mirror failure and reopen, not a sibling", async () => {
		const s = setup(); const ancestor = s.manager.getLeafId()!;
		s.harness.appendEntry.mockImplementation((kind, data) => {
			if (kind === "pi-cursor-sdk:usage-v1") throw new Error("optional mirror failed");
			s.manager.appendCustomEntry(kind, data);
		});
		const turn = await s.start(agent()); await turn.recordSnapshot();
		s.manager.appendMessage(makeAssistantMessage()); s.manager.appendMessage({ role: "user", content: "later", timestamp: 2 });
		s.replace(SessionManager.open(s.manager.getSessionFile()!));
		expect(readCursorUsageView(s.pi, s.ctx()).agents[0]?.wholeAgent?.usage).toEqual(cached);
		s.manager.branch(ancestor); s.manager.appendMessage({ role: "user", content: "sibling", timestamp: 3 });
		const sibling = readCursorUsageView(s.pi, s.ctx()); expect(sibling.agents).toEqual([]); expect(sibling.otherBranchRecords).toHaveLength(2); expect(sibling.unclaimedRecords).toEqual([]);
	});
	it("uses append chronology for backward and equal wall-clock snapshot revisions", async () => {
		const s = setup(); const fetch = vi.fn().mockResolvedValue(bill()); const turn = await s.start(agent(fetch));
		await turn.recordSnapshot(); fetch.mockResolvedValue(bill(cached, 0.1)); await turn.recordSnapshot(); fetch.mockResolvedValue(bill(cached, 0.05)); await turn.recordSnapshot();
		const path = join(s.root, readdirSync(s.root).find(name => name.endsWith(".journal"))!);
		const frames = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
		frames[1].timestamp = "2030-01-01T00:00:00Z"; frames[2].timestamp = frames[3].timestamp = "1990-01-01T00:00:00Z";
		writeFileSync(path, frames.map(frame => JSON.stringify(frame)).join("\n") + "\n");
		expect(readCursorUsageView(s.pi, s.ctx()).agents[0]?.wholeAgent?.cost?.chargedCents).toBe(0.05);
	});
	it("preserves unqualified Cloud and invalid LOCAL numeric telemetry without inventing normalization", async () => {
		const s = setup(); const cloud = await s.start(agent(), { runtime: "cloud" }); cloud.observeRawTurn(cached);
		const local = await s.start(agent()); local.observeRawTurn(cached);
		const raw = readCursorUsageView(s.pi, s.ctx()).records.filter(record => record.kind === "raw");
		expect(raw.map(record => record.normalization)).toEqual(["cloud-unqualified", "invalid-local-partition"]);
		expect(raw.every(record => record.corrected === undefined)).toBe(true); expect(raw.map(record => record.reported)).toEqual([cached, cached]);
	});
	it("preserves configured pricing tiers immutably and rejects unknown secret-bearing metadata", async () => {
		const s = setup(); const model = makeModel(); const tier = { ...model.cost, inputTokensAbove: 100, input: 7 }; model.cost = { ...model.cost, tiers: [tier] };
		await s.start(agent(), { model }); tier.input = 99;
		const start = readCursorUsageView(s.pi, s.ctx()).records.find(record => record.kind === "start");
		expect(start?.kind === "start" && start.data.model.cost.tiers?.[0]?.input).toBe(7);
		await expect(s.start(agent(), { modelSelection: { id: "model", secret: "not allowed" } })).rejects.toThrow("invalid Cursor model selection");
		await expect(s.start(agent(), { resumed: true, newlyCreated: true })).rejects.toThrow("both resumed and newly created");
	});
	it("preserves cross-directory fork mirrors and explicitly reports an unavailable inherited journal", async () => {
		const s = setup(); const turn = await s.start(agent()); await turn.recordSnapshot(); const source = s.manager.getSessionFile()!;
		const target = mkdtempSync(join(tmpdir(), "cursor-usage-fork-")); roots.push(target);
		s.replace(SessionManager.forkFrom(source, target, target));
		let view = readCursorUsageView(s.pi, s.ctx()); expect(view.agents[0]?.wholeAgent?.usage).toEqual(cached);
		rmSync(join(s.root, readdirSync(s.root).find(name => name.endsWith(".journal"))!));
		view = readCursorUsageView(s.pi, s.ctx()); expect(view.agents[0]?.latestAggregate).toEqual({ usage: cached, cost: bill().cost }); expect(view.lineageGaps).toHaveLength(1); expect(view.persistenceStatus).toBe("incomplete");
		expect(view.agents[0]?.wholeAgent).toBeUndefined();
		expect(view.agents[0]?.observationsByOrigin[0]?.wholeAgent).toBeUndefined();
		expect(view.agents[0]?.observationsByOrigin[0]?.incompleteHistory).toBe(true);
		expect(view.agents[0]?.aggregateOnly).toBeUndefined();
		expect(renderCursorUsageView(view)).toContain("Latest known billed tokens: 4235; SDK charged cents: 0.2; aggregate-only tokens: unknown (incomplete run history)");
	});
	it("keeps available aggregate revisions when missing mirrors cannot reconstruct all run history", async () => {
		const s = setup(); const fetch = vi.fn().mockResolvedValue(bill()); const turn = await s.start(agent(fetch)); await turn.recordSnapshot();
		const append = s.harness.appendEntry.getMockImplementation()!;
		s.harness.appendEntry.mockImplementation((kind, data) => { if (kind !== "pi-cursor-sdk:usage-v1") append(kind, data); });
		const lower = { usage: { ...cached, cacheReadTokens: 0, totalTokens: 139 }, cost: { rawCostCents: 0.15, chargedCents: 0.1 }, runs: [] };
		fetch.mockResolvedValue(lower); await turn.recordSnapshot();
		s.harness.appendEntry.mockImplementation(append); await turn.recordSnapshot();
		fetch.mockRejectedValue(new Error("unavailable")); await turn.recordSnapshot();
		rmSync(join(s.root, readdirSync(s.root).find(name => name.endsWith(".journal"))!));
		const view = readCursorUsageView(s.pi, s.ctx());
		expect(view.persistenceStatus).toBe("incomplete");
		expect(view.agents[0]?.wholeAgent).toBeUndefined();
		expect(view.agents[0]?.lastAttempt).toMatchObject({ status: "unavailable" });
		expect(view.agents[0]?.latestAggregate).toEqual({ usage: lower.usage, cost: lower.cost });
		expect(view.agents[0]?.aggregateOnly).toBeUndefined();
		expect(view.agents[0]?.observationsByOrigin[0]).toMatchObject({ incompleteHistory: true, latestAggregate: { usage: lower.usage, cost: lower.cost } });
		expect(view.agents[0]?.observationsByOrigin[0]?.wholeAgent).toBeUndefined();
		expect(view.records.filter(record => record.kind === "billing")).toHaveLength(3);
		const rendered = renderCursorUsageView(view);
		expect(rendered).toContain("Latest known billed tokens: 139; SDK charged cents: 0.1; aggregate-only tokens: unknown (incomplete run history)");
		expect(rendered).toContain("unavailable; incomplete run history; latest known billed tokens 139; charged cents 0.1");
		const exported = join(s.root, "incomplete-export.json");
		await s.harness._commands.get("cursor-usage")!.handler(`export ${exported}`, { ...createExtensionCommandContext({ cwd: s.root }), sessionManager: s.manager });
		const exportedAgent = JSON.parse(readFileSync(exported, "utf8")).agents[0];
		expect(exportedAgent.latestAggregate).toEqual({ usage: lower.usage, cost: lower.cost });
		expect(exportedAgent).not.toHaveProperty("wholeAgent");
		expect(exportedAgent).not.toHaveProperty("aggregateOnly");
		expect(exportedAgent.observationsByOrigin[0]).not.toHaveProperty("wholeAgent");
	});
	it("preserves valid other-branch claims copied by a native fork", async () => {
		const s = setup(); const ancestor = s.manager.getLeafId()!;
		const turn = await s.start(agent()); await turn.recordSnapshot();
		s.manager.branch(ancestor); s.manager.appendMessage({ role: "user", content: "fork from sibling", timestamp: 2 });
		await s.start({ ...agent(), agentId: "agent-sibling" } as SDKAgent);
		s.replace(SessionManager.forkFrom(s.manager.getSessionFile()!, s.root, s.root));
		const view = readCursorUsageView(s.pi, s.ctx());
		expect(view.unclaimedRecords).toEqual([]);
		expect(view.otherBranchRecords).toHaveLength(2);
		expect(view.records).toHaveLength(1);
		expect(view.inheritedUnclaimedRecords).toEqual([]);
	});
	it("retains first-turn orphan intent as unclaimed facts when its native claim is lost", async () => {
		const s = setup(); const beforeClaim = readFileSync(s.manager.getSessionFile()!, "utf8"); const turn = await s.start(agent()); await turn.recordSnapshot();
		const recoveredFile = join(s.root, "recovered-same-native-id.jsonl"); writeFileSync(recoveredFile, beforeClaim); s.replace(SessionManager.open(recoveredFile));
		const view = readCursorUsageView(s.pi, s.ctx()); expect(view.records).toEqual([]); expect(view.agents).toEqual([]); expect(view.unclaimedRecords).toHaveLength(2);
		await s.start({ ...agent(), agentId: "agent-sibling" } as SDKAgent);
		s.replace(SessionManager.forkFrom(s.manager.getSessionFile()!, s.root, s.root));
		const inherited = readCursorUsageView(s.pi, s.ctx());
		expect(inherited.records).toHaveLength(1);
		expect(inherited.unclaimedRecords).toEqual([]);
		expect(inherited.otherBranchRecords).toEqual([]);
		expect(inherited.inheritedUnclaimedRecords).toHaveLength(2);
	});
	it("fileless one-shot sessions explicitly remain ephemeral without requiring a journal", async () => {
		const s = setup(); s.replace(SessionManager.inMemory(s.root));
		const turn = await s.start(agent()); turn.observeRawTurn({ inputTokens: 2, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 });
		await turn.recordTerminal({ status: "success", waitUsage: { invalid: "not stored" } });
		const view = readCursorUsageView(s.pi, s.ctx()); expect(view.durability).toBe("ephemeral"); expect(view.correctedRawTotal.totalTokens).toBe(3);
		expect(view.records.find(record => record.kind === "terminal")).toMatchObject({ invalidReportedUsage: true });
	});
	it("help and missing export arguments are useful in non-UI mode without changing stdout", async () => {
		const s = setup(); const command = s.harness._commands.get("cursor-usage")!;
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const stdout = vi.spyOn(process.stdout, "write");
		try {
			const ctx = { ...createExtensionCommandContext({ cwd: s.root }), sessionManager: s.manager, hasUI: false };
			await command.handler("--help", ctx); await command.handler("export", ctx);
			expect(stderr.mock.calls.map(call => String(call[0])).join("\n")).toContain("16MiB");
			expect(stderr.mock.calls.map(call => String(call[0])).join("\n")).toContain("export <new-file.json>");
			expect(stdout).not.toHaveBeenCalled();
		} finally { stderr.mockRestore(); stdout.mockRestore(); }
	});
	it("refreshes retired agents through one public bounded observation and exports without replacing files", async () => {
		const s = setup(); await s.start(agent());
		const fetch = vi.fn(async () => ({ status: "observed-pending-settlement" as const, snapshot: bill() }));
		const view = await refreshCursorUsageView(s.pi, s.ctx(), fetch); expect(fetch).toHaveBeenCalledTimes(1); expect(view.agents[0]?.wholeAgent?.cost?.chargedCents).toBe(0.2);
		const path = join(s.root, "export.json"); const command = s.harness._commands.get("cursor-usage")!;
		const commandCtx = { ...createExtensionCommandContext({ cwd: s.root }), sessionManager: s.manager };
		await command.handler(`export ${path}`, commandCtx);
		const content = readFileSync(path, "utf8"); expect(JSON.parse(content).records).toHaveLength(2); expect(content).not.toContain("not exported");
		await command.handler(`export ${path}`, commandCtx); expect(readFileSync(path, "utf8")).toBe(content);
	});
});
