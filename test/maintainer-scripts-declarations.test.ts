import type { ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import type {
	CursorDebugCaptureCounts,
	CursorDebugCaptureSummary,
	CursorDebugProviderEventsArgs,
	CursorDebugProviderEventsRunSummary,
	CursorPiSessionSnapshotState,
} from "../scripts/debug-provider-events.d.mts";
import type {
	CursorDebugSdkEventsArgs,
	CursorSdkEventDebugSummary,
	CursorSdkEventTimingSnapshot,
} from "../scripts/debug-sdk-events.d.mts";
import {
	backfillPiSessionSnapshot,
	parseDebugProviderEventsArgs,
	runDebugProviderEvents,
} from "../scripts/debug-provider-events.mjs";
import {
	buildSummary,
	createEventJsonlSink,
	createTimingTracker,
	parseDebugSdkEventsArgs,
	type CursorSdkEventJsonlSink,
} from "../scripts/debug-sdk-events.mjs";
import type { buildCloudSmokeEnv as cloudSmokeEnvDeclaration } from "../scripts/cloud-runtime-smoke.d.mts";
import {
	commonBooleanFlag,
	commonProbeFlags,
	commonProbePathFlag,
	commonProbeStringFlag,
	commonRepeatStringFlag,
	defaultApiKeyFromEnv,
	defaultSettingSourcesFromEnv,
	defaultTimestampedDir,
	parseArgv,
	readArgvValue,
	requireApiKey,
} from "../scripts/lib/cursor-cli-args.mjs";
import {
	buildCursorSmokeEnv,
	buildCursorSmokeEnvPlan,
	CURSOR_SDK_EVENT_DEBUG_ENV_NAMES as SCRIPT_CURSOR_SDK_EVENT_DEBUG_ENV_NAMES,
	sealedNodePath,
} from "../scripts/lib/cursor-smoke-env.mjs";
import {
	CHILD_PROCESS_TREE_SPAWN_OPTIONS,
	DEFAULT_CHILD_SHUTDOWN_GRACE_MS,
	parseJsonLines,
	signalChild,
	terminateChild,
	waitForChildClose,
} from "../scripts/lib/cursor-child-process.mjs";
import { createCloudSmokeShutdownController } from "../scripts/lib/cloud-smoke-shutdown.mjs";
import { createScriptFail } from "../scripts/lib/cursor-script-fail.mjs";
import {
	CURSOR_SDK_STARTUP_NOISE_PATTERNS,
	installCursorSdkOutputFilter,
	isCursorSdkOutputSuppressed,
	isCursorSdkStartupNoise,
	suppressCursorSdkOutput,
} from "../scripts/lib/cursor-sdk-output-filter.mjs";
import { buildTerminalHtml, writeTerminalScreenshot } from "../scripts/lib/cursor-visual-render.mjs";
import { scrubSensitiveText as scrubSensitiveTextFromScriptLib } from "../shared/cursor-sensitive-text.mjs";
import {
	CURSOR_SETTING_SOURCES_ENV as SCRIPT_CURSOR_SETTING_SOURCES_ENV,
	resolveCursorSettingSources as resolveCursorSettingSourcesFromScriptLib,
	serializeCursorSettingSources as serializeCursorSettingSourcesFromScriptLib,
} from "../shared/cursor-setting-sources.mjs";
import { scrubSensitiveText } from "../shared/cursor-sensitive-text.mjs";
import {
	CURSOR_SETTING_SOURCES_ENV,
	resolveCursorSettingSources,
	serializeCursorSettingSources,
} from "../shared/cursor-setting-sources.mjs";
import { CURSOR_SDK_EVENT_DEBUG_ENV_NAMES } from "../shared/cursor-sdk-event-debug-env.mjs";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { files: string[] };

/** Type-only exports that intentionally have no runtime .mjs value. */
const DECLARATION_TYPE_ONLY_EXPORTS: Record<string, readonly string[]> = {
	"shared/cursor-sdk-output-filter.d.mts": ["CursorSdkCapabilityNotice", "CursorSdkOutputNoticeHandler"],
	"shared/cursor-model-selection-identities.d.mts": ["CursorModelSelectionIdentity"],
	"scripts/cloud-runtime-smoke.d.mts": [
		"CloudSmokeBranchLaneEvidence",
		"CloudSmokeCancelLaneEvidence",
		"CloudSmokeCleanupEvidence",
		"CloudSmokeDirectPushLaneEvidence",
		"CloudSmokeEvidenceBranch",
		"CloudSmokeEvidenceProvenance",
		"CloudSmokeLaneEvidence",
		"CloudSmokeLaneName",
		"CloudSmokeLifecycleDeleteLaneEvidence",
		"CloudSmokeMatrixEvidence",
		"CloudSmokeMissingBranchLaneEvidence",
		"CloudSmokeOwnedRepository",
		"CloudSmokePassiveArtifactsLaneEvidence",
		"CloudSmokeReleaseGateState",
		"CloudSmokeThrowawayRepositoryEvidence",
	],
	"scripts/debug-provider-events.d.mts": [
		"CursorDebugCaptureCounts",
		"CursorDebugCaptureSummary",
		"CursorDebugProviderEventsArgs",
		"CursorDebugProviderEventsRunSummary",
		"CursorPiSessionSnapshotState",
	],
	"scripts/debug-sdk-events.d.mts": [
		"CursorDebugSdkEventsArgs",
		"CursorSdkEventDebugSummary",
		"CursorSdkEventTimingSnapshot",
		"CursorSdkEventJsonlSink",
	],
	"scripts/lib/cloud-smoke-artifacts.d.mts": [
		"CloudSmokeLifecycleRecord",
		"CloudSmokeMetadataRecord",
	],
	"scripts/lib/cloud-smoke-cleanup-evidence.d.mts": [
		"CloudSmokeBranchLaneEvidence",
		"CloudSmokeCancelLaneEvidence",
		"CloudSmokeCleanupEvidence",
		"CloudSmokeDirectPushLaneEvidence",
		"CloudSmokeEvidenceBranch",
		"CloudSmokeEvidenceProvenance",
		"CloudSmokeLaneEvidence",
		"CloudSmokeLaneName",
		"CloudSmokeLifecycleDeleteLaneEvidence",
		"CloudSmokeMatrixEvidence",
		"CloudSmokeMissingBranchLaneEvidence",
		"CloudSmokePassiveArtifactsLaneEvidence",
		"CloudSmokeReleaseGateState",
		"CloudSmokeThrowawayRepositoryEvidence",
	],
	"scripts/lib/cloud-smoke-github.d.mts": [
		"CloudSmokeOwnedRepository",
	],
	"scripts/lib/cloud-smoke-shutdown.d.mts": [
		"CloudSmokeShutdownController",
	],
	"scripts/lib/cursor-cli-args.d.mts": [
		"CursorCliBooleanFlagSpec",
		"CursorCliFlagSpec",
		"CursorCliFlagSpecMap",
		"CursorCliValueFlagSpec",
		"ParsedCursorCliArgs",
	],
};

describe("maintainer script declaration contracts", () => {
	it("keeps compile-time negative fixtures for stale declaration shapes", () => {
		expect(true).toBe(true);
	});

	it("checks every published declaration-backed script surface", async () => {
		const declarations = listPublishedDeclarations();
		for (const declaration of declarations) {
			const declarationValueExports = readDeclarationValueExports(declaration);
			const declarationTypeExports = readDeclarationTypeExports(declaration);
			const runtimeExports = await readRuntimeExports(declaration);
			const documentedTypeOnlyExports = DECLARATION_TYPE_ONLY_EXPORTS[declaration] ?? [];
			expect(runtimeExports, `${declaration} runtime exports`).toEqual(declarationValueExports.sort());
			for (const runtimeExport of runtimeExports) {
				expect(declarationValueExports, `${declaration} must declare value export ${runtimeExport}`).toContain(runtimeExport);
			}
			expect(
				declarationTypeExports,
				`${declaration} documents type-only exports explicitly when present`,
			).toEqual([...documentedTypeOnlyExports].sort());
		}
	});
});

function listPublishedDeclarations(): string[] {
	const declarations = new Set<string>();
	for (const entry of packageJson.files) {
		if (entry.endsWith(".d.mts")) {
			declarations.add(entry);
			continue;
		}
		if (!entry.endsWith("/") && !existsSync(entry)) continue;
		if (existsSync(entry) && statSync(entry).isDirectory()) {
			for (const file of listDeclarationsInDirectory(entry)) declarations.add(file);
		}
	}
	return [...declarations].sort();
}

function listDeclarationsInDirectory(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return listDeclarationsInDirectory(path);
		if (!entry.isFile() || !path.endsWith(".d.mts")) return [];
		const runtimePath = path.replace(/\.d\.mts$/, ".mjs");
		expect(existsSync(runtimePath), `${path} must have a runtime .mjs sibling`).toBe(true);
		return [path.split(sep).join("/")];
	});
}

