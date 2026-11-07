import { createRequire, syncBuiltinESMExports } from "node:module";
import { basename, join } from "node:path";

const require = createRequire(import.meta.url);
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const timersPromises = require("node:timers/promises");
const originalRename = fsPromises.rename;
const originalRm = fsPromises.rm;
const realDelay = timersPromises.setTimeout;
let elapsedMs = 0;

// Advance the build's native retry clock without waiting on wall time.
if (["late-winner", "race-loss", "rename-always", "rename-into-dist-always", "dist-locked", "serialized-publication"].includes(process.env.BUILD_SWAP_FAULT)) {
	timersPromises.setTimeout = async (ms) => { elapsedMs += ms; };
}

// Cross-process barriers order real builds that share one cwd. The wall-clock
// limit only turns a hang into a failure inside the test's own timeout.
const barrier = (name) => join(process.env.BUILD_SWAP_BARRIER_DIR ?? "", name);
const signal = (name) => fs.writeFileSync(barrier(name), "");
async function reached(name) {
	const deadline = Date.now() + 20_000;
	while (!fs.existsSync(barrier(name))) {
		if (Date.now() > deadline) throw new Error(`build-swap barrier not reached: ${name}`);
		await realDelay(5);
	}
}
const pause = new Int32Array(new SharedArrayBuffer(4));
function reachedSync(name) {
	const deadline = Date.now() + 20_000;
	while (!fs.existsSync(barrier(name))) {
		if (Date.now() > deadline) throw new Error(`build-swap barrier not reached: ${name}`);
		Atomics.wait(pause, 0, 0, 5);
	}
}

// The publication lock stays real: wrapping node:sqlite's exec only runs a step just before a
// build waits for the lock and another once it holds it (synchronously, like the lock call).
function aroundLockWait(beforeWait, onAcquired = () => {}) {
	const { DatabaseSync } = require("node:sqlite");
	const exec = DatabaseSync.prototype.exec;
	DatabaseSync.prototype.exec = function (sql) {
		if (!/^BEGIN/i.test(sql)) return exec.call(this, sql);
		beforeWait();
		const result = exec.call(this, sql);
		onAcquired();
		return result;
	};
}

const publishing = (from) => from === `dist.staging.${process.pid}`;
const intoDist = (_from, to) => to === "dist";
const fromDist = (from) => from === "dist";
const permanentFailure = async () => {
	throw new Error(`synthetic permanent rename failure after ${elapsedMs}ms`);
};

// A fault replaces only the renames of its targeted publication phase; the
// rest of the transaction runs against the real filesystem.
function patchRename(inPhase, fault) {
	fsPromises.rename = async (...args) => {
		const [from, to] = args.map((path) => basename(String(path)));
		return inPhase(from, to) ? fault(...args) : originalRename(...args);
	};
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
		patchRename(publishing, async (...args) => {
			if (elapsedMs < 2_200) throw new Error("synthetic late-winner race");
			fs.writeFileSync(join(args[0], "late-winner.txt"), String(elapsedMs));
			return originalRename(...args);
		});
	},
	"race-loss"() {
		patchRename(publishing, async () => {
			const cwd = process.cwd();
			const dist = join(cwd, "dist");
			fs.mkdirSync(dist, { recursive: true });
			fs.writeFileSync(join(dist, "winner.txt"), "published");
			// Same optional asset-list interface as pi-mcp-adapter's separate fixture copy.
			// Its __tests__/packaging/build-script-swap.test.ts supplies assets; this package does not.
			for (const asset of (process.env.BUILD_SWAP_RUNTIME_ASSETS ?? "").split(",").filter(Boolean)) {
				fs.copyFileSync(join(cwd, asset), join(dist, asset));
			}
			throw new Error("synthetic race loss");
		});
	},
	"rename-always"() {
		patchRename(publishing, permanentFailure);
	},
	"rename-into-dist-always"() {
		patchRename(intoDist, permanentFailure);
	},
	"dist-locked"() {
		patchRename(fromDist, async () => {
			throw new Error(`synthetic dist lock after ${elapsedMs}ms`);
		});
	},
	// Three real builds share one checkout. The holder takes the publication lock, moves dist/
	// aside and fails its publication only once both other builds wait for the lock. The healthy
	// build then publishes; the failing build moves that output aside and fails afterwards.
	"serialized-publication"() {
		const role = process.env.BUILD_SWAP_ROLE;
		if (role === "holder") {
			fsPromises.rename = async (...args) => {
				const [from] = args.map((path) => basename(String(path)));
				if (publishing(from)) {
					await reached("healthy-waiting");
					await reached("failing-waiting");
					return permanentFailure();
				}
				await originalRename(...args);
				if (fromDist(from)) signal("holder-moved-dist");
			};
			return;
		}
		if (role === "healthy") {
			aroundLockWait(
				() => {
					reachedSync("holder-moved-dist");
					signal("healthy-waiting");
				},
				() => signal("healthy-locked"),
			);
			return;
		}
		aroundLockWait(() => {
			reachedSync("holder-moved-dist");
			signal("failing-waiting");
			reachedSync("healthy-locked");
		});
		patchRename(publishing, permanentFailure);
	},
	// The victim takes the publication lock, moves dist/ aside and then holds the lock until
	// the test kills it.
	"hold-publication"() {
		patchRename(publishing, async () => {
			signal("victim-holding");
			await realDelay(60_000);
			throw new Error("hold-publication victim was not killed");
		});
	},
	"vanish-staging"() {
		patchRename(publishing, async (...args) => {
			await originalRm(args[0], { force: true, recursive: true });
			return originalRename(...args);
		});
	},
	"empty-dist"() {
		let firstRename = true;
		patchRename(publishing, async (...args) => {
			const dist = join(process.cwd(), "dist");
			if (firstRename) {
				firstRename = false;
				fs.mkdirSync(dist, { recursive: true });
				throw new Error("synthetic empty dist");
			}
			fs.rmSync(dist, { recursive: true, force: true });
			return originalRename(...args);
		});
	},
};

const faultName = process.env.BUILD_SWAP_FAULT;
if (faultName && !Object.hasOwn(faults, faultName)) throw new Error(`unknown build-swap fault: ${faultName}`);
faults[faultName]?.();
syncBuiltinESMExports();
