import type { SendOptions } from "@cursor/sdk";
import { parseEnvBoolean } from "./cursor-env-boolean.js";
import {
	classifyNarratedToolTurn,
	type NarratedToolTurnClassification,
} from "./cursor-narrated-tool-detection.js";
import { resolveCursorRunOutcome, type CursorRunOutcome } from "./cursor-provider-run-outcome.js";
import type { CursorProviderTurnPrepareResult } from "./cursor-provider-turn-types.js";
import type { CursorSdkEventDebugSink } from "./cursor-sdk-event-debug.js";
import { scrubSensitiveText } from "./cursor-sensitive-text.js";

export const NARRATED_TOOL_REPAIR_ENV = "PI_CURSOR_NARRATED_TOOL_REPAIR";

export function isNarratedToolRepairEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return parseEnvBoolean(env[NARRATED_TOOL_REPAIR_ENV], true);
}

export interface ShouldRepairNarratedToolTurnInput {
	outcomeKind: CursorRunOutcome["kind"];
	finalText: string;
	completedToolCount: number;
	knownToolNames?: ReadonlySet<string>;
	signalAborted?: boolean;
	repairEnabled?: boolean;
}

/** Pure predicate: finished + zero tools executed + narrated text + enabled + not aborted. */
export function shouldRepairNarratedToolTurn(input: ShouldRepairNarratedToolTurnInput): boolean {
	if (input.repairEnabled === false) return false;
	if (input.signalAborted) return false;
	if (input.outcomeKind !== "finished") return false;
	if (input.completedToolCount !== 0) return false;
	return classifyNarratedToolTurn({
		finalText: input.finalText,
		knownToolNames: input.knownToolNames,
		completedToolCount: input.completedToolCount,
	}).narrated;
}

export function buildNarratedToolRepairPrompt(names: string[]): string {
	const listed = names.length > 0 ? names.join(", ") : "those tools";
	return [
		"Recovery: the previous assistant turn printed tool-call text that was NOT executed.",
		`Narrated invocations (${listed}) did not run.`,
		"Call the real Cursor SDK/MCP tools now to complete the user request.",
		"Do not re-print tool cards as assistant text.",
	].join(" ");
}

export interface MaybeRepairNarratedToolTurnParams {
	prepared: CursorProviderTurnPrepareResult;
	outcome: CursorRunOutcome;
	signal?: AbortSignal;
	sdkEventDebug?: CursorSdkEventDebugSink;
	resolvedApiKey?: string;
	optionsApiKey?: string;
	/** Injected for tests; defaults to process.env. */
	repairEnabled?: boolean;
}

type RepairCapableCoordinator = {
	completedToolCount: () => number;
	activeToolNames?: ReadonlySet<string>;
	handleDelta: (update: unknown) => void;
	handleStep: (step: unknown) => void;
	planTextCandidate?: string;
};

function asRepairCapableCoordinator(value: unknown): RepairCapableCoordinator | undefined {
	if (!value || typeof value !== "object") return undefined;
	const coordinator = value as Record<string, unknown>;
	if (typeof coordinator.completedToolCount !== "function") return undefined;
	if (typeof coordinator.handleDelta !== "function") return undefined;
	if (typeof coordinator.handleStep !== "function") return undefined;
	return coordinator as RepairCapableCoordinator;
}

function recordRepairDebug(
	sdkEventDebug: CursorSdkEventDebugSink | undefined,
	classification: NarratedToolTurnClassification,
	apiKey: string | undefined,
): void {
	try {
		sdkEventDebug?.recordCoordinatorEvent("narrated-tool-turn-repair", {
			names: classification.names.map((name) => scrubSensitiveText(name, apiKey)),
			reason: classification.reason,
			attempt: 1,
		});
	} catch {
		// Debug must never affect provider execution.
	}
}

/**
 * At most one bounded corrective continuation when the finished turn narrated tools
 * and the ledger shows zero completions. Never loops; never runs on cancel/error.
 * Fail-safe: missing ledger methods or any unexpected error returns the original outcome.
 */
export async function maybeRepairNarratedToolTurn(
	params: MaybeRepairNarratedToolTurnParams,
): Promise<CursorRunOutcome> {
	const { prepared, outcome } = params;
	if (outcome.kind !== "finished") return outcome;

	try {
		const coordinator = asRepairCapableCoordinator(prepared.runtime?.turnCoordinator);
		if (!coordinator) return outcome;

		const completedToolCount = coordinator.completedToolCount();
		const knownToolNames = coordinator.activeToolNames;
		const classification = classifyNarratedToolTurn({
			finalText: outcome.finalText,
			knownToolNames,
			completedToolCount,
		});
		const repairEnabled = params.repairEnabled ?? isNarratedToolRepairEnabled();
		if (
			!shouldRepairNarratedToolTurn({
				outcomeKind: outcome.kind,
				finalText: outcome.finalText,
				completedToolCount,
				knownToolNames,
				signalAborted: params.signal?.aborted,
				repairEnabled,
			})
		) {
			return outcome;
		}

		const apiKey = params.resolvedApiKey ?? params.optionsApiKey;
		recordRepairDebug(params.sdkEventDebug, classification, apiKey);

		const sendOptions: SendOptions = {
			mode: prepared.meta.agentMode,
			model: prepared.meta.modelSelection,
			onDelta: (args) => {
				coordinator.handleDelta(args.update);
			},
			onStep: (args) => {
				coordinator.handleStep(args.step);
			},
		};

		let run: Awaited<ReturnType<typeof prepared.agent.send>>;
		try {
			run = await prepared.agent.send(
				{ text: buildNarratedToolRepairPrompt(classification.names) },
				sendOptions,
			);
		} catch {
			return outcome;
		}

		if (params.signal?.aborted) {
			await run.cancel().catch(() => {});
			return outcome;
		}

		const waitResult = await run.wait();
		const { liveRun } = prepared.runtime;
		const { textDeltas } = prepared;
		return resolveCursorRunOutcome({
			waitResult,
			signalAborted: params.signal?.aborted,
			textDeltas: liveRun?.textDeltas ?? textDeltas,
			emittedText: liveRun?.emittedText ?? textDeltas.join(""),
			planTextCandidate: coordinator.planTextCandidate,
			selectFinalTextOptions: liveRun ? undefined : { allowPartialPrefix: true },
			resolvedApiKey: params.resolvedApiKey,
			optionsApiKey: params.optionsApiKey,
			runtimeTarget: prepared.runtimeTarget,
		});
	} catch {
		return outcome;
	}
}