function readDeclarationValueExports(path: string): string[] {
	const source = readFileSync(path, "utf8");
	const names = new Set<string>();
	for (const match of source.matchAll(/export\s+(?:declare\s+)?(?:function|const)\s+([A-Za-z0-9_]+)/g)) {
		names.add(match[1]);
	}
	for (const match of source.matchAll(/export\s*\{([^}]+)\}\s*from/g)) {
		for (const rawName of match[1].split(",")) {
			const name = rawName.trim().split(/\s+as\s+/)[1] ?? rawName.trim().split(/\s+as\s+/)[0];
			if (name) names.add(name);
		}
	}
	return [...names].sort();
}

function readDeclarationTypeExports(path: string): string[] {
	const source = readFileSync(path, "utf8");
	const names = new Set<string>();
	for (const match of source.matchAll(/export\s+(?:declare\s+)?(?:interface|type)\s+([A-Za-z0-9_]+)/g)) {
		names.add(match[1]);
	}
	for (const match of source.matchAll(/export\s+type\s*\{([^}]+)\}\s*from/g)) {
		for (const rawName of match[1].split(",")) {
			const name = rawName.trim().split(/\s+as\s+/)[1] ?? rawName.trim().split(/\s+as\s+/)[0];
			if (name) names.add(name);
		}
	}
	return [...names].sort();
}

