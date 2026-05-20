import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const root = new URL(".", import.meta.url).pathname;
const capturesDir = path.join(root, "captures");
const outDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, "screenshots");
fs.mkdirSync(outDir, { recursive: true });

const nameFilter = process.argv[3] ?? "";
const htmlFiles = fs
	.readdirSync(capturesDir)
	.filter((name) => name.endsWith(".html") && (!nameFilter || name.startsWith(nameFilter)))
	.sort();

if (htmlFiles.length === 0) {
	console.error(`No HTML files in ${capturesDir}`);
	process.exit(1);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

for (const file of htmlFiles) {
	const slug = file.replace(/\.html$/, "");
	const fileUrl = `file://${path.join(capturesDir, file)}`;
	await page.goto(fileUrl, { waitUntil: "networkidle" });
	await page.waitForTimeout(400);
	const toolCards = page.locator(".tool-execution");
	const count = await toolCards.count();
	if (count === 0) {
		await page.screenshot({ path: path.join(outDir, `${slug}-full.png`), fullPage: true });
		continue;
	}
	for (let i = 0; i < count; i += 1) {
		const card = toolCards.nth(i);
		await card.scrollIntoViewIfNeeded();
		await page.waitForTimeout(120);
		await card.screenshot({ path: path.join(outDir, `${slug}-tool-${i + 1}.png`) });
	}
}

await browser.close();
console.log(`Wrote ${htmlFiles.length} session(s) to ${outDir}`);
