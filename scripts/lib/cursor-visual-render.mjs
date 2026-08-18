import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

function escapeHtml(text) {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function htmlJson(value) {
	return JSON.stringify(value).replace(/</g, "\\u003c");
}

function loadXtermAssets() {
	const require = createRequire(import.meta.url);
	try {
		return {
			css: readFileSync(require.resolve("@xterm/xterm/css/xterm.css"), "utf8"),
			js: readFileSync(require.resolve("@xterm/xterm/lib/xterm.js"), "utf8"),
		};
	} catch (error) {
		throw new Error(`failed to load @xterm/xterm assets; run npm install: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function buildTerminalHtml({ ansi, plain, options }) {
	const assets = loadXtermAssets();
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>pi-cursor-sdk visual smoke: ${escapeHtml(options.label)}</title>
<style>
${assets.css}
:root { color-scheme: dark; }
body {
	margin: 0;
	padding: 16px;
	background: #0b0f14;
	color: #d8dee9;
	font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
header {
	margin: 0 0 12px;
	font-size: 13px;
	line-height: 1.4;
	color: #9aa4b2;
}
header code { color: #d8dee9; }
#terminal {
	display: inline-block;
	padding: 12px;
	border: 1px solid #303846;
	border-radius: 8px;
	background: #0b0f14;
	box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
}
.fallback {
	white-space: pre-wrap;
	font-family: Menlo, Monaco, Consolas, "Liberation Mono", monospace;
	font-size: 12px;
}
</style>
<script>${assets.js}</script>
</head>
<body>
<header>
	<div><strong>pi-cursor-sdk visual smoke</strong> <code>${escapeHtml(options.label)}</code></div>
	<div>model <code>${escapeHtml(options.model)}</code> · mode <code>${escapeHtml(options.mode)}</code> · cwd <code>${escapeHtml(options.cwd)}</code></div>
	<div>session <code>${escapeHtml(options.sessionId ?? "pi-assigned")}</code> · captured ${new Date().toISOString()}</div>
</header>
<div id="terminal"></div>
<noscript><pre class="fallback">${escapeHtml(plain)}</pre></noscript>
<script>
const ansi = ${htmlJson(ansi)};
const fallbackText = ${htmlJson(plain)};
const terminalElement = document.getElementById("terminal");
try {
	const term = new Terminal({
		cols: ${options.width},
		rows: ${options.height},
		convertEol: true,
		fontFamily: 'Menlo, Monaco, Consolas, "Liberation Mono", monospace',
		fontSize: 13,
		lineHeight: 1.18,
		scrollback: ${options.historyLines},
		theme: {
			background: '#0b0f14',
			foreground: '#d8dee9',
			cursor: '#d8dee9'
		}
	});
	term.open(terminalElement);
	term.resize(${options.width}, ${options.height});
	window.__piVisualSmokeTerminal = term;
	term.write(ansi, () => {
		document.body.setAttribute("data-render-ready", "true");
	});
} catch (error) {
	const pre = document.createElement("pre");
	pre.className = "fallback";
	pre.textContent = fallbackText + "\\n\\n[xterm render failed: " + String(error) + "]";
	terminalElement.replaceChildren(pre);
	document.body.setAttribute("data-render-ready", "true");
}
</script>
</body>
</html>
`;
}

export async function writeTerminalScreenshot(htmlPath, pngPath, width, height) {
	let browser;
	try {
		const { chromium } = await import("playwright");
		browser = await chromium.launch();
		const page = await browser.newPage({
			viewport: {
				width: Math.max(1_200, width * 10),
				height: Math.max(800, height * 22),
			},
			deviceScaleFactor: 1,
		});
		await page.goto(pathToFileURL(htmlPath).href);
		await page.waitForSelector('body[data-render-ready="true"]', { timeout: 30_000 });
		await page.locator("#terminal").screenshot({ path: pngPath });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`failed to capture PNG with Playwright: ${message}\nInstall Chromium with: npx playwright install chromium\nOr rerun with --no-screenshot and capture ${htmlPath} with agent_browser.`);
	} finally {
		if (browser) await browser.close();
	}
}