async function readRuntimeExports(declarationPath: string): Promise<string[]> {
	const runtimePath = declarationPath.replace(/\.d\.mts$/, ".mjs");
	const module = await import(pathToFileURL(join(process.cwd(), runtimePath)).href);
	return Object.keys(module)
		.filter((name) => name !== "default")
		.sort();
}

type AssertEqual<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : never;
type _providerSnapshotShape = AssertEqual<CursorPiSessionSnapshotState["copied"], boolean>;
type _providerCaptureCountsShape = AssertEqual<CursorDebugCaptureCounts, Record<string, number | Record<string, number>>>;
type _sdkTimingSnapshotShape = AssertEqual<CursorSdkEventTimingSnapshot["eventCount"], number>;

const _settingSourcesReturn: AssertEqual<ReturnType<typeof defaultSettingSourcesFromEnv>, string[] | undefined> = true;
const _waitForChildCloseReturn: AssertEqual<Awaited<ReturnType<typeof waitForChildClose>>, number> = true;
const _startupNoisePatterns: AssertEqual<typeof CURSOR_SDK_STARTUP_NOISE_PATTERNS, readonly string[]> = true;
const _parseDebugSdkEventsArgs: (argv: string[], env?: NodeJS.ProcessEnv) => CursorDebugSdkEventsArgs = parseDebugSdkEventsArgs;
const _parseDebugProviderEventsArgs: (argv: string[], env?: NodeJS.ProcessEnv) => CursorDebugProviderEventsArgs = parseDebugProviderEventsArgs;
const _runDebugProviderEvents: (args: CursorDebugProviderEventsArgs) => Promise<CursorDebugProviderEventsRunSummary> = runDebugProviderEvents;
const _backfillPiSessionSnapshot: (
	captureSummary: CursorDebugCaptureSummary | undefined,
	artifactDir: string,
	sessionDir: string,
) => CursorDebugCaptureSummary | undefined = backfillPiSessionSnapshot;
const _sdkArgsHelp: boolean = parseDebugSdkEventsArgs(["--prompt", "hello"], { CURSOR_API_KEY: "key" }).help;
const _providerArgsHelp: boolean = parseDebugProviderEventsArgs(["--prompt", "hello"], { CURSOR_API_KEY: "key" }).help;
const _childShutdownGraceMs: number = DEFAULT_CHILD_SHUTDOWN_GRACE_MS;
const _childProcessTreeSpawnOptions: Readonly<{ detached: boolean }> = CHILD_PROCESS_TREE_SPAWN_OPTIONS;
const _startupNoisePatternValue: readonly string[] = CURSOR_SDK_STARTUP_NOISE_PATTERNS;
const _timingSnapshot = createTimingTracker().snapshot();
const _eventJsonlSinkFactory: (artifactDir: string, startedAt: number) => CursorSdkEventJsonlSink = createEventJsonlSink;
const _sdkOutputFilterRestoreFactory: () => () => void = installCursorSdkOutputFilter;
const _suppressedValue: number = suppressCursorSdkOutput(() => 1);
const _isOutputSuppressed: boolean = isCursorSdkOutputSuppressed();
const _isStartupNoise: boolean = isCursorSdkStartupNoise("managed_skills.loaded");
const _parsedJsonLines: unknown[] = parseJsonLines('{"ok":true}\n');
const _failFactory: (prefix: string) => (message: string, secrets?: string | string[]) => never = createScriptFail;
const _scrubbedFromShared: string = scrubSensitiveText("token", "token");
const _scrubbedFromScriptLib: string = scrubSensitiveTextFromScriptLib("token", "token");
const _settingSourcesEnv: "PI_CURSOR_SETTING_SOURCES" = CURSOR_SETTING_SOURCES_ENV;
const _scriptSettingSourcesEnv: "PI_CURSOR_SETTING_SOURCES" = SCRIPT_CURSOR_SETTING_SOURCES_ENV;
const _sdkEventDebugEnvNames: readonly string[] = CURSOR_SDK_EVENT_DEBUG_ENV_NAMES;
const _scriptSdkEventDebugEnvNames: readonly string[] = SCRIPT_CURSOR_SDK_EVENT_DEBUG_ENV_NAMES;
const _resolvedSharedSources: string[] | undefined = resolveCursorSettingSources("all");
const _resolvedScriptSources: string[] | undefined = resolveCursorSettingSourcesFromScriptLib("all");
const _serializedSharedSources: string = serializeCursorSettingSources(["project"]);
const _serializedScriptSources: string = serializeCursorSettingSourcesFromScriptLib(["project"]);
const _defaultApiKey: string | undefined = defaultApiKeyFromEnv({ CURSOR_API_KEY: "key" });
const _timestampedDir: string = defaultTimestampedDir("debug");
const _commonPathFlag: Record<string, unknown> = commonProbePathFlag("cwd");
const _commonStringFlag: Record<string, unknown> = commonProbeStringFlag("model");
const _commonBooleanFlag: Record<string, unknown> = commonBooleanFlag("--self-test");
const _commonRepeatStringFlag: Record<string, unknown> = commonRepeatStringFlag("--leftover-pattern");
const _commonFlags: Record<string, unknown> = commonProbeFlags;
const _readArgvValue: string = readArgvValue(["--model", "cursor"], 1, "--model", createScriptFail("test"));
const _parsedArgv: Record<string, unknown> = parseArgv([], { defaults: {}, flags: {}, fail: createScriptFail("test") });
const _sealedNodePath: string = sealedNodePath("/usr/local/bin/node", "/tmp/bin");
const _smokeEnv: Record<string, string | undefined> = buildCursorSmokeEnv({ settingSources: "none", nativeToolDisplay: true });
const _cloudSmokeEnvReturn: AssertEqual<ReturnType<typeof cloudSmokeEnvDeclaration>, NodeJS.ProcessEnv> = true;
const _cloudSmokeEnvContextArg: AssertEqual<Parameters<typeof cloudSmokeEnvDeclaration>[1], {
	contextHandoff?: "fresh" | "bootstrap" | "never";
	repoUrl?: string;
	startingRef?: string;
	directPush?: boolean;
} | undefined> = true;
const _smokeEnvPlan: { envEntries: Array<[string, string]> } = buildCursorSmokeEnvPlan({ settingSources: "none" });
const _terminalHtml: string = buildTerminalHtml({
	ansi: "ok",
	plain: "ok",
	options: { label: "test", model: "cursor/composer-2.5", mode: "plan", cwd: "/tmp", sessionId: "s", width: 80, height: 24, historyLines: 100 },
});
const _writeTerminalScreenshot: (htmlPath: string, pngPath: string, width: number, height: number) => Promise<void> = writeTerminalScreenshot;
const _requiredApiKey: string = requireApiKey({ apiKey: "key" }, {}, createScriptFail("test"));
const _signalChild: (child: ChildProcess, signal: NodeJS.Signals) => void = signalChild;
const _terminateChild: (child: ChildProcess, options?: { graceMs?: number }) => Promise<void> = terminateChild;
const _cloudSmokeShutdown = createCloudSmokeShutdownController((child) => terminateChild(child, { graceMs: 15_000 }));

