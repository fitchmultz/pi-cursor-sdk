/**
 * Platform smoke doctor — preflight checks before any Cursor token spend.
 *
 * Implements doctor checks from docs/platform-smoke.md:
 * env vars, Crabbox, providers, Docker, SSH, Node, tools,
 * artifacts, git status, forbidden files, Cursor auth, node-pty.
 */

import { execSync, execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, writeFileSync, unlinkSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ensureUbuntuContainerImage } from "./crabbox-runner.mjs";
import { renderAll } from "./render-ansi.mjs";

let failures = 0;

function ok(label) { console.log(`  \u2713 ${label}`); }
function warn(label) { console.log(`  \u26a0 ${label}`); }
function fail(label) { console.error(`  \u2717 ${label}`); failures++; }
function env(name) { return process.env[name] ?? ""; }

function versionAtLeast(actual, minimum) {
	const actualParts = String(actual ?? "").split(".").map((part) => Number.parseInt(part, 10));
	const minimumParts = String(minimum ?? "").split(".").map((part) => Number.parseInt(part, 10));
	for (let index = 0; index < Math.max(actualParts.length, minimumParts.length); index++) {
		const actualPart = Number.isFinite(actualParts[index]) ? actualParts[index] : 0;
		const minimumPart = Number.isFinite(minimumParts[index]) ? minimumParts[index] : 0;
		if (actualPart > minimumPart) return true;
		if (actualPart < minimumPart) return false;
	}
	return true;
}

function safeChildEnv(extra = {}) {
	const childEnv = { ...process.env, ...extra };
	delete childEnv.CURSOR_API_KEY;
	return childEnv;
}

function silent(cmd, args, opts = {}) {
	try { return execFileSync(cmd, args, { timeout: 15_000, stdio: "pipe", ...opts, env: safeChildEnv(opts.env) }).toString().trim(); }
	catch { return null; }
}

function shell(cmd, opts = {}) {
	try { return execSync(cmd, { timeout: 15_000, stdio: "pipe", ...opts, env: safeChildEnv(opts.env) }).toString().trim(); }
	catch { return null; }
}

function commandPath(command) {
	return shell(`command -v ${command}`);
}



async function runRenderProbe(artifactRoot) {
	const probeDir = resolve(artifactRoot, `.doctor-render-${process.pid}-${Date.now()}`);
	try {
		mkdirSync(probeDir, { recursive: true });
		const ansiPath = resolve(probeDir, "terminal.ansi");
		writeFileSync(ansiPath, "\u001b[32mplatform smoke render probe\u001b[0m\n");
		const rendered = await renderAll(ansiPath, probeDir, {
			label: "doctor-render-probe",
			model: "doctor",
			mode: "doctor",
			cwd: process.cwd(),
			sessionId: "doctor-render-probe",
			width: 80,
			height: 10,
			historyLines: 100,
		});
		const pngPath = resolve(probeDir, "terminal.full.png");
		const pngOk = rendered.pngOk && existsSync(pngPath) && statSync(pngPath).size > 100;
		if (!pngOk) {
			return {
				ok: false,
				message: `host-side xterm/Playwright render probe did not produce a PNG at ${pngPath}. Run: npx playwright install chromium`,
			};
		}
		return { ok: true, message: pngPath };
	} catch (error) {
		return {
			ok: false,
			message: `host-side xterm/Playwright render probe failed: ${error instanceof Error ? error.message : String(error)}. Run npm install, then: npx playwright install chromium`,
		};
	} finally {
		rmSync(probeDir, { recursive: true, force: true });
	}
}

