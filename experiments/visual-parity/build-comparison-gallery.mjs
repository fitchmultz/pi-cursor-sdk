import fs from "node:fs";
import path from "node:path";

const root = new URL(".", import.meta.url).pathname;
const assets = path.join(root, "pr-assets");
const beforeDir = path.join(assets, "before/screenshots");
const afterDir = path.join(assets, "after/screenshots");

function listPngs(dir) {
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir).filter((name) => name.endsWith(".png")).sort();
}

function pick(dir, candidates) {
	const files = listPngs(dir);
	for (const pattern of candidates) {
		const match = files.find((name) => name.includes(pattern));
		if (match) return match;
	}
	return files[0];
}

const rows = [
	["read", ["capture-p1", "after-p1"]],
	["ls", ["capture-p2", "after-p2"]],
	["bash", ["capture-p3", "after-p3"]],
	["grep", ["capture-p4", "after-p4"]],
	["find", ["capture-p5", "after-p5"]],
	["write", ["composer-write", "glm-write"]],
	["edit", ["composer-edit", "glm-edit"]],
]
	.map(([label, [beforeKey, afterKey]]) => {
		const before = pick(beforeDir, [beforeKey]);
		const after = pick(afterDir, [afterKey]);
		if (!before && !after) return "";
		const beforeBlock = before
			? `<figure><figcaption>Before (main)</figcaption><img src="before/screenshots/${before}" alt="before ${label}" /></figure>`
			: `<figure><figcaption>Before (main)</figcaption><p><em>No native tool card — activity fell back to plain assistant text.</em></p></figure>`;
		const afterBlock = after
			? `<figure><figcaption>After (parity branch)</figcaption><img src="after/screenshots/${after}" alt="after ${label}" /></figure>`
			: "";
		return `<section><h2>${label}</h2><div class="row">${beforeBlock}${afterBlock}</div></section>`;
	})
	.join("\n");

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Cursor composer TUI parity — before / after</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #18181e; color: #e5e5e7; padding: 24px; max-width: 1400px; margin: 0 auto; }
    h1 { font-size: 1.35rem; }
    h2 { font-size: 1rem; color: #8abeb7; margin-top: 2rem; }
    .row { display: flex; gap: 16px; flex-wrap: wrap; align-items: flex-start; }
    figure { margin: 0; flex: 1; min-width: 300px; }
    figcaption { font-size: 0.85rem; color: #808080; margin-bottom: 8px; }
    img { width: 100%; border: 1px solid #505050; border-radius: 4px; }
    video { width: 100%; max-width: 960px; border: 1px solid #505050; border-radius: 4px; }
    code { color: #8abeb7; }
  </style>
</head>
<body>
  <h1>cursor/composer-2.5 native tool cards — before vs after</h1>
  <p>Captured from pi session HTML export (same renderer as the interactive TUI). <strong>Before</strong> = <code>main</code> extension code. <strong>After</strong> = this PR.</p>
  ${rows}
  <section>
    <h2>Demo video</h2>
    <video controls src="demo.mp4"></video>
  </section>
</body>
</html>`;

fs.mkdirSync(assets, { recursive: true });
fs.writeFileSync(path.join(assets, "comparison-gallery.html"), html);
console.log(`Wrote ${path.join(assets, "comparison-gallery.html")}`);
