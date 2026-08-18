/**
 * Card detector — records stable visible evidence regions from rendered terminal output.
 *
 * This is intentionally stricter than a raw text-marker search: prompt lines such as
 * "call pi__read" must not satisfy card assertions. Per-card screenshots come from
 * visual-evidence.mjs; this module writes the legacy cards.json/index.html inventory.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { matchesWrappedLineAt } from "./wrapped-line-match.mjs";

const CARD_PATTERNS = [
	{
		id: "read",
		pattern: /^\s*read\s+(?:(?:\.\/)?package\.json|.*[\\/]package\.json)(?:\s+·\s+local file preview)?\s*$/i,
		wrappedPattern: /^\s*read\s+.*[\\/]package\.(?:json|js\s+on|j\s*son)(?:\s+·\s+local file preview)?\s*$/i,
	},
	{ id: "grep", pattern: /^\s*grep \/pi-cursor-sdk\/ in\s+(?:(?:\S+[\\/])?README\.md)\s*$/i },
	{ id: "find", pattern: /^\s*find README\.md in\s+\S+/i },
	{ id: "list", pattern: /^\s*(?:find \* in src|find src\/\* in \.|Get-ChildItem -Name \.\/src)\s*/i },
	{ id: "shell-success", pattern: /^\s*cursor visual smoke\s*$/i },
	{ id: "write", pattern: /^\s*\+.*beta\s*$/i },
	{ id: "edit-diff", pattern: /^\s*\+.*gamma\s*$/i },
	{ id: "shell-failure", pattern: /^\s*(?:native shell failure|Command exited with code 7)\s*$/i },
	{
		id: "bridge-read-success",
		pattern: /^\s*read\s+(?:\.\/package\.json|.*[\\/]package\.j(?:son|s))\s*$/i,
		wrappedPattern: /^\s*read\s+.*[\\/]package\.(?:json|js\s+on|j\s*son)\s*$/i,
	},
	{ id: "bridge-read-failure", pattern: /^\s*(?:read \.\/definitely-missing-platform-smoke-file\.txt|ENOENT: no such file)\s*/i },
	{ id: "bridge-shell-success", pattern: /^\s*bridge visual smoke\s*$/i },
	{ id: "http1-status", pattern: /\bcursor:local\b.*\bhttp1\b/i },
	{ id: "footer-status", pattern: /\bgrok-4\.6\b|\bcomposer-2-5\b|\bcomposer-2\.5\b/i },
];

function cleanLine(line) {
	return line
		.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\r/g, "");
}

function matchesCardAt(lines, index, card) {
	return matchesWrappedLineAt(lines, index, card.pattern, card.wrappedPattern);
}

/**
 * Detect stable rendered evidence regions in terminal text.
 *
 * Returns an array of { id, label, startLine, endLine }.
 */
export function detectCards(txtContent) {
	const lines = txtContent.split("\n").map(cleanLine);
	const cards = [];
	const seen = new Set();

	for (let i = 0; i < lines.length; i++) {
		for (const card of CARD_PATTERNS) {
			if (seen.has(card.id)) continue;
			if (!matchesCardAt(lines, i, card)) continue;
			seen.add(card.id);
			cards.push({
				id: card.id,
				label: card.id,
				startLine: i,
				endLine: i,
			});
		}
	}

	return cards;
}

/** Write cards.json and cards/index.html gallery. */
export function writeCardArtifacts(dir, cards) {
	mkdirSync(resolve(dir, "cards"), { recursive: true });

	const cardsData = cards.map(c => ({
		id: c.id,
		label: c.label,
		startLine: c.startLine,
		endLine: c.endLine,
		lineCount: c.endLine - c.startLine + 1,
	}));

	writeFileSync(resolve(dir, "cards", "cards.json"), JSON.stringify(cardsData, null, 2));

	const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Cards Gallery</title>
<style>
body { font-family: monospace; background: #1e1e1e; color: #d4d4d4; padding: 20px; }
.card { border: 1px solid #444; margin: 8px 0; padding: 8px; }
.card h3 { margin: 0 0 4px 0; color: #569cd6; }
.card .meta { color: #888; font-size: 12px; }
</style></head><body>
<h1>Cards Gallery</h1>
${cardsData.map(c => `<div class="card"><h3>${c.label}</h3><div class="meta">line ${c.startLine}</div></div>`).join("\n")}
</body></html>`;

	writeFileSync(resolve(dir, "cards", "index.html"), html);
}

/** Assert that required cards are present as distinct exact evidence ids. */
export function assertRequiredCards(_dir, detectedCards, requiredCards) {
	const detectedIds = new Set(detectedCards.map(c => c.id));
	return requiredCards.map((req) => ({ id: `card-${req}`, ok: detectedIds.has(req) }));
}
