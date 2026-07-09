import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export const CURSOR_SDK_CONFIG_FILE = "cursor-sdk.json";

export const CURSOR_RUNTIME_ENV = "PI_CURSOR_RUNTIME";
export const CURSOR_TOOL_TRANSPORT_ENV = "PI_CURSOR_TOOL_TRANSPORT";
export const CURSOR_CLOUD_REPO_ENV = "PI_CURSOR_CLOUD_REPO";
export const CURSOR_CLOUD_BRANCH_ENV = "PI_CURSOR_CLOUD_BRANCH";
export const CURSOR_CLOUD_CONTEXT_ENV = "PI_CURSOR_CLOUD_CONTEXT";
export const CURSOR_CLOUD_DIRECT_PUSH_ENV = "PI_CURSOR_CLOUD_DIRECT_PUSH";
export const CURSOR_CLOUD_ALLOW_LOCAL_STATE_ENV = "PI_CURSOR_CLOUD_ALLOW_LOCAL_STATE";
export const CURSOR_CLOUD_ENV_ENV = "PI_CURSOR_CLOUD_ENV";
export const CURSOR_CLOUD_ENV_FROM_FILES_ENV = "PI_CURSOR_CLOUD_ENV_FROM_FILES";
export const CURSOR_CLOUD_ENV_TYPE_ENV = "PI_CURSOR_CLOUD_ENV_TYPE";
export const CURSOR_CLOUD_ENV_NAME_ENV = "PI_CURSOR_CLOUD_ENV_NAME";
export const CURSOR_CLOUD_ACK_ENV = "PI_CURSOR_CLOUD_ACK";
export const CURSOR_AUTO_REVIEW_ENV = "PI_CURSOR_AUTO_REVIEW";
export const CURSOR_SANDBOX_ENV = "PI_CURSOR_SANDBOX";
export const CURSOR_LOCAL_FORCE_ENV = "PI_CURSOR_LOCAL_FORCE";
export const CURSOR_LOCAL_RESUME_ENV = "PI_CURSOR_LOCAL_RESUME";

export type CursorConfigSource = "cli" | "environment" | "project" | "user" | "session" | "model-alias" | "builtin";
export type CursorConfigTrustLevel = "one-shot" | "environment" | "trusted-project" | "user" | "session" | "model-catalog" | "builtin";
export type CursorRuntime = "local" | "cloud";
export type CursorToolTransport = "mcp" | "customTools";
export type CursorCloudContextHandoff = "never" | "fresh" | "bootstrap";
export type CursorCloudEnvironmentType = "cloud" | "pool" | "machine";

export interface CursorCloudEnvironmentConfig {
	type?: CursorCloudEnvironmentType | string;
	name?: string;
}

export interface CursorSdkConfig {
	fastDefaults?: Record<string, boolean>;
	runtime?: CursorRuntime;
	toolTransport?: CursorToolTransport;
	cloud?: {
		repo?: string;
		branch?: string;
		contextHandoff?: CursorCloudContextHandoff;
		directPush?: boolean;
		allowLocalState?: boolean;
		envNames?: string[];
		envFromFiles?: boolean;
		environment?: CursorCloudEnvironmentConfig;
		acknowledged?: boolean;
	};
	local?: {
		autoReview?: boolean;
		sandbox?: boolean;
		sandboxOptions?: {
			enabled?: boolean;
		};
		force?: boolean;
		resume?: boolean;
	};
}

export interface CursorSafetyCap<T> {
	source: CursorConfigSource;
	trustLevel: CursorConfigTrustLevel;
	value: T;
	cappedSource: CursorConfigSource;
	cappedValue: T;
	reason: "safer-source";
}

export interface CursorResolvedSetting<T> {
	value: T;
	source: CursorConfigSource;
	trustLevel: CursorConfigTrustLevel;
	cappedBy?: CursorSafetyCap<T>;
}

