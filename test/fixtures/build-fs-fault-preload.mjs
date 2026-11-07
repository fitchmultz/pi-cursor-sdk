import { createRequire, syncBuiltinESMExports } from "node:module";
import { basename, join } from "node:path";

const require = createRequire(import.meta.url);
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const timersPromises = require("node:timers/promises");
const originalRename = fsPromises.rename;
const originalRm = fsPromises.rm;
let elapsedMs = 0;

// Advance the build's native retry clock without waiting on wall time.
if (["late-winner", "rename-always"].includes(process.env.BUILD_SWAP_FAULT)) {
	timersPromises.setTimeout = async (ms) => { elapsedMs += ms; };
}

const faults = {
	"stale-rm"() {
		fsPromises.rm = async (path, options) => {
			if (basename(String(path)) === process.env.LOCKED_STAGING_NAME) {
				throw new Error("synthetic stale-staging lock");
			}
			return originalRm(path, options);
		};
	},
	"late-winner"() {
		fsPromises.rename = async (...args) => {
			if (elapsedMs < 2_200) throw new Error("synthetic late-winner race");
			fs.writeFileSync(join(args[0], "late-winner.txt"), String(elapsedMs));
			return originalRename(...args);
		};
	},
	"race-loss"() {
		fsPromises.rename = async () => {
			const cwd = process.cwd();
			const dist = join(cwd, "dist");
			fs.mkdirSync(dist, { recursive: true });
			fs.writeFileSync(join(dist, "winner.txt"), "published");
			fs.writeFileSync(join(dist, "index.js"), "winner");
			// Shared fixture: only pi-mcp-adapter supplies dist-relative runtime assets.
			for (const asset of (process.env.BUILD_SWAP_RUNTIME_ASSETS ?? "").split(",").filter(Boolean)) {
				fs.copyFileSync(join(cwd, asset), join(dist, asset));
			}
			throw new Error("synthetic race loss");
		};
	},
	"rename-always"() {
		fsPromises.rename = async () => {
			throw new Error(`synthetic permanent rename failure after ${elapsedMs}ms`);
		};
	},
	"vanish-staging"() {
		fsPromises.rename = async (...args) => {
			await originalRm(args[0], { force: true, recursive: true });
			return originalRename(...args);
		};
	},
	"empty-dist"() {
		let firstRename = true;
		fsPromises.rename = async (...args) => {
			const dist = join(process.cwd(), "dist");
			if (firstRename) {
				firstRename = false;
				fs.mkdirSync(dist, { recursive: true });
				throw new Error("synthetic empty dist");
			}
			fs.rmSync(dist, { recursive: true, force: true });
			return originalRename(...args);
		};
	},
};

const faultName = process.env.BUILD_SWAP_FAULT;
if (faultName && !Object.hasOwn(faults, faultName)) throw new Error(`unknown build-swap fault: ${faultName}`);
faults[faultName]?.();
syncBuiltinESMExports();
