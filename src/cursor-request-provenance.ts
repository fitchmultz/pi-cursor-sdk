import { createHash } from "node:crypto";
import { convertToLlm, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Context, Model } from "@earendil-works/pi-ai";

export interface CursorRequestProvenance {
	readonly purpose: "normal" | "compaction" | "tree";
	readonly occupancyFloor?: number;
	/** Canonical native source roles in converted conversation order, only for an equivalent request. */
	readonly nativeSourceRoles?: readonly string[];
}

interface Measurement {
	readonly api: string;
	readonly provider: string;
	readonly model: string;
	readonly tokens: number;
}

/** Receipt data contains hashes and source-role/accounting scalars only, never conversation text. */
export interface CursorRequestProjectionSnapshot {
	readonly digest: string;
	readonly measurements: readonly Measurement[];
	readonly nativeSourceRoles: readonly string[];
}

function projectionDigest(messages: readonly unknown[]): string {
	const hash = createHash("sha256");
	for (const message of messages) {
		// Stable value equivalence survives Pi's cloning and property insertion order.
		hash.update(JSON.stringify(message, (_key, value: unknown) => {
			if (!value || typeof value !== "object" || Array.isArray(value)) return value;
			return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
		}));
		hash.update("\n");
	}
	return hash.digest("hex");
}

export function captureCursorRequestProjection(manager: ExtensionContext["sessionManager"]): CursorRequestProjectionSnapshot {
	const branch = manager.getBranch();
	const projection = manager.buildSessionProjection();
	const order = new Map(branch.map((entry, index) => [entry.id, index]));
	const boundary = branch.findLastIndex((entry) => entry.type === "compaction" || entry.type === "context_edit");
	const measurements: Measurement[] = [];
	// Raw branch chronology, not projected order or clocks, determines freshness.
	for (const entry of [...projection.entries].sort((a, b) => (order.get(a.sourceEntry.id) ?? -1) - (order.get(b.sourceEntry.id) ?? -1))) {
		if ((order.get(entry.sourceEntry.id) ?? -1) <= boundary) continue;
		for (const message of entry.messages) {
			if (message.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted") continue;
			const tokens = message.usage.totalTokens;
			if (!Number.isFinite(tokens) || tokens <= 0) continue;
			measurements.push(Object.freeze({ api: message.api, provider: message.provider, model: message.model, tokens }));
		}
	}
	const nativeSourceRoles = projection.messages.flatMap((message) =>
		message.role === "system" ? [] : convertToLlm([message]).map(() => message.role));
	return Object.freeze({
		digest: projectionDigest(convertToLlm(projection.messages)),
		measurements: Object.freeze(measurements),
		nativeSourceRoles: Object.freeze(nativeSourceRoles),
	});
}

export function resolveCursorRequestProvenance(
	snapshot: CursorRequestProjectionSnapshot,
	model: Model<Api>,
	context: Context,
	purpose: CursorRequestProvenance["purpose"],
): CursorRequestProvenance {
	// ponytail: canonical native origin only. Unmatched transforms stay conservative;
	// upgrade if Pi exposes final request-bound source provenance.
	if (purpose !== "normal" || snapshot.digest !== projectionDigest(context.messages)) return Object.freeze({ purpose });
	const measurement = snapshot.measurements.findLast((item) => item.api === model.api && item.provider === model.provider && item.model === model.id && item.tokens <= model.contextWindow);
	return Object.freeze({
		purpose,
		nativeSourceRoles: snapshot.nativeSourceRoles,
		...(measurement ? { occupancyFloor: measurement.tokens } : {}),
	});
}