export interface CursorResolvedSdkConfig {
	runtime: CursorResolvedSetting<CursorRuntime>;
	toolTransport: CursorResolvedSetting<CursorToolTransport>;
	cloud: {
		repo: CursorResolvedSetting<string | undefined>;
		branch: CursorResolvedSetting<string | undefined>;
		contextHandoff: CursorResolvedSetting<CursorCloudContextHandoff>;
		directPush: CursorResolvedSetting<boolean>;
		allowLocalState: CursorResolvedSetting<boolean>;
		envNames: CursorResolvedSetting<string[]>;
		envFromFiles: CursorResolvedSetting<boolean>;
		environment: CursorResolvedSetting<CursorCloudEnvironmentConfig | undefined>;
		acknowledged: CursorResolvedSetting<boolean>;
	};
	local: {
		autoReview: CursorResolvedSetting<boolean>;
		sandboxEnabled: CursorResolvedSetting<boolean>;
		force: CursorResolvedSetting<boolean>;
		resume: CursorResolvedSetting<boolean>;
	};
}

export interface ResolveCursorSdkConfigOptions {
	cli?: CursorSdkConfig;
	env?: Record<string, string | undefined>;
	session?: CursorSdkConfig;
	project?: CursorSdkConfig;
	user?: CursorSdkConfig;
	builtIn?: CursorSdkConfig;
}

export interface LoadCursorSdkConfigOptions {
	cwd?: string;
	projectTrusted?: boolean;
	agentDir?: string;
}

const TRUST_LEVELS: Record<CursorConfigSource, CursorConfigTrustLevel> = {
	cli: "one-shot",
	environment: "environment",
	project: "trusted-project",
	user: "user",
	session: "session",
	"model-alias": "model-catalog",
	builtin: "builtin",
};

const BUILT_IN_CURSOR_CONFIG: Required<Pick<CursorSdkConfig, "runtime" | "toolTransport">> & {
	cloud: Required<NonNullable<CursorSdkConfig["cloud"]>>;
} = {
	runtime: "local",
	toolTransport: "mcp",
	cloud: {
		repo: "",
		branch: "",
		contextHandoff: "fresh",
		directPush: false,
		allowLocalState: false,
		envNames: [],
		envFromFiles: false,
		environment: {},
		acknowledged: false,
	},
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function isCursorRuntime(value: unknown): value is CursorRuntime {
	return value === "local" || value === "cloud";
}

function isCursorToolTransport(value: unknown): value is CursorToolTransport {
	return value === "mcp" || value === "customTools";
}

function isCursorCloudContextHandoff(value: unknown): value is CursorCloudContextHandoff {
	return value === "never" || value === "fresh" || value === "bootstrap";
}

export function isCursorCloudEnvironmentType(value: unknown): value is CursorCloudEnvironmentType {
	return value === "cloud" || value === "pool" || value === "machine";
}

function parseEnvBoolean(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return undefined;
}

function parseNonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}

function isAllowedEnvName(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) && !value.startsWith("CURSOR_");
}

function parseEnvNames(value: unknown): string[] | undefined {
	const names = Array.isArray(value)
		? value
		: typeof value === "string"
			? value.split(",")
			: undefined;
	if (!names) return undefined;
	const parsed = [...new Set(names.map((name) => (typeof name === "string" ? name.trim() : "")).filter(isAllowedEnvName))];
	return parsed.length > 0 || (Array.isArray(value) && value.length === 0) ? parsed : undefined;
}

function parseCloudEnvironment(value: unknown): CursorCloudEnvironmentConfig | undefined {
	const environment = asRecord(value);
	if (!environment) return undefined;
	const parsed: CursorCloudEnvironmentConfig = {};
	const rawType = parseNonEmptyString(environment.type);
	const name = parseNonEmptyString(environment.name);
	if (rawType) parsed.type = rawType;
	if (name) parsed.name = name;
	return Object.keys(parsed).length > 0 ? parsed : undefined;
}

