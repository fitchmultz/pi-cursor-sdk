import { describe, expect, it } from "vitest";
import { installCursorSdkOutputFilter, isCursorSdkStartupNoise } from "../src/cursor-sdk-output-filter.js";
import { installCursorSdkOutputFilter as installScriptCursorSdkOutputFilter } from "../scripts/lib/cursor-sdk-output-filter.mjs";
import { readInstalledPackageDistText } from "./helpers/installed-package.js";

const sdkSource = readInstalledPackageDistText("@cursor/sdk");

describe("isCursorSdkStartupNoise", () => {
	it("filters [hooks] noise like provider integration tests", () => {
		const message = '[hooks] SessionStart trigger matcher "startup" is not supported in Cursor, hooks will fire for all triggers';
		expect(sdkSource).toContain("[hooks] ${");
		expect(sdkSource).toContain('"SessionStart"');
		expect(sdkSource).toContain('"startup"');
		expect(sdkSource).toContain(' trigger matcher "');
		expect(sdkSource).toContain(" is not supported in Cursor, hooks will fire for all triggers");
		expect(isCursorSdkStartupNoise(message)).toBe(true);
		expect(isCursorSdkStartupNoise(`prefix ${message} suffix`)).toBe(true);
	});

	it.each([
		"managed_skills.startup_inventory",
		"CursorPluginsAgentSkillsService load completed",
		"LocalCursorRulesService load completed",
		"AgentSkillsCursorRulesService load completed",
	])("filters SDK startup message %j", (message) => {
		expect(sdkSource).toContain(message);
		expect(isCursorSdkStartupNoise(message)).toBe(true);
		// Synthetic surrounding text exercises containment, not a captured SDK log line.
		expect(isCursorSdkStartupNoise(`prefix ${message} suffix`)).toBe(true);
	});

	it("filters ignore-mapping initialization errors", () => {
		const message = "Error initializing ignore mapping for .gitignore:";
		expect(sdkSource).toMatch(/Error initializing ignore mapping for \$\{[^}]+\}:/);
		expect(isCursorSdkStartupNoise(message)).toBe(true);
		expect(isCursorSdkStartupNoise(`prefix ${message} suffix`)).toBe(true);
	});

	it("filters the known ripgrep path configuration message", () => {
		const message = "Ripgrep path not configured. Call configureRipgrepPath() at startup.";
		expect(sdkSource).toContain(message);
		expect(isCursorSdkStartupNoise(message)).toBe(true);
		expect(isCursorSdkStartupNoise(`prefix ${message} suffix`)).toBe(true);
	});

	it("does not filter unrelated provider output", () => {
		expect(isCursorSdkStartupNoise("VISIBLE non-startup stdout")).toBe(false);
		expect(isCursorSdkStartupNoise("Agent finished successfully")).toBe(false);
	});

	it("keeps the global filter installed until all overlapping installs are restored", () => {
		const originalStdoutWrite = process.stdout.write;
		const originalStderrWrite = process.stderr.write;
		const originalConsoleLog = console.log;
		const restoreFirst = installCursorSdkOutputFilter();
		const filteredStdoutWrite = process.stdout.write;
		const filteredStderrWrite = process.stderr.write;
		const filteredConsoleLog = console.log;
		const restoreSecond = installCursorSdkOutputFilter();
		try {
			expect(process.stdout.write).toBe(filteredStdoutWrite);
			expect(process.stderr.write).toBe(filteredStderrWrite);
			expect(console.log).toBe(filteredConsoleLog);

			restoreFirst();
			expect(process.stdout.write).toBe(filteredStdoutWrite);
			expect(process.stderr.write).toBe(filteredStderrWrite);
			expect(console.log).toBe(filteredConsoleLog);

			restoreSecond();
			expect(process.stdout.write).toBe(originalStdoutWrite);
			expect(process.stderr.write).toBe(originalStderrWrite);
			expect(console.log).toBe(originalConsoleLog);
		} finally {
			restoreFirst();
			restoreSecond();
			process.stdout.write = originalStdoutWrite;
			process.stderr.write = originalStderrWrite;
			console.log = originalConsoleLog;
		}
	});

	it("shares install state across provider and maintainer script wrappers", () => {
		const originalStdoutWrite = process.stdout.write;
		const originalStderrWrite = process.stderr.write;
		const restoreProvider = installCursorSdkOutputFilter();
		const filteredStdoutWrite = process.stdout.write;
		const filteredStderrWrite = process.stderr.write;
		const restoreScript = installScriptCursorSdkOutputFilter();
		try {
			expect(process.stdout.write).toBe(filteredStdoutWrite);
			expect(process.stderr.write).toBe(filteredStderrWrite);

			restoreProvider();
			expect(process.stdout.write).toBe(filteredStdoutWrite);
			expect(process.stderr.write).toBe(filteredStderrWrite);

			restoreScript();
			expect(process.stdout.write).toBe(originalStdoutWrite);
			expect(process.stderr.write).toBe(originalStderrWrite);
		} finally {
			restoreProvider();
			restoreScript();
			process.stdout.write = originalStdoutWrite;
			process.stderr.write = originalStderrWrite;
		}
	});
});