// @ts-expect-error startup noise patterns are string literals, not regular expressions
const _invalidStartupNoisePatternType: readonly RegExp[] = CURSOR_SDK_STARTUP_NOISE_PATTERNS;

const _validProviderArgs = {
	cwd: "/tmp/work",
	model: "cursor/composer-2.5",
	help: false,
} satisfies CursorDebugProviderEventsArgs;

const _validSdkArgs = {
	cwd: "/tmp/work",
	model: "composer-2.5",
	includeConversation: false,
	help: false,
} satisfies CursorDebugSdkEventsArgs;

const _validCaptureSummary = {
	artifactDir: "/tmp/out",
	counts: { errors: 0 },
	piSessionSnapshot: { copied: false },
} satisfies CursorDebugCaptureSummary;

const _validRunSummary = {
	artifactDir: "/tmp/out",
	artifacts: { summary: "/tmp/out/summary.json" },
	counts: { errors: 0 },
	elapsedMs: 100,
	model: "cursor/composer-2.5",
	cwd: "/repo",
	sessionDir: "/tmp/out/session",
	extensionVersion: "0.1.20",
	sdkVersion: "1.0.0",
	waitResultRecorded: true,
} satisfies CursorDebugProviderEventsRunSummary;

const _validSdkSummary = buildSummary({
	artifactDir: "/tmp/out",
	counts: { stream: {}, onDelta: {}, onStep: {} },
	timing: { stream: _timingSnapshot, onDelta: _timingSnapshot, onStep: _timingSnapshot },
	includeConversation: false,
}) satisfies CursorSdkEventDebugSummary;