export function parseCursorSdkConfig(value: unknown): CursorSdkConfig | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const config: CursorSdkConfig = {};

	if (isCursorRuntime(record.runtime)) config.runtime = record.runtime;
	if (isCursorToolTransport(record.toolTransport)) config.toolTransport = record.toolTransport;

	const fastDefaults = asRecord(record.fastDefaults);
	if (fastDefaults) {
		config.fastDefaults = Object.fromEntries(
			Object.entries(fastDefaults).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"),
		);
	}

	const cloud = asRecord(record.cloud);
	if (cloud) {
		const parsedCloud: NonNullable<CursorSdkConfig["cloud"]> = {};
		const repo = parseNonEmptyString(cloud.repo);
		const branch = parseNonEmptyString(cloud.branch);
		const envNames = parseEnvNames(cloud.envNames);
		const environment = parseCloudEnvironment(cloud.environment);
		if (repo) parsedCloud.repo = repo;
		if (branch) parsedCloud.branch = branch;
		if (isCursorCloudContextHandoff(cloud.contextHandoff)) parsedCloud.contextHandoff = cloud.contextHandoff;
		if (typeof cloud.directPush === "boolean") parsedCloud.directPush = cloud.directPush;
		if (typeof cloud.allowLocalState === "boolean") parsedCloud.allowLocalState = cloud.allowLocalState;
		if (envNames) parsedCloud.envNames = envNames;
		if (typeof cloud.envFromFiles === "boolean") parsedCloud.envFromFiles = cloud.envFromFiles;
		if (environment) parsedCloud.environment = environment;
		if (typeof cloud.acknowledged === "boolean") parsedCloud.acknowledged = cloud.acknowledged;
		if (Object.keys(parsedCloud).length > 0) config.cloud = parsedCloud;
	}

	const local = asRecord(record.local);
	if (local) {
		const parsedLocal: NonNullable<CursorSdkConfig["local"]> = {};
		if (typeof local.autoReview === "boolean") parsedLocal.autoReview = local.autoReview;
		if (typeof local.sandbox === "boolean") parsedLocal.sandbox = local.sandbox;
		if (typeof local.force === "boolean") parsedLocal.force = local.force;
		if (typeof local.resume === "boolean") parsedLocal.resume = local.resume;
		const sandboxOptions = asRecord(local.sandboxOptions);
		if (typeof sandboxOptions?.enabled === "boolean") parsedLocal.sandboxOptions = { enabled: sandboxOptions.enabled };
		if (Object.keys(parsedLocal).length > 0) config.local = parsedLocal;
	}

	return config;
}

export function getCursorSdkUserConfigPath(agentDir = getAgentDir()): string {
	return join(agentDir, CURSOR_SDK_CONFIG_FILE);
}

export function getCursorSdkProjectConfigPath(cwd: string, configDirName = CONFIG_DIR_NAME): string {
	return join(cwd, configDirName, CURSOR_SDK_CONFIG_FILE);
}

function readCursorSdkConfigFile(path: string): CursorSdkConfig {
	if (!existsSync(path)) return {};
	try {
		return parseCursorSdkConfig(JSON.parse(readFileSync(path, "utf-8"))) ?? {};
	} catch {
		return {};
	}
}

export function loadCursorSdkUserConfig(path = getCursorSdkUserConfigPath()): CursorSdkConfig {
	return readCursorSdkConfigFile(path);
}

export function loadCursorSdkProjectConfig(cwd: string, projectTrusted: boolean): CursorSdkConfig | undefined {
	if (!projectTrusted) return undefined;
	const path = getCursorSdkProjectConfigPath(cwd);
	return existsSync(path) ? readCursorSdkConfigFile(path) : undefined;
}

export function loadCursorSdkConfig(options: LoadCursorSdkConfigOptions = {}): { user: CursorSdkConfig; project?: CursorSdkConfig } {
	const user = loadCursorSdkUserConfig(getCursorSdkUserConfigPath(options.agentDir));
	const project = options.cwd ? loadCursorSdkProjectConfig(options.cwd, options.projectTrusted === true) : undefined;
	return project ? { user, project } : { user };
}

export function saveCursorSdkUserConfig(config: CursorSdkConfig, path = getCursorSdkUserConfigPath()): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

