import { existsSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";

// Node 24 strips source types; resolve the source tree's emitted .js imports to .ts.
// src/cursor-config.ts and its imports must stay erasable (no enums or parameter properties; type-only imports use `type`).
const sourceUrl = new URL("../../src/", import.meta.url).href;
registerHooks({ resolve(specifier, context, nextResolve) {
	if (context.parentURL?.startsWith(sourceUrl) && specifier.startsWith(".") && specifier.endsWith(".js")) {
		return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
	}
	return nextResolve(specifier, context);
} });
const { updateCursorSdkConfig } = await import("../../src/cursor-config.ts");
const [configPath, gatePath, writerKey] = process.argv.slice(2);
if (!configPath || !gatePath || !writerKey) throw new Error("Expected config path, gate path and writer key");

const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
writeFileSync(`${gatePath}.${writerKey}.started`, "");
updateCursorSdkConfig(configPath, (current) => {
	writeFileSync(`${gatePath}.${writerKey}.ready`, "");
	const deadline = Date.now() + 15_000;
	while (!existsSync(gatePath)) {
		if (Date.now() >= deadline) throw new Error("writer gate timed out");
		Atomics.wait(waitBuffer, 0, 0, 20);
	}
	return { ...current, [writerKey]: true };
}, { newFileMode: 0o600 });
