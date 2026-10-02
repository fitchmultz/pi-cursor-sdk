import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { matchesWrappedLineAt } from "./wrapped-line-match.mjs";
import { detectCards, writeCardArtifacts } from "./card-detect.mjs";

function pngSize(path) {
	try {
		const buffer = readFileSync(path);
		if (buffer.length < 24 || buffer.toString("ascii", 1, 4) !== "PNG") return undefined;
		return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), bytes: buffer.length };
	} catch {
		return undefined;
	}
}

function safeFileName(id) {
	return String(id).replace(/[^A-Za-z0-9_.-]+/g, "-");
}

function makeRegex(spec, key = "pattern") {
	if (!spec?.[key]) return undefined;
	try {
		return new RegExp(spec[key], spec.flags ?? "i");
	} catch {
		return undefined;
	}
}

export function findVisualEvidenceItems(lines, specs = []) {
	return specs.map((spec) => {
		const regex = makeRegex(spec);
		const wrappedRegex = makeRegex(spec, "wrappedPattern");
		if (!regex) return { id: spec.id, ok: false, error: `invalid regex: ${spec.pattern}` };
		const lineIndex = lines.findIndex((_line, index) => matchesWrappedLineAt(lines, index, regex, wrappedRegex));
		if (lineIndex === -1) return { id: spec.id, ok: false, pattern: spec.pattern };
		return { id: spec.id, ok: true, pattern: spec.pattern, lineIndex, line: lines[lineIndex] };
	});
}

export async function collectVisualEvidence({ htmlPath, pngPath, outDir, specs = [] }) {
	mkdirSync(outDir, { recursive: true });
	let cards = [];
	const evidence = {
		ok: false,
		htmlPath,
		pngPath,
		png: pngSize(pngPath),
		style: null,
		items: [],
		checks: [],
		writtenAt: new Date().toISOString(),
	};

	if (!existsSync(htmlPath)) {
		evidence.checks.push({ id: "visual-html-present", ok: false, error: "terminal.html missing" });
		writeCardArtifacts(outDir, cards);
		writeFileSync(resolve(outDir, "visual-evidence.json"), JSON.stringify(evidence, null, 2));
		return { ...evidence, cards };
	}

	let browser;
	try {
		const { chromium } = await import("playwright");
		browser = await chromium.launch();
		const page = await browser.newPage({ viewport: { width: 1_400, height: 1_000 }, deviceScaleFactor: 1 });
		await page.goto(pathToFileURL(htmlPath).href);
		await page.waitForSelector('body[data-render-ready="true"]', { timeout: 30_000 });
		evidence.style = await page.evaluate(() => {
			const terminal = document.querySelector("#terminal");
			const screen = document.querySelector(".xterm-screen");
			const rows = [...document.querySelectorAll(".xterm-rows > div")];
			const spans = [...document.querySelectorAll(".xterm-rows span")];
			const terminalStyle = terminal ? getComputedStyle(terminal) : undefined;
			const screenStyle = screen ? getComputedStyle(screen) : undefined;
			const colors = new Set(spans.map((span) => getComputedStyle(span).color));
			const backgrounds = new Set(spans.map((span) => getComputedStyle(span).backgroundColor));
			const term = window.__piVisualSmokeTerminal;
			return {
				terminalPresent: Boolean(terminal),
				terminalRect: terminal ? terminal.getBoundingClientRect().toJSON() : null,
				screenRect: screen ? screen.getBoundingClientRect().toJSON() : null,
				rowCount: rows.length,
				spanCount: spans.length,
				colorCount: colors.size,
				backgroundCount: backgrounds.size,
				terminalBackground: terminalStyle?.backgroundColor,
				terminalBorderColor: terminalStyle?.borderColor,
				terminalBorderRadius: terminalStyle?.borderRadius,
				screenBackground: screenStyle?.backgroundColor,
				bufferLength: term?.buffer?.active?.length ?? 0,
			};
		});

		const lines = await page.evaluate(() => {
			const term = window.__piVisualSmokeTerminal;
			const buffer = term?.buffer?.active;
			if (!buffer) return [];
			const out = [];
			for (let index = 0; index < buffer.length; index++) {
				out.push(buffer.getLine(index)?.translateToString(true) ?? "");
			}
			return out;
		});
		cards = detectCards(lines);

		for (const item of findVisualEvidenceItems(lines, specs)) {
			if (item.ok) {
				const screenshot = `cards/${safeFileName(item.id)}.png`;
				await page.evaluate((targetLine) => {
					window.__piVisualSmokeTerminal?.scrollToLine(Math.max(0, targetLine - 4));
				}, item.lineIndex);
				await page.waitForTimeout(100);
				await page.locator("#terminal").screenshot({ path: resolve(outDir, screenshot) });
				evidence.items.push({ ...item, screenshot });
			} else {
				evidence.items.push(item);
			}
		}
	} catch (error) {
		evidence.checks.push({ id: "visual-playwright", ok: false, error: error instanceof Error ? error.message : String(error) });
	} finally {
		if (browser) await browser.close();
	}

	const style = evidence.style;
	const png = evidence.png;
	evidence.checks.push(
		{ id: "visual-png-size", ok: Boolean(png && png.width >= 800 && png.height >= 500 && png.bytes > 10_000), value: png },
		{ id: "visual-terminal-present", ok: style?.terminalPresent === true },
		{ id: "visual-xterm-buffer", ok: Number(style?.bufferLength ?? 0) >= 10, value: style?.bufferLength ?? 0 },
		{ id: "visual-xterm-rows", ok: Number(style?.rowCount ?? 0) >= 20, value: style?.rowCount ?? 0 },
		{ id: "visual-xterm-styled-spans", ok: Number(style?.spanCount ?? 0) >= 10, value: style?.spanCount ?? 0 },
		{ id: "visual-terminal-theme", ok: style?.terminalBackground === "rgb(11, 15, 20)" && style?.terminalBorderColor !== "rgba(0, 0, 0, 0)" && style?.terminalBorderRadius !== "0px", value: style },
	);
	for (const item of evidence.items) {
		evidence.checks.push({ id: `visual-evidence-${item.id}`, ok: item.ok === true, line: item.line, screenshot: item.screenshot, pattern: item.pattern, error: item.error });
	}
	evidence.ok = evidence.checks.every((check) => check.ok);
	writeCardArtifacts(outDir, cards);
	writeFileSync(resolve(outDir, "visual-evidence.json"), JSON.stringify(evidence, null, 2));
	return { ...evidence, cards };
}
