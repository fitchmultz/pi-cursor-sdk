import { describe, expect, it, vi } from "vitest";
import { getCursorToolTailGuardText } from "../src/context.js";
import {
	classifyNarratedToolTurn,
	findBalancedParenEnd,
	isNarratedToolText,
	scanNarratedToolInvocations,
	stripNarratedToolInvocations,
} from "../src/cursor-narrated-tool-detection.js";
import {
	buildNarratedToolRepairPrompt,
	maybeRepairNarratedToolTurn,
	shouldRepairNarratedToolTurn,
} from "../src/cursor-narrated-tool-repair.js";
import type { CursorRunOutcome } from "../src/cursor-provider-run-outcome.js";
import type { CursorProviderTurnPrepareResult } from "../src/cursor-provider-turn-types.js";

/** Real incident payload: wrapped multi-line Tool call + CallMcpTool (from #40 repro). */
const REAL_WRAPPED_INCIDENT = [
	"Didn't stop on purpose — tool calls failed mid-check. Verifying both repos now, then deploy/test.",
	'Tool call(command=cd /home/raphael.zahnd/workspace/lidar && echo "BRANCH=$(git branch --show-current)" && git status -sb && rg -n "range_image|sensor_info_json"',
	"messages/lidar_data.proto broadcaster/lidar_ws_broadcast.cpp 2>/dev/null | head -50; echo \"==== MCAP ====\"; cd /home/raphael.zahnd/workspace/mcap-recorder && echo \"BRANCH=$(git",
	'branch --show-current)" && git status -sb && rg -n "range_image|legacy_pointcloud" protobuf/lidar_data.proto',
	"include/config.h src/lidar_ws.cpp src/mcap_writer.cpp meson.build 2>/dev/null | head -80, description=Verify lidar and mcap change state)",
	"CallMcpTool(server=pi_tools, toolName=pi__intercom, description=List active worker intercom, arguments={})",
].join("\n");

describe("cursor-narrated-tool-detection", () => {
	it("strips the real wrapped multi-line incident payload without leaking continuations", () => {
		expect(isNarratedToolText(REAL_WRAPPED_INCIDENT)).toBe(true);
		const spans = scanNarratedToolInvocations(REAL_WRAPPED_INCIDENT);
		expect(spans.length).toBeGreaterThanOrEqual(2);
		const { text, removed } = stripNarratedToolInvocations(REAL_WRAPPED_INCIDENT);
		expect(removed).toBeGreaterThanOrEqual(2);
		expect(text).toContain("Didn't stop on purpose");
		expect(text).not.toContain("messages/lidar_data.proto");
		expect(text).not.toContain("description=Verify lidar and mcap change state");
		expect(text).not.toContain("toolName=pi__intercom");
		expect(text).not.toContain("Tool call(");
		expect(text).not.toContain("CallMcpTool(");
	});

	it("detects prefixed variants that escape line anchors", () => {
		for (const line of [
			"- Tool call(command=ls)",
			"1. Tool call(command=ls)",
			"> Tool call(command=ls)",
			"* CallMcpTool(server=pi_tools, arguments={})",
			"Then: Tool call(command=ls)",
		]) {
			expect(isNarratedToolText(line), line).toBe(true);
			expect(stripNarratedToolInvocations(line).removed, line).toBeGreaterThan(0);
		}
	});

	it("detects Shell and functions.bash via knownToolNames", () => {
		const known = new Set(["Shell", "bash", "functions.bash"]);
		expect(isNarratedToolText("Shell(command=ls, description=list)", known)).toBe(true);
		expect(isNarratedToolText('functions.bash({"command":"ls"})', known)).toBe(true);
		expect(stripNarratedToolInvocations("Shell(command=pwd)", known).text).not.toContain("Shell(");
	});

	it("cross-check: narrated text with completed tools is not classified as narration", () => {
		const classification = classifyNarratedToolTurn({
			finalText: REAL_WRAPPED_INCIDENT,
			completedToolCount: 2,
		});
		expect(classification.narrated).toBe(false);
		expect(classification.reason).toBe("tools-executed");
		expect(classification.names.length).toBeGreaterThan(0);
	});

	it("cross-check: narrated text with zero completions is narration", () => {
		const classification = classifyNarratedToolTurn({
			finalText: REAL_WRAPPED_INCIDENT,
			completedToolCount: 0,
		});
		expect(classification.narrated).toBe(true);
		expect(classification.reason).toBe("no-tools-executed");
	});

	it("keeps prose that merely mentions tools without invocable args", () => {
		const prose = "The bug: model prints Tool call cards as plain text instead of executing.";
		expect(isNarratedToolText(prose)).toBe(false);
		expect(stripNarratedToolInvocations(prose).text).toBe(prose);
	});

	it("does not treat the tool tail guard itself as narrated tool text", () => {
		const tail = getCursorToolTailGuardText();
		expect(isNarratedToolText(tail)).toBe(false);
		expect(tail).not.toContain("Tool call(");
		expect(tail).not.toContain("CallMcpTool(");
	});

	it("does not treat bare write/read/ls calls as narration without knownToolNames", () => {
		for (const line of [
			"Please write(path) carefully.",
			"Use read(file) to inspect.",
			"Then ls(dir) for listing.",
			'const x = write({"path":"a.ts"});',
			'await read({"path":"/etc/hosts"});',
		]) {
			expect(isNarratedToolText(line), line).toBe(false);
		}
	});

	it("balanced-paren matcher respects quotes and nesting", () => {
		const text = 'Tool call(command=echo "(hi)", description="x)")';
		const open = text.indexOf("(");
		expect(findBalancedParenEnd(text, open)).toBe(text.length);
	});
});

