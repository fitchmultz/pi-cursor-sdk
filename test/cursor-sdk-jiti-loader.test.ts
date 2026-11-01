import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "@typescript/typescript6";
import { afterEach, expect, it } from "vitest";

const sourceDir = fileURLToPath(new URL("../src/", import.meta.url));
const hostRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const jitiPackage = hostRequire.resolve("jiti/package.json");
const jitiManifest = JSON.parse(readFileSync(jitiPackage, "utf8")) as { exports: { "./static": { import: string } } };
const jitiStaticUrl = pathToFileURL(join(dirname(jitiPackage), jitiManifest.exports["./static"].import)).href;
let fixtureDir: string | undefined;

afterEach(() => {
	if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
	fixtureDir = undefined;
});

function fixture(): string {
	const dir = fixtureDir = mkdtempSync(join(tmpdir(), "cursor-jiti-contract-"));
	mkdirSync(join(dir, "node_modules", "@cursor", "sdk"), { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
	writeFileSync(join(dir, "node_modules", "@cursor", "sdk", "package.json"), JSON.stringify({
		name: "@cursor/sdk", type: "module", exports: { ".": { bun: "./index.js", import: "./index.js", default: "./index.js" } },
	}));
	// Emit the actual runtime and its side-effect dependencies without requiring a
	// pre-existing dist. jiti/static below is the installed host dependency.
	for (const name of ["cursor-sdk-runtime", "cursor-sdk-vendor-env", "cursor-ripgrep-path"]) {
		const source = readFileSync(join(sourceDir, `${name}.ts`), "utf8");
		const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2024 } }).outputText;
		writeFileSync(join(dir, `${name}.js`), js);
	}
	const runtime = readFileSync(join(dir, "cursor-sdk-runtime.js"), "utf8");
	const hostPeer = 'import "@earendil-works/pi-coding-agent";';
	expect(runtime).toContain(hostPeer);
	const noPeer = runtime.replace(hostPeer, "");
	writeFileSync(join(dir, "cursor-sdk-runtime-no-peer.js"), noPeer);
	// Independently exercise the bare-import guard for the positive basename.
	mkdirSync(join(dir, "native-control"));
	writeFileSync(join(dir, "native-control", "cursor-sdk-runtime.js"), noPeer.replace(
		'import "./cursor-sdk-vendor-env.js";', 'import "../cursor-sdk-vendor-env.js";',
	));
	writeFileSync(join(dir, "node_modules", "@cursor", "sdk", "index.js"), `
		globalThis.sdkEvaluations = (globalThis.sdkEvaluations ?? 0) + 1;
		export class Agent { static create() {} static resume() {} static archive() {} static delete() {} static getUsage() {} static messages = { list() {} }; }
		export class Cursor { static configure() {} static models = { list() {} }; }
		export function createAgentPlatform() {}
		export function getDefaultSdkStateRoot() {}
		if (globalThis.failSdk) throw new Error("synthetic private diagnostic");
		globalThis.sdkCompleted = true;
	`);
	// This is a loader simulation, not a compiled Bun test: Node hooks model
	// Bun's unavailable native host peer and its bare SDK specifier failure.
	writeFileSync(join(dir, "probe.mjs"), `
		import "@earendil-works/pi-coding-agent";
		import { loadCursorSdk } from "./cursor-sdk-runtime.js";
		export async function probe(fail) {
			globalThis.failSdk = fail;
			const before = globalThis.sdkEvaluations ?? 0;
			const first = loadCursorSdk();
			const concurrent = loadCursorSdk();
			if (!fail) {
				const sdk = await first;
				return { before, sameConcurrent: first === concurrent, sameLater: first === loadCursorSdk(),
					evaluations: globalThis.sdkEvaluations,
					exportsReady: [sdk.Agent, sdk.Cursor, sdk.createAgentPlatform, sdk.getDefaultSdkStateRoot].every(x => typeof x === "function") };
			}
			const firstOutcome = await first.then(() => ({ rejected: false }), error => ({ rejected: true, error }));
			const evaluationsAfterFailure = globalThis.sdkEvaluations;
			globalThis.failSdk = false;
			const retry = loadCursorSdk();
			const retryOutcome = await retry.then(() => ({ rejected: false }), error => ({ rejected: true, error }));
			const evaluationsAfterRetry = globalThis.sdkEvaluations;
			// Characterize the host, but do not require its cache bug: another jiti
			// version may reject or successfully re-evaluate this direct import.
			let direct;
			try {
				const sdk = await import("@cursor/sdk");
				direct = { state: globalThis.sdkCompleted === true ? "complete" : "partial",
					exportsReady: [sdk.Agent, sdk.Cursor, sdk.createAgentPlatform, sdk.getDefaultSdkStateRoot].every(x => typeof x === "function") };
			} catch { direct = { state: "rejected" }; }
			return { before, firstRejected: firstOutcome.rejected, retryRejected: retryOutcome.rejected,
				sameConcurrent: first === concurrent, sameRetry: first === retry,
				sameError: firstOutcome.rejected && retryOutcome.rejected && Object.is(firstOutcome.error, retryOutcome.error),
				evaluationsAfterFailure, evaluationsAfterRetry, direct };
		}
	`);
	writeFileSync(join(dir, "runner.mjs"), `
		import { registerHooks } from "node:module";
		import { createJiti } from ${JSON.stringify(jitiStaticUrl)};
		const hook = registerHooks({ resolve(specifier, context, next) {
			const parent = context.parentURL ?? "";
			if (specifier === "@earendil-works/pi-coding-agent" && /(?:probe|cursor-sdk-runtime)\\.(?:mjs|js)$/.test(parent)) {
				throw Object.assign(new Error("simulated embedded peer resolution"), { code: "ERR_MODULE_NOT_FOUND" });
			}
			if (specifier === "@cursor/sdk" && /\\/cursor-sdk-runtime(?:-no-peer)?\\.js$/.test(parent)) {
				throw Object.assign(new Error("simulated embedded bare import failure"), { code: "ERR_MODULE_NOT_FOUND" });
			}
			return next(specifier, context);
		}});
		try {
			const options = { moduleCache: false, tryNative: false, fsCache: false, virtualModules: { "@earendil-works/pi-coding-agent": {} } };
			const jiti = createJiti(import.meta.url, options);
			const { probe } = await jiti.import("./probe.mjs");
			const result = await probe(process.argv[2] === "failure");
			if (process.argv[2] === "success") {
				const control = createJiti(import.meta.url, options);
				const { loadCursorSdk } = await control.import("./cursor-sdk-runtime-no-peer.js");
				const denied = e => e.code === "ERR_MODULE_NOT_FOUND" && e.message === "simulated embedded bare import failure";
				result.noPeerRejected = await loadCursorSdk().then(() => false, denied);
				const native = await import("./native-control/cursor-sdk-runtime.js");
				result.nativeBareRejected = await native.loadCursorSdk().then(() => false, denied);
			}
			console.log(JSON.stringify(result));
		} finally { hook.deregister(); }
	`);
	return dir;
}

