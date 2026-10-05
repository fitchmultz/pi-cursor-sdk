import { normalizeCursorToolName } from "./cursor-tool-presentation-registry.js";
import { getToolArgs, getToolName } from "./cursor-transcript-utils.js";

export type CursorToolDisplaySource = "started" | "fallback" | "transcript";

export interface ToolCompletionDedupeInput {
	identity?: string;
	source?: CursorToolDisplaySource;
	fingerprint: string;
}

export type ToolCompletionDedupeReason =
	| "identity-already-completed"
	| "fallback-fingerprint-already-completed"
	| "fingerprint-already-completed";

export class CursorToolCompletionLedger {
	private readonly startedToolCalls = new Map<string, unknown>();
	private readonly bridgeStartedToolCallIds = new Set<string>();
	private readonly completedToolIdentities = new Set<string>();
	private readonly completedStartedToolFingerprints = new Set<string>();
	private readonly completedFallbackToolFingerprints = new Set<string>();

	getStartedToolCall(callId: string): unknown | undefined {
		return this.startedToolCalls.get(callId);
	}

	hasStartedToolCall(callId: string): boolean {
		return this.startedToolCalls.has(callId);
	}

	registerStartedToolCall(callId: string, toolCall: unknown): void {
		this.startedToolCalls.set(callId, toolCall);
	}

	markBridgeStarted(callId: string): void {
		this.bridgeStartedToolCallIds.add(callId);
	}

	takeBridgeStartedCallId(callId: string): string | undefined {
		if (!this.bridgeStartedToolCallIds.has(callId)) return undefined;
		this.bridgeStartedToolCallIds.delete(callId);
		return callId;
	}

	clearStartedToolCall(callId: string): void {
		this.startedToolCalls.delete(callId);
		this.bridgeStartedToolCallIds.delete(callId);
	}

	removeStartedToolCallForStep(toolCall: unknown, stepId: unknown): string | undefined {
		if (typeof stepId === "string" && this.startedToolCalls.has(stepId)) {
			this.clearStartedToolCall(stepId);
			return stepId;
		}
		const fingerprint = getStartedToolCallFingerprint(toolCall);
		const matches = [...this.startedToolCalls].filter(([, started]) => getStartedToolCallFingerprint(started) === fingerprint);
		// Identical concurrent shells cannot be joined safely without a matching ID.
		if (normalizeCursorToolName(getToolName(toolCall)) === "shell" && matches.length !== 1) return undefined;
		const callId = matches[0]?.[0];
		if (callId !== undefined) this.clearStartedToolCall(callId);
		return callId;
	}

	recordCompletedIdentity(identity: string): void {
		this.completedToolIdentities.add(identity);
	}

	shouldSkipDuplicateCompletion(input: ToolCompletionDedupeInput): ToolCompletionDedupeReason | undefined {
		if (input.identity && this.completedToolIdentities.has(input.identity)) {
			return "identity-already-completed";
		}
		if (input.source === "started") {
			if (this.completedFallbackToolFingerprints.has(input.fingerprint)) {
				return "fallback-fingerprint-already-completed";
			}
			return undefined;
		}
		if (
			this.completedStartedToolFingerprints.has(input.fingerprint) ||
			this.completedFallbackToolFingerprints.has(input.fingerprint)
		) {
			return "fingerprint-already-completed";
		}
		return undefined;
	}

	recordCompletedTool(input: ToolCompletionDedupeInput): void {
		if (input.identity) this.completedToolIdentities.add(input.identity);
		if (input.source === "started") {
			this.completedStartedToolFingerprints.add(input.fingerprint);
		} else {
			this.completedFallbackToolFingerprints.add(input.fingerprint);
		}
	}

	clear(): void {
		this.startedToolCalls.clear();
		this.bridgeStartedToolCallIds.clear();
		this.completedToolIdentities.clear();
		this.completedStartedToolFingerprints.clear();
		this.completedFallbackToolFingerprints.clear();
	}

	/** Exposed for incomplete-tool discard iteration. */
	startedToolCallEntries(): IterableIterator<[string, unknown]> {
		return this.startedToolCalls.entries();
	}

	clearStartedToolCalls(): void {
		this.startedToolCalls.clear();
		this.bridgeStartedToolCallIds.clear();
	}
}

export function getToolFingerprint(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

export function getStartedToolCallFingerprint(toolCall: unknown): string {
	const name = getToolName(toolCall);
	// Accept legacy shell aliases; this does not establish that the SDK emits alias-changing pairs.
	// Keep exact argument matching; assistant text alone is not completion proof.
	const toolName = normalizeCursorToolName(name) === "shell" ? "shell" : name;
	return getToolFingerprint({ toolName, args: getToolArgs(toolCall) });
}