function findGitRoot(startPath) {
	let dir = startPath;
	for (let i = 0; i < 8; i++) {
		if (existsSync(resolve(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
	return null;
}

async function runChecks(config) {
	// ── Phase 1: environment variables ──
	console.log("\n── Environment variables ──");
	const requiredVars = [
		"CURSOR_API_KEY",
	];
	const optionalVars = [
		"PLATFORM_SMOKE_CRABBOX",
		"PLATFORM_SMOKE_MAC_HOST",
		"PLATFORM_SMOKE_MAC_USER",
		"PLATFORM_SMOKE_MAC_WORK_ROOT",
		"PLATFORM_SMOKE_UBUNTU_IMAGE",
	];
	for (const name of requiredVars) {
		const v = env(name);
		v ? ok(`${name} = ${name === "CURSOR_API_KEY" ? "(present, redacted)" : (v.length > 50 ? v.slice(0, 50) + "..." : v)}`)
			: fail(`${name} missing`);
	}
	for (const name of optionalVars) {
		const v = env(name);
		ok(`${name} = ${v || "(default)"}`);
	}

	// ── Phase 2: Crabbox binary ──
	console.log("\n── Crabbox binary ──");
	const cbox = env("PLATFORM_SMOKE_CRABBOX") || "crabbox";
	const cboxPath = env("PLATFORM_SMOKE_CRABBOX") || commandPath("crabbox");
	if (!cboxPath) {
		fail(`crabbox not found on PATH; install with ${config.requiredCrabbox?.install ?? "Homebrew"} or set PLATFORM_SMOKE_CRABBOX`);
	} else {
		if (env("PLATFORM_SMOKE_CRABBOX")) {
			try { accessSync(cboxPath, constants.X_OK); ok(`binary: ${cboxPath} (env override)`); }
			catch { fail(`${cboxPath} not executable`); }
		} else {
			ok(`binary: ${cboxPath} (PATH)`);
		}
		const ver = silent(cbox, ["--version"]);
		const actualVersion = ver?.split("\n")[0]?.trim();
		if (actualVersion) ok(`version: ${actualVersion}`);
		const requiredVersion = config.requiredCrabbox?.version;
		const minimumVersion = config.requiredCrabbox?.minVersion;
		if (requiredVersion) {
			if (!actualVersion) fail(`could not verify Crabbox version for ${cbox}`);
			else if (actualVersion !== requiredVersion) fail(`Crabbox version mismatch: expected ${requiredVersion}, got ${actualVersion}`);
			else ok(`required version: ${actualVersion}`);
		}
		if (!requiredVersion && minimumVersion) {
			if (!actualVersion) fail(`could not verify Crabbox version for ${cbox}`);
			else if (!versionAtLeast(actualVersion, minimumVersion)) fail(`Crabbox version ${actualVersion} is below required minimum ${minimumVersion}`);
			else ok(`minimum version: ${actualVersion} >= ${minimumVersion}`);
		}
		const requiredCommit = config.requiredCrabbox?.commit;
		if (!requiredVersion && !minimumVersion && requiredCommit) {
			const gitRoot = findGitRoot(dirname(cboxPath));
			const actualCommit = gitRoot ? silent("git", ["-C", gitRoot, "rev-parse", "HEAD"]) : null;
			if (!actualCommit) fail(`could not verify Crabbox source commit for ${cboxPath}`);
			else if (actualCommit !== requiredCommit) fail(`Crabbox commit mismatch: expected ${requiredCommit}, got ${actualCommit}`);
			else ok(`commit: ${actualCommit}`);
		}
	}

	// ── Phase 3: Crabbox providers ──
	console.log("\n── Crabbox providers ──");
	if (cboxPath) {
		const providerList = silent(cbox, ["providers"]);
		if (providerList) {
			for (const provider of ["ssh", "local-container"]) {
				new RegExp(`^${provider}$`, "m").test(providerList)
					? ok(`provider listed: ${provider}`)
					: fail(`crabbox providers missing required provider: ${provider}`);
			}
		} else {
			fail("crabbox providers failed");
		}
		let ubuntuImage;
		try {
			ubuntuImage = ensureUbuntuContainerImage(config);
			ok(`Ubuntu container image ready: ${ubuntuImage}`);
		} catch (error) {
			fail(`could not prepare Ubuntu container image: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (ubuntuImage) {
			const lcDoc = silent(cbox, ["doctor", "--provider", "local-container", "--target", "linux", "--local-container-image", ubuntuImage, "--json"]);
			if (lcDoc) {
				try {
					const d = JSON.parse(lcDoc);
					d.ok ? ok("local-container provider OK") : fail(`local-container: ${d.error ?? "not ok"}`);
				} catch {
					fail("could not parse crabbox doctor --json for local-container");
				}
			} else {
				fail("crabbox doctor --provider local-container --json failed");
			}
		}
		const sshHost = env("PLATFORM_SMOKE_MAC_HOST") || "localhost";
		const sshUser = env("PLATFORM_SMOKE_MAC_USER") || env("USER");
		const sshRoot = env("PLATFORM_SMOKE_MAC_WORK_ROOT") || `/Users/${env("USER")}/crabbox/pi-cursor-sdk`;
		const sshDoc = silent(cbox, [
			"doctor", "--provider", "ssh", "--target", "macos",
			"--static-host", sshHost, "--static-user", sshUser,
			"--static-port", "22", "--static-work-root", sshRoot,
			"--doctor-probe-ssh", "--json",
		]);
		if (sshDoc) {
			try {
				const d = JSON.parse(sshDoc);
				d.ok ? ok("ssh (static) provider OK") : fail(`ssh doctor: ${d.checks?.find(c => c.status !== "ok")?.check ?? "some checks not ok"}`);
			} catch {
				fail("could not parse crabbox ssh doctor JSON");
			}
		} else {
			fail("crabbox doctor --provider ssh --target macos --json failed");
		}
	}

	// ── Phase 4: Docker ──
	console.log("\n── Docker ──");
	const dockerVer = shell("docker info --format '{{.ServerVersion}}'");
	dockerVer ? ok(`Docker ${dockerVer}`) : fail("Docker not running or not available");

	// ── Phase 5: macOS SSH ──
	console.log("\n── macOS SSH ──");
	const host = env("PLATFORM_SMOKE_MAC_HOST") || "localhost";
	const user = env("PLATFORM_SMOKE_MAC_USER") || env("USER");
	const sshOut = shell(`ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=no ${user}@${host} 'whoami && node --version && npm --version && git --version && rsync --version | head -1 && tar --version | head -1'`);
	if (sshOut) {
		const lines = sshOut.trim().split("\n");
		ok(`SSH to ${host}: ${lines[0]}`);
		if (lines[1]) ok(`remote Node ${lines[1]}`); else fail("remote node probe missing output");
		if (lines[2]) ok(`remote npm ${lines[2]}`); else fail("remote npm probe missing output");
		if (lines[3]) ok(`remote ${lines[3]}`); else fail("remote git probe missing output");
		if (lines[4]) ok(`remote ${lines[4]}`); else fail("remote rsync probe missing output");
		if (lines[5]) ok(`remote ${lines[5]}`); else fail("remote tar probe missing output");
	} else {
		fail(`SSH to ${host} failed`);
	}

	// ── Phase 7: Node.js ──
	console.log("\n── Node.js ──");
	const nv = shell("node --version");
	if (nv) {
		const major = parseInt(nv.replace("v", "").split(".")[0], 10);
		major >= (config?.nodeValidationMajor ?? 24)
			? ok(`Node ${nv} (>= ${config?.nodeValidationMajor ?? 24})`)
			: fail(`Node ${nv} — need ${config?.nodeValidationMajor ?? 24}+`);
	} else {
		fail("node not found");
	}

	// ── Phase 8: Tools ──
	console.log("\n── Tools ──");
	for (const [name, command] of [
		["npm", "npm --version"],
		["git", "git --version"],
		["rsync", "rsync --version"],
		["tar", "tar --version"],
		...(process.platform === "win32" ? [] : [["C compiler", "cc --version"]]),
	]) {
		const out = shell(command);
		out ? ok(`${name}: ${out.split("\n")[0]}`) : fail(`${name} not found`);
	}

	// ── Phase 9: Artifact root ──
	console.log("\n── Artifact root ──");
	const artRoot = resolve(process.cwd(), config?.artifactRoot ?? ".artifacts/platform-smoke");
	try {
		mkdirSync(artRoot, { recursive: true });
		const tf = resolve(artRoot, ".doctor-write-test");
		writeFileSync(tf, "doctor-test");
		unlinkSync(tf);
		ok(`writable: ${artRoot}`);
	} catch (e) {
		fail(`cannot write to ${artRoot}: ${e.message}`);
	}

	// ── Phase 10: Host-side visual render probe ──
	console.log("\n── Host-side visual render probe ──");
	const renderProbe = await runRenderProbe(artRoot);
	if (renderProbe.ok) {
		ok("xterm/Playwright Chromium render probe wrote a PNG");
	} else {
		fail(renderProbe.message);
	}

	// ── Phase 11: Git status ──
	console.log("\n── Git status ──");
	const branch = shell("git branch --show-current");
	branch ? ok(`branch: ${branch}`) : warn("could not determine branch");
	const st = shell("git status --short");
	if (st) {
		const changed = st.trim().split("\n").length;
		warn(`${changed} uncommitted change(s)`);
	} else {
		ok("clean worktree");
	}

	// ── Phase 12: Forbidden files ──
	console.log("\n── Forbidden files ──");
	let anyForbidden = false;
	for (const pat of [".env", "*.tgz"]) {
		const found = shell(`find . -maxdepth 2 -name "${pat}" 2>/dev/null`);
		if (found) {
			fail(`found: ${found.trim()}`);
			anyForbidden = true;
		}
	}
	if (!anyForbidden) ok("no .env, .tgz");

	// Check for tracked .env.*
	for (const f of [".env.production", ".env.local"]) {
		if (existsSync(resolve(process.cwd(), f))) {
			fail(`tracked forbidden: ${f}`);
		}
	}
	ok("no tracked .env.*");

	// ── Phase 13: Cursor auth ──
	console.log("\n── Cursor auth ──");
	const key = env("CURSOR_API_KEY");
	if (key && key.length > 10) {
		ok(`CURSOR_API_KEY present (${key.length} chars, redacted)`);
	} else if (key) {
		fail("CURSOR_API_KEY too short (likely invalid)");
	} else {
		fail("CURSOR_API_KEY missing — live Cursor suites will not run");
	}

	// ── Phase 14: node-pty self-test ──
	console.log("\n── node-pty self-test ──");
	const ptyPath = resolve(process.cwd(), "node_modules", "node-pty");
	if (existsSync(ptyPath)) {
		try {
			// node-pty can hang with mismatched Node ABI; use timeout
			const ptyResult = shell("node -e \"try { require('node-pty'); console.log('node-pty ok') } catch(e) { console.error(e.message); process.exit(1) }\"", { timeout: 15_000 });
			if (ptyResult && ptyResult.includes("node-pty ok")) {
				ok("node-pty loads successfully");
			} else {
				fail(`node-pty not functional: ${ptyResult?.slice(0, 200) || 'null'}. This blocks live PTY suites but not platform-build.`);
			}
		} catch (e) {
			fail(`node-pty self-test error: ${e.message}. This blocks live PTY suites but not platform-build.`);
		}
	} else {
		warn("node-pty not installed — live PTY suites will not run. Run: npm ci");
	}

	// ── Phase 15: Summary ──
	console.log(`\n=== Results: ${failures} failure(s) ===`);
	if (failures > 0) {
		console.log("Fix failures above before running live Cursor suites.");
		console.log("Use `npm run smoke:platform:doctor` to re-validate.");
		process.exitCode = 1;
	} else {
		console.log("All checks passed. Ready for platform smoke.");
	}
}

export async function runDoctor(config) {
	await runChecks(config);
}
