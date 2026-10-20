import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { installCursorSdkOutputFilter, withCursorSdkOutputNoticeHandler, suppressCursorSdkOutput } from "../src/cursor-sdk-output-filter.js";
import { installCursorSdkOutputFilter as installScriptFilter } from "../scripts/lib/cursor-sdk-output-filter.mjs";
import { prepareInstalledBootstrapEmitters } from "./helpers/cursor-sdk-bootstrap.js";
import { writeRawTestEvidence } from "./helpers/raw-test-evidence.mjs";
import { collectOutput } from "./helpers/process-output.js";

// Dependency execution owns signature drift/confinement; sink replay owns byte
// framing/restoration, not the timing of real Agent/backend emissions.
describe("Cursor SDK presentation boundary", () => {
	let installedBootstrapEmitters: Awaited<ReturnType<typeof prepareInstalledBootstrapEmitters>>;
	beforeAll(async () => { installedBootstrapEmitters = await prepareInstalledBootstrapEmitters(); }, 30_000);

	it.each([false, true])("frames installed printer/guard/completion/hook bytes with colors=%s", async (colors) => {
		const output = collectOutput();
		const root = mkdtempSync(join(tmpdir(), "cursor-output-contract-"));
		const home = join(root, "home");
		mkdirSync(join(home, ".cursor/plugins/local"), { recursive: true });
		mkdirSync(join(root, "outside-é"));
		symlinkSync(join(root, "outside-é"), join(home, ".cursor/plugins/local/outside"), process.platform === "win32" ? "junction" : "dir");
		let restore: (() => void) | undefined;
		try {
			const sdk = await installedBootstrapEmitters(colors); // bind before interception
			await sdk.inventory();
			expect(Array.from(await sdk.plugins(home))).toEqual([]);
			expect(sdk.readerCalls()).toBe(0);
			const inventory = Buffer.concat(output.stdout), plugin = Buffer.concat(output.stderr);
			expect(inventory.toString()).toMatch(/INFO.*managed_skills.startup_inventory/);
			expect(plugin.toString()).toContain("rejected: symlink target");
			expect(inventory.includes(Buffer.from("\x1b["))).toBe(colors);
			expect(sdk.hookNotices).toEqual([
				...["startup", "resume", "clear", "compact"].map(matcher => `[hooks] SessionStart trigger matcher "${matcher}" is not supported in Cursor, hooks will fire for all triggers`),
				...["manual", "auto"].map(matcher => `[hooks] PreCompact trigger matcher "${matcher}" is not supported in Cursor, hooks will fire for all triggers`),
				'[hooks] Tool "Glob" is not supported in Cursor and will be ignored',
			]);
			output.stdout.length = 0;
			for (const message of sdk.completions) sdk.completion(message);
			const completions = [...output.stdout];
			expect(completions).toHaveLength(3);
			for (let i = 0; i < completions.length; i++) expect(completions[i]!.toString()).toContain(sdk.completions[i]);
			const proof = process.env.PI_CURSOR_BOOTSTRAP_PROOF_DIR;
			if (proof) writeRawTestEvidence(proof, `sdk-capture-${colors ? "ansi" : "plain"}.json`, JSON.stringify({ inventory: inventory.toString(), plugin: plugin.toString(), parserWarning: sdk.parserWarning, completions: completions.map(bytes => bytes.toString()), hookNotices: sdk.hookNotices, readerCalls: sdk.readerCalls() }, null, 2));
			output.stdout.length = output.stderr.length = 0;
			restore = installCursorSdkOutputFilter();
			let callbacks = 0;
			for (const byte of inventory) {
				process.stdout.write(Buffer.from([byte]), () => callbacks++);
				process.stderr.write(Buffer.from([byte]), () => callbacks++);
			}
			process.stdout.write(Buffer.concat([Buffer.from("before\r\n"), inventory, Buffer.from("after🙂\n")]));
			process.stdout.write("\x1b[0mcursor:local · fast:off");
			for (const byte of inventory) process.stdout.write(Buffer.from([byte]));
			for (const bytes of [...completions, ...sdk.hookNotices.map(message => Buffer.from(message + "\r\n"))]) {
				for (const byte of bytes) process.stdout.write(Buffer.from([byte]));
				process.stderr.write(Buffer.concat([bytes, Buffer.from("VISIBLE adjacent\n")]));
			}
			await new Promise<void>(resolve => setImmediate(resolve));
			expect(callbacks).toBe(inventory.length * 2);
			expect(Buffer.concat(output.stderr).toString()).toBe("VISIBLE adjacent\n".repeat(10));
			expect(Buffer.concat(output.stdout)).toEqual(Buffer.from("before\r\nafter🙂\n\x1b[0mcursor:local · fast:off"));
			output.stderr.length = 0;
			for (const byte of plugin) process.stderr.write(Buffer.from([byte]));
			expect(Buffer.concat(output.stderr)).toEqual(plugin); // unowned diagnostic stays visible
			await sdk.inventory();
			await sdk.plugins(home);
			expect(sdk.readerCalls()).toBe(0);
			output.stderr.length = 0;
			const notices: string[] = [];
			await withCursorSdkOutputNoticeHandler((kind, message) => {
				notices.push(kind);
				expect(message.length).toBeLessThan(200);
				expect(message).not.toContain(root);
				expect(message).toMatch(kind === "outsidePlugin" ? /Install it inside that directory/ : /Check the native parser installation/);
			}, async () => { await sdk.plugins(home); process.stderr.write(sdk.parserWarning + "\r\n"); });
			expect(notices).toEqual(["outsidePlugin", "parserUnavailable"]);
			expect(output.stderr).toEqual([]);
			await withCursorSdkOutputNoticeHandler((_kind, message) => { console.warn(message); }, () => suppressCursorSdkOutput(() => sdk.plugins(home)));
			expect(Buffer.concat(output.stderr).toString()).toMatch(/^Cursor skipped a local plugin.*Install it inside that directory/);
			expect(Buffer.concat(output.stderr).toString()).not.toContain(root);
			output.stderr.length = 0;
			const boundWhileInstalled = await installedBootstrapEmitters(colors);
			restore(); restore = undefined;
			expect(Array.from(await boundWhileInstalled.plugins(home))).toEqual([]);
			expect(boundWhileInstalled.readerCalls()).toBe(0);
			expect(Buffer.concat(output.stderr)).toEqual(plugin);
			await sdk.inventory();
			expect(Buffer.concat(output.stdout).toString()).toContain("managed_skills.startup_inventory");
		} finally { restore?.(); output.restore(); rmSync(root, { recursive: true, force: true }); }
	});

	it("matches installed unsupported/unknown Claude event templates without enumerating future names", async () => {
		const sdk = await installedBootstrapEmitters(false);
		const names = ["InstructionsLoaded", "ConfigChange", "WorktreeCreate", "FutureClaudeEvent42"];
		const notices = sdk.claudeEventNotices(Object.fromEntries(
			["Notification", "PermissionRequest", ...names].map(name => [name, []]),
		));
		expect(notices).toEqual([
			...["Notification", "PermissionRequest"].map(name => `[hooks] Claude Code event "${name}" is not supported in Cursor and will be ignored`),
			...names.map(name => `[hooks] Unknown Claude Code event "${name}", skipping`),
		]);
		// Future additions to the SDK's unsupported-event table use the same family.
		const recognized = [...notices, '[hooks] Claude Code event "FutureUnsupportedEvent42" is not supported in Cursor and will be ignored'];
		const invalidValue = sdk.claudeEventNotices({ SessionStart: "invalid" });
		expect(invalidValue).toEqual(['[hooks] Claude Code event "SessionStart" has invalid value (expected array), skipping']);
		const visible = [...invalidValue,
			'[hooks] Unknown Claude Code event "Future" failed to load: permission denied',
			'[hooks] Claude Code event "Future" is not supported in Cursor and will be ignored: failure',
			'[hooks] Unknown Claude Code event "", skipping',
			'[hooks] Unknown Claude Code event "bad"quote", skipping',
			'[hooks] Refusing to load user config via symlink path: /unsafe',
		];
		const output = collectOutput(), restore = installCursorSdkOutputFilter();
		try {
			for (const message of [...recognized, ...visible]) {
				const frame = Buffer.from(`\x1b[33m${message}\x1b[0m\r\n`);
				for (let split = 0; split <= frame.length; split++) {
					process.stdout.write(frame.subarray(0, split));
					process.stdout.write(frame.subarray(split));
					process.stderr.write(frame.subarray(0, split));
					process.stderr.write(frame.subarray(split));
				}
				const expected = recognized.includes(message) ? Buffer.alloc(0) : Buffer.concat(Array.from({ length: frame.length + 1 }, () => frame));
				expect(Buffer.concat(output.stdout)).toEqual(expected);
				expect(Buffer.concat(output.stderr)).toEqual(expected);
				output.stdout.length = output.stderr.length = 0;
			}
		} finally { restore(); output.restore(); }
	});

	it("attributes split warnings to their initial owner and preserves warnings when native reporting fails", async () => {
		const output = collectOutput(), restore = installCursorSdkOutputFilter();
		try {
			const warning = "[local-plugins-bootstrap] loadUserLocalPlugin outside rejected: symlink target /outside is outside /root {}\n";
			const owners: string[] = [];
			withCursorSdkOutputNoticeHandler(() => { owners.push("first"); }, () => process.stderr.write(warning.slice(0, 20)));
			withCursorSdkOutputNoticeHandler(() => { owners.push("second"); }, () => process.stderr.write(warning.slice(20)));
			expect(owners).toEqual(["first"]);
			expect(output.stderr).toEqual([]);
			withCursorSdkOutputNoticeHandler(() => { throw new Error("native reporter failed"); }, () => process.stderr.write(warning));
			expect(Buffer.concat(output.stderr)).toEqual(Buffer.from(warning));
			let callbacks = 0;
			process.stdout.write('[hooks] Tool "Glob" is not supported in Cursor and will be ignored\n', () => callbacks++);
			process.stdout.write("18:05:", () => callbacks++);
			await new Promise<void>(resolve => setImmediate(resolve));
			expect(callbacks).toBe(2);
			restore();
			expect(Buffer.concat(output.stdout)).toEqual(Buffer.from("18:05:"));
		} finally { restore(); output.restore(); }
	});

	it("preserves synthetic failures/quoted controls, prompt bytes, invalid UTF-8, encodings and tails", () => {
		const output = collectOutput(true), restore = installCursorSdkOutputFilter();
		try {
			const controls = Buffer.from([
				'[local-plugins-bootstrap] loadUserLocalPlugin example failed: permission denied',
				'[local-plugins-bootstrap] Unexpected plugin exception: Error: denied',
				'[hooks] Refusing to load user config via symlink path: /unsafe',
				'[hooks] All tools in matcher "Glob" are unsupported, skipping hooks',
				'shell-parser: unexpected native parser exception',
				'Error initializing ignore mapping for /workspace: permission denied',
				'Ripgrep path not configured. Call configureRipgrepPath() at startup.',
				'"18:05:57.959 INFO  managed_skills.removed ctx=syncBuiltinSkills"',
				'prefix 18:05:57.959 INFO  managed_skills.removed ctx=syncBuiltinSkills',
				'18:05:57.959 WARN  managed_skills.removed ctx=syncBuiltinSkills',
				'99:99:99.999 INFO  managed_skills.removed ctx=syncBuiltinSkills',
				'18:05:57.959 INFO  managed_skills.startup_inventory_failed ctx=syncBuiltinSkills',
				'\x1b[?25l18:05:57.959 INFO  managed_skills.removed ctx=syncBuiltinSkills',
			].join("\n") + "\n");
			let done = 0;
			expect(process.stdout.write(controls, () => done++)).toBe(false);
			expect(done).toBe(1);
			const prompt = Buffer.from("\x1b[?25lPrompt: λ");
			expect(process.stdout.write(prompt)).toBe(false);
			process.stdout.write(Buffer.from([0xff, 0xc3, 0x28, 0x0a]));
			const invalidFrame = Buffer.concat([Buffer.from('18:05:57.959 INFO  managed_skills.removed meta={skill_id: "'), Buffer.from([0xff]), Buffer.from('"}\n')]);
			expect(process.stdout.write(invalidFrame)).toBe(false);
			process.stdout.write("é", "latin1");
			process.stderr.write("18:05:");
			expect(output.stderr).toEqual([]);
			restore();
			expect(Buffer.concat(output.stderr)).toEqual(Buffer.from("18:05:"));
			expect(Buffer.concat(output.stdout)).toEqual(Buffer.concat([controls, prompt, Buffer.from([0xff, 0xc3, 0x28, 0x0a]), invalidFrame, Buffer.from([0xe9])]));
		} finally { restore(); output.restore(); }
	});

	it("does not remove wrappers installed by another owner and deactivates retained filter methods", () => {
		const output = collectOutput(), restore = installCursorSdkOutputFilter();
		const filteredStdout = process.stdout.write, filteredStderr = process.stderr.write;
		const laterStdout: typeof process.stdout.write = function (...args) { return Reflect.apply(filteredStdout, process.stdout, args) as boolean; };
		const laterStderr: typeof process.stderr.write = function (...args) { return Reflect.apply(filteredStderr, process.stderr, args) as boolean; };
		process.stdout.write = laterStdout;
		process.stderr.write = laterStderr;
		try {
			process.stdout.write("18:05:");
			restore();
			expect(process.stdout.write).toBe(laterStdout);
			expect(process.stderr.write).toBe(laterStderr);
			const frame = '[hooks] Unknown Claude Code event "Future", skipping\n';
			process.stdout.write(frame);
			process.stderr.write(frame);
			expect(Buffer.concat(output.stdout).toString()).toBe("18:05:" + frame);
			expect(Buffer.concat(output.stderr).toString()).toBe(frame);
			const reinstall = installCursorSdkOutputFilter();
			process.stdout.write(frame);
			reinstall();
			expect(process.stdout.write).toBe(laterStdout);
			expect(Buffer.concat(output.stdout).toString()).toBe("18:05:" + frame);
		} finally { restore(); output.restore(); }
	});

	it("shares nesting/restoration with scripts, bounds candidates and keeps retained methods live", () => {
		const output = collectOutput();
		const stdoutWrite = process.stdout.write, consoleWarn = console.warn;
		const first = installCursorSdkOutputFilter(), filtered = process.stdout.write;
		const retainedWarn = console.warn.bind(console), second = installScriptFilter();
		try {
			first();
			expect(process.stdout.write).toBe(filtered);
			const oversized = "[local-plugins-bootstrap] loadUserLocalPlugin " + "x".repeat(32_768);
			process.stdout.write(oversized);
			expect(Buffer.concat(output.stdout)).toEqual(Buffer.from(oversized));
			second();
			expect(process.stdout.write).toBe(stdoutWrite);
			expect(console.warn).toBe(consoleWarn);
			retainedWarn("VISIBLE retained console");
			expect(Buffer.concat(output.stderr)).toEqual(Buffer.from("VISIBLE retained console\n"));
		} finally { first(); second(); output.restore(); }
	});
});
