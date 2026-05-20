import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const root = new URL(".", import.meta.url).pathname;
const capturesDir = path.join(root, "captures");
const outDir = path.join(root, "screenshots");
fs.mkdirSync(outDir, { recursive: true });

const pairs = [
	["glm-5.1-p1", "composer-2.5-p1", "read-package-json"],
	["glm-5.1-p2", "composer-2.5-p2", "list-src"],
	["glm-5.1-p3", "composer-2.5-p3", "bash-echo"],
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

for (const [glm, composer, label] of pairs) {
	for (const slug of [glm, composer]) {
		const htmlPath = path.join(capturesDir, `${slug}.html`);
		const fileUrl = `file://${htmlPath}`;
		await page.goto(fileUrl, { waitUntil: "networkidle" });
		await page.waitForTimeout(500);
		const toolCards = page.locator(".tool-execution");
		const count = await toolCards.count();
		if (count === 0) {
			await page.screenshot({ path: path.join(outDir, `${slug}-${label}-full.png`), fullPage: true });
			continue;
		}
		for (let i = 0; i < count; i += 1) {
			const card = toolCards.nth(i);
			await card.scrollIntoViewIfNeeded();
			await page.waitForTimeout(150);
			await card.screenshot({ path: path.join(outDir, `${slug}-${label}-tool-${i + 1}.png`) });
		}
	}
}

await browser.close();
console.log(`Wrote screenshots to ${outDir}`);