describe("shouldRepairNarratedToolTurn", () => {
	it("repairs only finished turns with zero completions and narrated text", () => {
		expect(
			shouldRepairNarratedToolTurn({
				outcomeKind: "finished",
				finalText: REAL_WRAPPED_INCIDENT,
				completedToolCount: 0,
			}),
		).toBe(true);
	});

	it("does not repair when tools executed, cancelled, disabled, or aborted", () => {
		expect(
			shouldRepairNarratedToolTurn({
				outcomeKind: "finished",
				finalText: REAL_WRAPPED_INCIDENT,
				completedToolCount: 1,
			}),
		).toBe(false);
		expect(
			shouldRepairNarratedToolTurn({
				outcomeKind: "cancelled",
				finalText: REAL_WRAPPED_INCIDENT,
				completedToolCount: 0,
			}),
		).toBe(false);
		expect(
			shouldRepairNarratedToolTurn({
				outcomeKind: "error",
				finalText: REAL_WRAPPED_INCIDENT,
				completedToolCount: 0,
			}),
		).toBe(false);
		expect(
			shouldRepairNarratedToolTurn({
				outcomeKind: "finished",
				finalText: REAL_WRAPPED_INCIDENT,
				completedToolCount: 0,
				signalAborted: true,
			}),
		).toBe(false);
		expect(
			shouldRepairNarratedToolTurn({
				outcomeKind: "finished",
				finalText: REAL_WRAPPED_INCIDENT,
				completedToolCount: 0,
				repairEnabled: false,
			}),
		).toBe(false);
		expect(
			shouldRepairNarratedToolTurn({
				outcomeKind: "finished",
				finalText: "plain assistant answer",
				completedToolCount: 0,
			}),
		).toBe(false);
	});

	it("builds a corrective repair prompt naming narrated tools", () => {
		const prompt = buildNarratedToolRepairPrompt(["Tool call", "CallMcpTool"]);
		expect(prompt).toContain("NOT executed");
		expect(prompt).toContain("Tool call");
		expect(prompt).toContain("CallMcpTool");
		expect(prompt).toContain("Call the real Cursor SDK/MCP tools");
	});

	it("maybeRepair skips when coordinator lacks completedToolCount without throwing or sending", async () => {
		const send = vi.fn();
		const outcome = {
			kind: "finished",
			waitResult: { id: "run-1", status: "finished" },
			finalText: REAL_WRAPPED_INCIDENT,
			incompleteTools: { reason: "no-completion-at-run-end", assistantTextProduced: true },
			assistantTextProduced: true,
		} as unknown as CursorRunOutcome;
		const prepared = {
			runtime: {
				kind: "direct",
				turnCoordinator: {
					planTextCandidate: undefined,
					discardIncompleteStartedToolCalls: vi.fn(),
				},
			},
			meta: { agentMode: "agent", modelSelection: "test", bootstrap: false },
			agent: { send },
			textDeltas: [],
			runtimeTarget: "local",
		} as unknown as CursorProviderTurnPrepareResult;

		await expect(
			maybeRepairNarratedToolTurn({
				prepared,
				outcome,
				repairEnabled: true,
			}),
		).resolves.toBe(outcome);
		expect(send).not.toHaveBeenCalled();
	});
});
