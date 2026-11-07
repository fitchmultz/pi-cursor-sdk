if (process.env.TSC_STUB_FAIL === "1") {
	console.error("stub-tsc: induced failure");
	process.exit(1);
}

const fs = require("node:fs");
const path = require("node:path");
const outDir = process.argv[process.argv.indexOf("--outDir") + 1];
fs.mkdirSync(outDir, { recursive: true });
if (process.env.TSC_STUB_MODULE_GRAPH === "1") {
	fs.writeFileSync(path.join(outDir, "index.js"), "export { built } from './helper.js';\n");
	fs.writeFileSync(path.join(outDir, "helper.js"), "export const built = true;\n");
} else if (process.env.TSC_STUB_EXTERNALS === "1") {
	fs.writeFileSync(path.join(outDir, "index.js"), "export { Agent } from '@cursor/sdk';\nexport { getModel } from '@earendil-works/pi-ai';\n");
} else if (process.env.TSC_STUB_MODULE_URL === "1") {
	fs.writeFileSync(path.join(outDir, "index.js"), "export const moduleUrl = import.meta.url;\n");
} else if (process.env.TSC_STUB_HOST_IDENTITY === "1") {
	fs.writeFileSync(path.join(outDir, "index.js"), "export { getAgentDir } from '@earendil-works/pi-coding-agent';\n");
} else {
	fs.writeFileSync(path.join(outDir, "index.js"), "export const built = true;\n");
}
