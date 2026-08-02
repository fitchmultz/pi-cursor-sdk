export interface NarratedToolInvocationSpan {
	name: string;
	start: number;
	end: number;
}

export type NarratedToolTurnReason = "no-tools-executed" | "tools-executed" | "no-narration";

export interface NarratedToolTurnClassification {
	narrated: boolean;
	names: string[];
	reason: NarratedToolTurnReason;
}

/**
 * Transcript-shaped names only. Generic host tools (Shell, read, write, …) match
 * solely via knownToolNames from the live active-tool set — never from this fallback.
 */
const BUILTIN_NARRATION_NAMES = new Set(
	["tool call", "tool result", "tool error", "callmcptool", "getmcptools"].map((name) =>
		name.toLowerCase(),
	),
);

const MULTI_WORD_BUILTIN_RE = /\b(Tool\s+call|Tool\s+result|Tool\s+error|CallMcpTool|GetMcpTools)\s*\(/gi;
const IDENTIFIER_CALL_RE = /\b([A-Za-z_][\w.]*(?:__[\w.]*)?)\s*\(/g;

function normalizeToolToken(name: string): string {
	return name.replace(/\s+/g, " ").trim().toLowerCase();
}

function knownNameSet(knownToolNames?: ReadonlySet<string>): Set<string> | undefined {
	if (!knownToolNames || knownToolNames.size === 0) return undefined;
	const normalized = new Set<string>();
	for (const name of knownToolNames) {
		const token = normalizeToolToken(name);
		if (!token) continue;
		normalized.add(token);
		if (token.startsWith("pi__")) normalized.add(token.slice("pi__".length));
		const dotted = token.includes(".") ? token.slice(token.lastIndexOf(".") + 1) : undefined;
		if (dotted) normalized.add(dotted);
	}
	return normalized;
}

function isAcceptedNarrationName(name: string, known?: Set<string>): boolean {
	const token = normalizeToolToken(name);
	if (!token) return false;
	if (BUILTIN_NARRATION_NAMES.has(token)) return true;
	if (!known) return false;
	if (known.has(token)) return true;
	if (token.startsWith("pi__") && known.has(token.slice("pi__".length))) return true;
	if (token.includes(".")) {
		const leaf = token.slice(token.lastIndexOf(".") + 1);
		if (known.has(leaf) || known.has(token)) return true;
	}
	return false;
}

/** Find matching `)` for `(` at openIndex, respecting quotes and escapes. */
export function findBalancedParenEnd(text: string, openIndex: number): number {
	if (text[openIndex] !== "(") return -1;
	let depth = 0;
	let quote: '"' | "'" | "`" | null = null;
	let escaped = false;
	for (let index = openIndex; index < text.length; index += 1) {
		const ch = text[index];
		if (quote) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (ch === "\\") {
				escaped = true;
				continue;
			}
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			quote = ch;
			continue;
		}
		if (ch === "(") {
			depth += 1;
			continue;
		}
		if (ch === ")") {
			depth -= 1;
			if (depth === 0) return index + 1;
		}
	}
	return -1;
}

function argsLookInvocable(argText: string): boolean {
	return /[=:{]/.test(argText);
}

function isLegacyTranscriptCardName(name: string): boolean {
	const token = normalizeToolToken(name);
	return token === "tool call" || token === "tool result" || token === "tool error";
}

/** Extend `Tool call (label, call id): {json}` spans past the trailing `: args` payload. */
function extendLegacyTranscriptCardEnd(text: string, parenEnd: number): number {
	let index = parenEnd;
	while (index < text.length && (text[index] === " " || text[index] === "\t")) index += 1;
	if (text[index] !== ":") return parenEnd;
	index += 1;
	while (index < text.length && (text[index] === " " || text[index] === "\t")) index += 1;
	if (text[index] === "{" || text[index] === "[") {
		const closing = text[index] === "{" ? "}" : "]";
		const open = text[index];
		let depth = 0;
		let quote: '"' | "'" | "`" | null = null;
		let escaped = false;
		for (let cursor = index; cursor < text.length; cursor += 1) {
			const ch = text[cursor];
			if (quote) {
				if (escaped) {
					escaped = false;
					continue;
				}
				if (ch === "\\") {
					escaped = true;
					continue;
				}
				if (ch === quote) quote = null;
				continue;
			}
			if (ch === '"' || ch === "'" || ch === "`") {
				quote = ch;
				continue;
			}
			if (ch === open) depth += 1;
			else if (ch === closing) {
				depth -= 1;
				if (depth === 0) return cursor + 1;
			}
		}
		return text.length;
	}
	while (index < text.length && text[index] !== "\n") index += 1;
	return index;
}

function pushSpan(
	spans: NarratedToolInvocationSpan[],
	text: string,
	name: string,
	nameStart: number,
	parenIndex: number,
): void {
	let end = findBalancedParenEnd(text, parenIndex);
	if (end < 0) return;
	let argText = text.slice(parenIndex + 1, end - 1);
	if (isLegacyTranscriptCardName(name)) {
		end = extendLegacyTranscriptCardEnd(text, end);
		argText = text.slice(parenIndex + 1, end);
	}
	if (!argsLookInvocable(argText) && !isLegacyTranscriptCardName(name)) return;
	spans.push({ name: name.replace(/\s+/g, " ").trim(), start: nameStart, end });
}

function collectCandidateMatches(text: string): Array<{ name: string; nameStart: number; parenIndex: number }> {
	const matches: Array<{ name: string; nameStart: number; parenIndex: number }> = [];
	MULTI_WORD_BUILTIN_RE.lastIndex = 0;
	for (const match of text.matchAll(MULTI_WORD_BUILTIN_RE)) {
		const raw = match[0];
		const name = match[1] ?? raw;
		const nameStart = match.index ?? 0;
		const parenIndex = nameStart + raw.lastIndexOf("(");
		matches.push({ name, nameStart, parenIndex });
	}
	IDENTIFIER_CALL_RE.lastIndex = 0;
	for (const match of text.matchAll(IDENTIFIER_CALL_RE)) {
		const name = match[1] ?? "";
		const raw = match[0];
		const nameStart = match.index ?? 0;
		// Skip identifiers already covered by multi-word builtins (e.g. "call" in "Tool call(").
		if (/^(call|result|error)$/i.test(name)) {
			const before = text.slice(Math.max(0, nameStart - 5), nameStart).toLowerCase();
			if (before.endsWith("tool ")) continue;
		}
		const parenIndex = nameStart + raw.lastIndexOf("(");
		matches.push({ name, nameStart, parenIndex });
	}
	matches.sort((a, b) => a.nameStart - b.nameStart || a.parenIndex - b.parenIndex);
	return matches;
}

/** Scanner (not line-anchored): find narrated tool invocations with balanced-paren spans. */
export function scanNarratedToolInvocations(
	text: string,
	knownToolNames?: ReadonlySet<string>,
): NarratedToolInvocationSpan[] {
	if (!text) return [];
	const known = knownNameSet(knownToolNames);
	const spans: NarratedToolInvocationSpan[] = [];
	let cursor = 0;
	for (const candidate of collectCandidateMatches(text)) {
		if (candidate.nameStart < cursor) continue;
		if (!isAcceptedNarrationName(candidate.name, known)) continue;
		const before = spans.length;
		pushSpan(spans, text, candidate.name, candidate.nameStart, candidate.parenIndex);
		if (spans.length > before) cursor = spans[spans.length - 1].end;
	}
	return spans;
}

export function isNarratedToolText(text: string, knownToolNames?: ReadonlySet<string>): boolean {
	return scanNarratedToolInvocations(text, knownToolNames).length > 0;
}

/** Remove matched invocation spans; keep surrounding prose. */
export function stripNarratedToolInvocations(
	text: string,
	knownToolNames?: ReadonlySet<string>,
): { text: string; removed: number } {
	const spans = scanNarratedToolInvocations(text, knownToolNames);
	if (spans.length === 0) return { text, removed: 0 };
	let out = "";
	let cursor = 0;
	for (const span of spans) {
		out += text.slice(cursor, span.start);
		cursor = span.end;
	}
	out += text.slice(cursor);
	out = out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
	return { text: out, removed: spans.length };
}

/**
 * Ledger cross-check: narration is only asserted when text scans as tool invocations
 * AND zero tools completed for the turn.
 */
export function classifyNarratedToolTurn(input: {
	finalText: string;
	knownToolNames?: ReadonlySet<string>;
	completedToolCount: number;
}): NarratedToolTurnClassification {
	const spans = scanNarratedToolInvocations(input.finalText, input.knownToolNames);
	const names = [...new Set(spans.map((span) => span.name))];
	if (names.length === 0) {
		return { narrated: false, names: [], reason: "no-narration" };
	}
	if (input.completedToolCount > 0) {
		return { narrated: false, names, reason: "tools-executed" };
	}
	return { narrated: true, names, reason: "no-tools-executed" };
}