export function saveCursorSdkProjectConfig(cwd: string, config: CursorSdkConfig, configDirName = CONFIG_DIR_NAME): void {
	const path = getCursorSdkProjectConfigPath(cwd, configDirName);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

export function mergeCursorSdkConfig(base: CursorSdkConfig, patch: CursorSdkConfig): CursorSdkConfig {
	return {
		...base,
		...patch,
		...(base.cloud || patch.cloud
			? { cloud: { ...base.cloud, ...patch.cloud } }
			: {}),
		...(base.local || patch.local
			? {
					local: {
						...base.local,
						...patch.local,
						...(base.local?.sandboxOptions || patch.local?.sandboxOptions
							? { sandboxOptions: { ...base.local?.sandboxOptions, ...patch.local?.sandboxOptions } }
							: {}),
					},
				}
			: {}),
	};
}

export function cursorFastDefaultsFromConfig(config: CursorSdkConfig | undefined): Map<string, boolean> {
	return new Map(Object.entries(config?.fastDefaults ?? {}));
}

export function withCursorFastDefaults(config: CursorSdkConfig, fastDefaults: Map<string, boolean>): CursorSdkConfig {
	return {
		...config,
		fastDefaults: Object.fromEntries([...fastDefaults.entries()].sort(([a], [b]) => a.localeCompare(b))),
	};
}

function resolved<T>(source: CursorConfigSource, value: T, cappedBy?: CursorSafetyCap<T>): CursorResolvedSetting<T> {
	return { value, source, trustLevel: TRUST_LEVELS[source], ...(cappedBy ? { cappedBy } : {}) };
}

function valueFrom<T>(source: CursorConfigSource, value: T | undefined): CursorResolvedSetting<T> | undefined {
	return value === undefined ? undefined : resolved(source, value);
}

function resolveOrdinary<T>(layers: Array<CursorResolvedSetting<T> | undefined>): CursorResolvedSetting<T> {
	const match = layers.find((layer): layer is CursorResolvedSetting<T> => layer !== undefined);
	if (!match) throw new Error("Cursor config resolver missing built-in default");
	return match;
}

function resolveSafety<T>(
	baseLayers: Array<CursorResolvedSetting<T> | undefined>,
	capLayers: Array<CursorResolvedSetting<T> | undefined>,
	risk: (value: T) => number,
): CursorResolvedSetting<T> {
	const cli = baseLayers[0];
	if (cli) return cli;
	const base = resolveOrdinary(baseLayers.slice(1));
	const cap = capLayers
		.filter((layer): layer is CursorResolvedSetting<T> => layer !== undefined && risk(layer.value) < risk(base.value))
		.sort((a, b) => risk(a.value) - risk(b.value))[0];
	if (!cap) return base;
	return resolved(cap.source, cap.value, {
		source: cap.source,
		trustLevel: cap.trustLevel,
		value: cap.value,
		cappedSource: base.source,
		cappedValue: base.value,
		reason: "safer-source",
	});
}

function resolveEnvNamesSafety(
	baseLayers: Array<CursorResolvedSetting<string[]> | undefined>,
	userCap: CursorResolvedSetting<string[]> | undefined,
): CursorResolvedSetting<string[]> {
	const cli = baseLayers[0];
	if (cli) return cli;
	const base = resolveOrdinary(baseLayers.slice(1));
	if (!userCap || base.source === "user") return base;
	const allowed = new Set(userCap.value);
	const filtered = base.value.filter((name) => allowed.has(name));
	if (filtered.length === base.value.length) return base;
	return resolved(userCap.source, filtered, {
		source: userCap.source,
		trustLevel: userCap.trustLevel,
		value: filtered,
		cappedSource: base.source,
		cappedValue: base.value,
		reason: "safer-source",
	});
}

export function cursorSdkConfigFromEnv(env: Record<string, string | undefined> = process.env): CursorSdkConfig {
	const config: CursorSdkConfig = {};
	const runtime = env[CURSOR_RUNTIME_ENV]?.trim();
	if (isCursorRuntime(runtime)) config.runtime = runtime;
	const toolTransport = env[CURSOR_TOOL_TRANSPORT_ENV]?.trim();
	if (isCursorToolTransport(toolTransport)) config.toolTransport = toolTransport;
	const repo = parseNonEmptyString(env[CURSOR_CLOUD_REPO_ENV]);
	const branch = parseNonEmptyString(env[CURSOR_CLOUD_BRANCH_ENV]);
	const contextHandoff = env[CURSOR_CLOUD_CONTEXT_ENV]?.trim();
	const directPush = parseEnvBoolean(env[CURSOR_CLOUD_DIRECT_PUSH_ENV]);
	const allowLocalState = parseEnvBoolean(env[CURSOR_CLOUD_ALLOW_LOCAL_STATE_ENV]);
	const envNames = parseEnvNames(env[CURSOR_CLOUD_ENV_ENV]);
	const envFromFiles = parseEnvBoolean(env[CURSOR_CLOUD_ENV_FROM_FILES_ENV]);
	const environment = parseCloudEnvironment({
		type: env[CURSOR_CLOUD_ENV_TYPE_ENV],
		name: env[CURSOR_CLOUD_ENV_NAME_ENV],
	});
	const acknowledged = parseEnvBoolean(env[CURSOR_CLOUD_ACK_ENV]);
	if (
		repo !== undefined ||
		branch !== undefined ||
		isCursorCloudContextHandoff(contextHandoff) ||
		directPush !== undefined ||
		allowLocalState !== undefined ||
		envNames !== undefined ||
		envFromFiles !== undefined ||
		environment !== undefined ||
		acknowledged !== undefined
	) {
		config.cloud = {
			...(repo !== undefined ? { repo } : {}),
			...(branch !== undefined ? { branch } : {}),
			...(isCursorCloudContextHandoff(contextHandoff) ? { contextHandoff } : {}),
			...(directPush !== undefined ? { directPush } : {}),
			...(allowLocalState !== undefined ? { allowLocalState } : {}),
			...(envNames !== undefined ? { envNames } : {}),
			...(envFromFiles !== undefined ? { envFromFiles } : {}),
			...(environment !== undefined ? { environment } : {}),
			...(acknowledged !== undefined ? { acknowledged } : {}),
		};
	}
	const autoReview = parseEnvBoolean(env[CURSOR_AUTO_REVIEW_ENV]);
	const sandbox = parseEnvBoolean(env[CURSOR_SANDBOX_ENV]);
	const force = parseEnvBoolean(env[CURSOR_LOCAL_FORCE_ENV]);
	const resume = parseEnvBoolean(env[CURSOR_LOCAL_RESUME_ENV]);
	if (autoReview !== undefined || sandbox !== undefined || force !== undefined || resume !== undefined) {
		config.local = {
			...(autoReview !== undefined ? { autoReview } : {}),
			...(sandbox !== undefined ? { sandboxOptions: { enabled: sandbox } } : {}),
			...(force !== undefined ? { force } : {}),
			...(resume !== undefined ? { resume } : {}),
		};
	}
	return config;
}

export function resolveCursorSdkConfig(options: ResolveCursorSdkConfigOptions = {}): CursorResolvedSdkConfig {
	const env = cursorSdkConfigFromEnv(options.env);
	const builtIn = {
		...BUILT_IN_CURSOR_CONFIG,
		...options.builtIn,
		cloud: { ...BUILT_IN_CURSOR_CONFIG.cloud, ...options.builtIn?.cloud },
	};
	const cli = options.cli;
	const session = options.session;
	const project = options.project;
	const user = options.user;
	return {
		runtime: resolveSafety(
			[
				valueFrom("cli", cli?.runtime),
				valueFrom("environment", env.runtime),
				valueFrom("session", session?.runtime),
				valueFrom("project", project?.runtime),
				valueFrom("user", user?.runtime),
				valueFrom("builtin", builtIn.runtime),
			],
			[valueFrom("user", user?.runtime)],
			(value) => (value === "cloud" ? 1 : 0),
		),
		toolTransport: resolveOrdinary([
			valueFrom("cli", cli?.toolTransport),
			valueFrom("environment", env.toolTransport),
			valueFrom("session", session?.toolTransport),
			valueFrom("project", project?.toolTransport),
			valueFrom("user", user?.toolTransport),
			valueFrom("builtin", builtIn.toolTransport),
		]),
		cloud: {
			repo: resolveOrdinary([
				valueFrom("cli", cli?.cloud?.repo),
				valueFrom("environment", env.cloud?.repo),
				valueFrom("session", session?.cloud?.repo),
				valueFrom("user", user?.cloud?.repo),
				resolved("builtin", undefined),
			]),
			branch: resolveOrdinary([
				valueFrom("cli", cli?.cloud?.branch),
				valueFrom("environment", env.cloud?.branch),
				valueFrom("session", session?.cloud?.branch),
				valueFrom("user", user?.cloud?.branch),
				resolved("builtin", undefined),
			]),
			contextHandoff: resolveSafety(
				[
					valueFrom("cli", cli?.cloud?.contextHandoff),
					valueFrom("environment", env.cloud?.contextHandoff),
					valueFrom("session", session?.cloud?.contextHandoff),
					valueFrom("user", user?.cloud?.contextHandoff),
					valueFrom("builtin", builtIn.cloud.contextHandoff),
				],
				[valueFrom("user", user?.cloud?.contextHandoff)],
				(value) => ({ never: 0, fresh: 1, bootstrap: 2 })[value],
			),
			directPush: resolveSafety(
				[
					valueFrom("cli", cli?.cloud?.directPush),
					valueFrom("environment", env.cloud?.directPush),
					valueFrom("session", session?.cloud?.directPush),
					valueFrom("user", user?.cloud?.directPush),
					valueFrom("builtin", builtIn.cloud.directPush),
				],
				[valueFrom("user", user?.cloud?.directPush)],
				(value) => (value ? 1 : 0),
			),
			allowLocalState: resolveSafety(
				[
					valueFrom("cli", cli?.cloud?.allowLocalState),
					valueFrom("environment", env.cloud?.allowLocalState),
					valueFrom("session", session?.cloud?.allowLocalState),
					valueFrom("user", user?.cloud?.allowLocalState),
					valueFrom("builtin", builtIn.cloud.allowLocalState),
				],
				[valueFrom("user", user?.cloud?.allowLocalState)],
				(value) => (value ? 1 : 0),
			),
			envNames: resolveEnvNamesSafety(
				[
					valueFrom("cli", cli?.cloud?.envNames),
					valueFrom("environment", env.cloud?.envNames),
					valueFrom("session", session?.cloud?.envNames),
					valueFrom("user", user?.cloud?.envNames),
					valueFrom("builtin", builtIn.cloud.envNames),
				],
				valueFrom("user", user?.cloud?.envNames),
			),
			envFromFiles: resolveSafety(
				[
					valueFrom("cli", cli?.cloud?.envFromFiles),
					valueFrom("environment", env.cloud?.envFromFiles),
					valueFrom("session", session?.cloud?.envFromFiles),
					valueFrom("user", user?.cloud?.envFromFiles),
					valueFrom("builtin", builtIn.cloud.envFromFiles),
				],
				[valueFrom("user", user?.cloud?.envFromFiles)],
				(value) => (value ? 1 : 0),
			),
			environment: resolveOrdinary([
				valueFrom("cli", cli?.cloud?.environment),
				valueFrom("environment", env.cloud?.environment),
				valueFrom("session", session?.cloud?.environment),
				valueFrom("user", user?.cloud?.environment),
				resolved("builtin", undefined),
			]),
			acknowledged: resolveOrdinary([
				valueFrom("cli", cli?.cloud?.acknowledged),
				valueFrom("environment", env.cloud?.acknowledged),
				valueFrom("session", session?.cloud?.acknowledged),
				valueFrom("user", user?.cloud?.acknowledged),
				valueFrom("builtin", builtIn.cloud.acknowledged),
			]),
		},
		local: {
			autoReview: resolveOrdinary([
				valueFrom("cli", cli?.local?.autoReview),
				valueFrom("environment", env.local?.autoReview),
				valueFrom("project", project?.local?.autoReview),
				valueFrom("user", user?.local?.autoReview),
				valueFrom("builtin", false),
			]),
			sandboxEnabled: resolveOrdinary([
				valueFrom("cli", cli?.local?.sandboxOptions?.enabled ?? cli?.local?.sandbox),
				valueFrom("environment", env.local?.sandboxOptions?.enabled ?? env.local?.sandbox),
				valueFrom("project", project?.local?.sandboxOptions?.enabled ?? project?.local?.sandbox),
				valueFrom("user", user?.local?.sandboxOptions?.enabled ?? user?.local?.sandbox),
				valueFrom("builtin", false),
			]),
			force: resolveOrdinary([
				valueFrom("cli", cli?.local?.force),
				valueFrom("environment", env.local?.force),
				valueFrom("builtin", false),
			]),
			resume: resolveOrdinary([
				valueFrom("cli", cli?.local?.resume),
				valueFrom("environment", env.local?.resume),
				valueFrom("project", project?.local?.resume),
				valueFrom("user", user?.local?.resume),
				valueFrom("builtin", true),
			]),
		},
	};
}

export function resolveCursorFastDefault(options: {
	cliForceFast?: boolean;
	cliForceNoFast?: boolean;
	aliasOverride?: boolean;
	sessionValue?: boolean;
	userValue?: boolean;
	modelDefault: boolean;
}): CursorResolvedSetting<boolean> {
	if (options.cliForceNoFast) return resolved("cli", false);
	if (options.cliForceFast) return resolved("cli", true);
	if (options.aliasOverride !== undefined) return resolved("model-alias", options.aliasOverride);
	if (options.sessionValue !== undefined) return resolved("session", options.sessionValue);
	if (options.userValue !== undefined) return resolved("user", options.userValue);
	return resolved("builtin", options.modelDefault);
}