function run(mode: "success" | "failure") {
	const dir = fixture();
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH ?? "", HOME: dir, USERPROFILE: dir, TEMP: dir, TMP: dir, TMPDIR: dir,
		JITI_DEBUG: "0", JITI_FS_CACHE: "false", JITI_MODULE_CACHE: "false",
	};
	for (const name of ["SYSTEMROOT", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"]) {
		if (process.env[name] !== undefined) env[name] = process.env[name];
	}
	const stdout = execFileSync(process.execPath, [join(dir, "runner.mjs"), mode], {
		cwd: dir, encoding: "utf8", timeout: 30_000, env,
	});
	return JSON.parse(stdout) as Record<string, unknown>;
}

it("loads the emitted lazy runtime through installed jiti/static; a missing host-peer control fails", () => {
	expect(run("success")).toEqual({ before: 0, sameConcurrent: true, sameLater: true, evaluations: 1, exportsReady: true, noPeerRejected: true, nativeBareRejected: true });
});

it("retains the first jiti rejection without retrying, regardless of the host cache behavior", () => {
	const result = run("failure");
	expect(result).toMatchObject({ before: 0, firstRejected: true, retryRejected: true, sameConcurrent: true, sameRetry: true, sameError: true });
	expect(result.evaluationsAfterFailure).toBeGreaterThan(0);
	expect(result.evaluationsAfterRetry).toBe(result.evaluationsAfterFailure);
	const direct = result.direct as { state: string; exportsReady?: boolean };
	expect(["partial", "complete", "rejected"]).toContain(direct.state);
	if (direct.state === "complete") expect(direct.exportsReady).toBe(true);
});
