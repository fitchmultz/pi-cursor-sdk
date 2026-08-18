/**
 * Host-side ANSI renderer — converts terminal.ansi into HTML and PNG screenshots.
 *
 * This wraps the existing visual smoke renderer so platform smoke uses the same
 * xterm.js/Playwright path as the maintainer visual TUI smoke.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildTerminalHtml, writeTerminalScreenshot } from "../lib/cursor-visual-render.mjs";

const COLS = 150;
const ROWS = 45;
const HISTORY_LINES = 3_000;

function stripANSI(text) {
	return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "");
}

/** Render terminal.ansi to terminal.html using the shared xterm.js renderer. */
export async function renderHTML(ansiPath, htmlPath, options = {}) {
	const ansi = readFileSync(ansiPath, "utf8");
	const plain = options.plain ?? stripANSI(ansi);
	const html = buildTerminalHtml({
		ansi,
		plain,
		options: {
			label: options.label ?? "platform-smoke",
			model: options.model ?? "cursor/grok-4.6",
			mode: options.mode ?? "agent",
			cwd: options.cwd ?? process.cwd(),
			sessionId: options.sessionId ?? "platform-smoke",
			width: options.width ?? COLS,
			height: options.height ?? ROWS,
			historyLines: options.historyLines ?? HISTORY_LINES,
		},
	});
	writeFileSync(htmlPath, html);
	return htmlPath;
}

/** Render terminal.html to terminal.full.png and terminal.final-viewport.png using Playwright. */
export async function renderPNG(htmlPath, fullPNGPath, viewportPNGPath, options = {}) {
	try {
		await writeTerminalScreenshot(htmlPath, fullPNGPath, options.width ?? COLS, options.height ?? ROWS);
		// The shared renderer captures the terminal element. Keep a second artifact name for the platform contract.
		writeFileSync(viewportPNGPath, readFileSync(fullPNGPath));
		return { fullPNGPath, viewportPNGPath };
	} catch (error) {
		console.log(`  PNG render skipped: ${error instanceof Error ? error.message : String(error)}`);
		return null;
	}
}

/** Full render pipeline: ANSI → HTML → PNG. */
export async function renderAll(ansiPath, dir, options = {}) {
	mkdirSync(dir, { recursive: true });
	const htmlPath = resolve(dir, "terminal.html");
	const fullPNGPath = resolve(dir, "terminal.full.png");
	const viewportPNGPath = resolve(dir, "terminal.final-viewport.png");
	await renderHTML(ansiPath, htmlPath, options);
	const pngResult = await renderPNG(htmlPath, fullPNGPath, viewportPNGPath, options);
	return { htmlPath, fullPNGPath, viewportPNGPath, pngOk: pngResult !== null };
}
