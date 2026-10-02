import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { renderAll } from "../scripts/platform-smoke/render-ansi.mjs";
import { collectVisualEvidence } from "../scripts/platform-smoke/visual-evidence.mjs";
import { assertRequiredCards } from "../scripts/platform-smoke/card-detect.mjs";
import { getScenario } from "../scripts/platform-smoke/scenarios.mjs";

// Host renderer contract: run with node --test; requires Chromium checked by platform doctor.
test("rendered xterm cards survive ANSI redraw and reject prompt-only or missing-render evidence", async () => {
	const root = mkdtempSync(join(tmpdir(), "platform-rendered-cards-"));
	const spec = getScenario("cursor-bridge-visual-matrix").visualEvidence.find(item => item.id === "bridge-shell-success");
	const prompt = "1. call pi__bash with command: node -e \"console.log('bridge visual smoke')\"\r\n";
	try {
		const ansi = prompt + "\x1b[36m" + "rendered padding\r\n".repeat(25) +
			"footer and spinner\r\x1b[2Kbridge visual smoke\x1b[0m\r\n";
		assert(!stripVTControlCharacters(ansi).split("\n").some(line => /^\s*bridge visual smoke\s*$/.test(line)));
		const ansiPath = join(root, "terminal.ansi");
		writeFileSync(ansiPath, ansi);
		const rendered = await renderAll(ansiPath, root);
		const collect = () => collectVisualEvidence({
			htmlPath: rendered.htmlPath, pngPath: rendered.fullPNGPath, outDir: root, specs: [spec],
		});
		const evidence = await collect();
		assert.equal(evidence.ok, true);
		assert.equal(evidence.items[0].line, "bridge visual smoke");
		assert.equal(evidence.cards?.some(card => card.id === "bridge-shell-success"), true,
			"legacy inventory must include the standalone rendered output after redraw");
		const inventory = JSON.parse(readFileSync(join(root, "cards/cards.json"), "utf8"));
		assert(assertRequiredCards(root, inventory, ["bridge-shell-success"]).every(check => check.ok));
		assert(readFileSync(join(root, "cards/index.html"), "utf8").includes("bridge-shell-success"));
		assert.equal(inventory.find(card => card.id === "bridge-shell-success").startLine, evidence.items[0].lineIndex);

		writeFileSync(ansiPath, prompt);
		await renderAll(ansiPath, root);
		const promptOnly = await collect();
		assert.equal(promptOnly.items[0].ok, false);
		assert.equal(promptOnly.cards.length, 0);
		assert(assertRequiredCards(root, promptOnly.cards, ["bridge-shell-success"]).every(check => !check.ok));

		// A ready HTML fallback with matching text is not a rendered xterm buffer.
		writeFileSync(rendered.htmlPath, '<body data-render-ready="true"><div id="terminal">bridge visual smoke</div></body>');
		const missingRender = await collect();
		assert.equal(missingRender.ok, false);
		assert.equal(missingRender.cards.length, 0);
		assert.deepEqual(JSON.parse(readFileSync(join(root, "cards/cards.json"), "utf8")), []);
		assert(assertRequiredCards(root, missingRender.cards, ["bridge-shell-success"]).every(check => !check.ok));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