const _invalidProviderArgs = {
	cwd: "/tmp/work",
	model: "cursor/composer-2.5",
	// @ts-expect-error parsed probe args always include help
} satisfies CursorDebugProviderEventsArgs;

const _invalidSdkArgs = {
	cwd: "/tmp/work",
	model: "composer-2.5",
	includeConversation: false,
	// @ts-expect-error parsed probe args always include help
} satisfies CursorDebugSdkEventsArgs;

const _invalidProviderSettingSources = {
	cwd: "/tmp/work",
	model: "cursor/composer-2.5",
	help: false,
	// @ts-expect-error settingSources is parsed as string[] | undefined
	settingSources: "all",
} satisfies CursorDebugProviderEventsArgs;

const _invalidRunSummary = {
	artifactDir: "/tmp/out",
	artifacts: { summary: "/tmp/out/summary.json" },
	counts: { errors: 0 },
	elapsedMs: 100,
	model: "cursor/composer-2.5",
	cwd: "/repo",
	sessionDir: "/tmp/out/session",
	extensionVersion: "0.1.20",
	sdkVersion: "1.0.0",
	// @ts-expect-error run summary is projected, not the raw capture summary
	piSessionSnapshot: { copied: false },
} satisfies CursorDebugProviderEventsRunSummary;

void [
	_settingSourcesReturn,
	_waitForChildCloseReturn,
	_startupNoisePatterns,
	_parseDebugSdkEventsArgs,
	_parseDebugProviderEventsArgs,
	_runDebugProviderEvents,
	_backfillPiSessionSnapshot,
	_sdkArgsHelp,
	_providerArgsHelp,
	_childShutdownGraceMs,
	_childProcessTreeSpawnOptions,
	_startupNoisePatternValue,
	_timingSnapshot,
	_eventJsonlSinkFactory,
	_sdkOutputFilterRestoreFactory,
	_suppressedValue,
	_isOutputSuppressed,
	_isStartupNoise,
	_parsedJsonLines,
	_cloudSmokeEnvReturn,
	_cloudSmokeEnvContextArg,
	_failFactory,
	_scrubbedFromShared,
	_scrubbedFromScriptLib,
	_settingSourcesEnv,
	_scriptSettingSourcesEnv,
	_resolvedSharedSources,
	_resolvedScriptSources,
	_serializedSharedSources,
	_serializedScriptSources,
	_defaultApiKey,
	_timestampedDir,
	_commonPathFlag,
	_commonStringFlag,
	_commonFlags,
	_readArgvValue,
	_parsedArgv,
	_requiredApiKey,
	_signalChild,
	_terminateChild,
	_invalidStartupNoisePatternType,
	_validProviderArgs,
	_validSdkArgs,
	_validCaptureSummary,
	_validRunSummary,
	_validSdkSummary,
	_invalidProviderArgs,
	_invalidSdkArgs,
	_invalidProviderSettingSources,
	_invalidRunSummary,
];
