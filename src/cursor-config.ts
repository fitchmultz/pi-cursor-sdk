import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseCursorCustomSubagents, type CursorCustomSubagents } from "./cursor-custom-subagents.js";
import { parseOptionalEnvBoolean } from "./cursor-env-boolean.js";
import { asRecord } from "./cursor-record-utils.js";

export const CURSOR_SDK_CONFIG_FILE = "cursor-sdk.json";

export const CURSOR_RUNTIME_ENV = "PI_CURSOR_RUNTIME";
export const CURSOR_CLOUD_REPO_ENV = "PI_CURSOR_CLOUD_REPO";
export const CURSOR_CLOUD_BRANCH_ENV = "PI_CURSOR_CLOUD_BRANCH";
export const CURSOR_CLOUD_CONTEXT_ENV = "PI_CURSOR_CLOUD_CONTEXT";
export const CURSOR_CLOUD_DIRECT_PUSH_ENV = "PI_CURSOR_CLOUD_DIRECT_PUSH";
export const CURSOR_CLOUD_AUTO_CREATE_PR_ENV = "PI_CURSOR_CLOUD_AUTO_CREATE_PR";
export const CURSOR_CLOUD_SKIP_REVIEWER_REQUEST_ENV = "PI_CURSOR_CLOUD_SKIP_REVIEWER_REQUEST";
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
export const CURSOR_HTTP1_ENV = "PI_CURSOR_HTTP_1_1";

export type CursorConfigSource = "cli" | "environment" | "project" | "user" | "session" | "model-alias" | "builtin";
export type CursorConfigTrustLevel = "one-shot" | "environment" | "trusted-project" | "user" | "session" | "model-catalog" | "builtin";
export type CursorRuntime = "local" | "cloud";
export type CursorCloudContextHandoff = "never" | "fresh" | "bootstrap";
export type CursorCloudEnvironmentType = "cloud" | "pool" | "machine";

export interface CursorCloudEnvironmentConfig {
	type?: CursorCloudEnvironmentType | string;
	name?: string;
}

export interface CursorSdkConfig {
	fastDefaults?: Record<string, boolean>;
	runtime?: CursorRuntime;
	subagents?: CursorCustomSubagents;
	cloud?: {
		repo?: string;
		branch?: string;
		contextHandoff?: CursorCloudContextHandoff;
		directPush?: boolean;
		autoCreatePR?: boolean;
		skipReviewerRequest?: boolean;
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
		useHttp1ForAgent?: boolean;
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
	subagents: CursorResolvedSetting<CursorCustomSubagents>;
	cloud: {
		repo: CursorResolvedSetting<string | undefined>;
		branch: CursorResolvedSetting<string | undefined>;
		contextHandoff: CursorResolvedSetting<CursorCloudContextHandoff>;
		directPush: CursorResolvedSetting<boolean>;
		autoCreatePR: CursorResolvedSetting<boolean>;
		skipReviewerRequest: CursorResolvedSetting<boolean>;
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
		useHttp1ForAgent: CursorResolvedSetting<boolean>;
	};
}

// Widens string-literal-union fields (e.g. runtime, contextHandoff) to raw `string` so CLI callers can
// pass unvalidated input through to validateExplicitValue, while keeping every other field's shape linked
// to CursorSdkConfig so new fields don't need a manually maintained parallel type.
type WidenLiterals<T> = T extends string
	? string
	: T extends readonly (infer U)[]
		? WidenLiterals<U>[]
		: T extends object
			? { [K in keyof T]: WidenLiterals<T[K]> }
			: T;

export type CursorExplicitSdkConfig = WidenLiterals<CursorSdkConfig>;

export interface ResolveCursorSdkConfigOptions {
	cli?: CursorExplicitSdkConfig;
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

const BUILT_IN_CURSOR_CONFIG: Required<Pick<CursorSdkConfig, "runtime">> & {
	cloud: Required<NonNullable<CursorSdkConfig["cloud"]>>;
} = {
	runtime: "local",
	cloud: {
		repo: "",
		branch: "",
		contextHandoff: "fresh",
		directPush: false,
		autoCreatePR: false,
		skipReviewerRequest: false,
		allowLocalState: false,
		envNames: [],
		envFromFiles: false,
		environment: {},
		acknowledged: false,
	},
};

export function isCursorRuntime(value: unknown): value is CursorRuntime {
	return value === "local" || value === "cloud";
}

export function isCursorCloudContextHandoff(value: unknown): value is CursorCloudContextHandoff {
	return value === "never" || value === "fresh" || value === "bootstrap";
}

function validateExplicitValue<T extends string>(
	raw: string | undefined,
	name: string,
	isValid: (value: unknown) => value is T,
	validValues: string,
): T | undefined {
	const value = raw?.trim();
	if (!value) return undefined;
	if (!isValid(value)) throw new Error(`Invalid ${name} "${value}". Use ${validValues}.`);
	return value;
}

export function isCursorCloudEnvironmentType(value: unknown): value is CursorCloudEnvironmentType {
	return value === "cloud" || value === "pool" || value === "machine";
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

export function parseExplicitCursorCloudEnvNames(value: string | undefined, name: string): string[] | undefined {
	const request = parseNonEmptyString(value);
	if (!request) return undefined;
	const parsed = parseEnvNames(request);
	if (!parsed?.length) throw new Error(`Invalid ${name}: no valid environment variable names were requested.`);
	return parsed;
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

	const subagents = parseCursorCustomSubagents(record.subagents);
	if (subagents) config.subagents = subagents;

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
		if (typeof cloud.autoCreatePR === "boolean") parsedCloud.autoCreatePR = cloud.autoCreatePR;
		if (typeof cloud.skipReviewerRequest === "boolean") parsedCloud.skipReviewerRequest = cloud.skipReviewerRequest;
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
		if (typeof local.useHttp1ForAgent === "boolean") parsedLocal.useHttp1ForAgent = local.useHttp1ForAgent;
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

export function loadCursorSdkConfigForUpdate(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	let source: string;
	try {
		source = readFileSync(path, "utf-8");
	} catch (error) {
		throw new Error(`Failed to read Cursor SDK config ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(source);
	} catch {
		throw new Error(`Invalid JSON in Cursor SDK config ${path}`);
	}
	const record = asRecord(parsed);
	if (!record) throw new Error(`Invalid Cursor SDK config ${path}: expected a JSON object`);
	return record;
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

const CONFIG_LOCK_RETRY_MS = 20;
const CONFIG_LOCK_TIMEOUT_MS = 5_000;
const configLockWaitBuffer = new Int32Array(new SharedArrayBuffer(4));

function sleepForConfigLock(): void {
	Atomics.wait(configLockWaitBuffer, 0, 0, CONFIG_LOCK_RETRY_MS);
}

function acquireCursorSdkConfigLock(path: string): () => void {
	mkdirSync(dirname(path), { recursive: true });
	const lockPath = `${path}.lock`;
	const deadline = Date.now() + CONFIG_LOCK_TIMEOUT_MS;
	while (true) {
		try {
			const descriptor = openSync(lockPath, "wx", 0o600);
			return () => {
				try {
					closeSync(descriptor);
				} finally {
					rmSync(lockPath, { force: true });
				}
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (Date.now() >= deadline) {
				throw new Error(`Timed out waiting for Cursor SDK config lock ${lockPath}; remove it only if no pi process is writing this config`);
			}
			sleepForConfigLock();
		}
	}
}

function replaceJsonFile(path: string, config: object, mode?: number): void {
	mkdirSync(dirname(path), { recursive: true });
	const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	let replaced = false;
	try {
		writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, {
			encoding: "utf8",
			flag: "wx",
			...(mode === undefined ? {} : { mode }),
		});
		if (mode !== undefined) chmodSync(tempPath, mode);
		renameSync(tempPath, path);
		replaced = true;
	} finally {
		if (!replaced) {
			try {
				rmSync(tempPath, { force: true });
			} catch {
				// Keep the replacement failure; cleanup is best effort.
			}
		}
	}
}

function withCursorSdkConfigLock<T>(path: string, operation: () => T): T {
	const release = acquireCursorSdkConfigLock(path);
	try {
		return operation();
	} finally {
		release();
	}
}

export function updateCursorSdkConfig(
	path: string,
	update: (current: Record<string, unknown>) => Record<string, unknown>,
	options: { newFileMode?: number } = {},
): Record<string, unknown> {
	return withCursorSdkConfigLock(path, () => {
		const updated = update(loadCursorSdkConfigForUpdate(path));
		const mode = existsSync(path) ? statSync(path).mode & 0o777 : options.newFileMode;
		replaceJsonFile(path, updated, mode);
		return updated;
	});
}

export function saveCursorSdkUserConfig(config: CursorSdkConfig, path = getCursorSdkUserConfigPath()): void {
	updateCursorSdkConfig(path, () => ({ ...config }), { newFileMode: 0o600 });
}

export function saveCursorSdkProjectConfig(cwd: string, config: CursorSdkConfig, configDirName = CONFIG_DIR_NAME): void {
	const path = getCursorSdkProjectConfigPath(cwd, configDirName);
	updateCursorSdkConfig(path, () => ({ ...config }));
}

export function mergeCursorSdkConfig(base: CursorSdkConfig, patch: CursorSdkConfig): CursorSdkConfig {
	return mergeCursorSdkConfigForUpdate({ ...base }, patch) as CursorSdkConfig;
}

export function mergeCursorSdkConfigForUpdate(
	base: Record<string, unknown>,
	patch: CursorSdkConfig,
): Record<string, unknown> {
	const baseCloud = asRecord(base.cloud);
	const baseLocal = asRecord(base.local);
	const baseSandboxOptions = asRecord(baseLocal?.sandboxOptions);
	return {
		...base,
		...patch,
		...(baseCloud || patch.cloud
			? { cloud: { ...baseCloud, ...patch.cloud } }
			: {}),
		...(baseLocal || patch.local
			? {
					local: {
						...baseLocal,
						...patch.local,
						...(baseSandboxOptions || patch.local?.sandboxOptions
							? { sandboxOptions: { ...baseSandboxOptions, ...patch.local?.sandboxOptions } }
							: {}),
					},
				}
			: {}),
	};
}

export function cursorFastDefaultsFromConfig(config: CursorSdkConfig | undefined): Map<string, boolean> {
	return new Map(Object.entries(config?.fastDefaults ?? {}));
}

export function withCursorFastDefaults<T extends object>(
	config: T,
	fastDefaults: Map<string, boolean>,
): T & { fastDefaults: Record<string, boolean> } {
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

// One cap engine for every safety-capped field. `cap` receives the candidate cap layer's raw value and the
// resolved base setting; it returns the value to use once capped, or undefined to mean "don't cap". CLI is
// always uncapped (one-shot, explicit operator intent).
function resolveWithCap<T>(
	baseLayers: Array<CursorResolvedSetting<T> | undefined>,
	capLayer: CursorResolvedSetting<T> | undefined,
	cap: (candidate: T, base: CursorResolvedSetting<T>) => T | undefined,
): CursorResolvedSetting<T> {
	const cli = baseLayers[0];
	if (cli) return cli;
	const base = resolveOrdinary(baseLayers.slice(1));
	if (!capLayer) return base;
	const cappedValue = cap(capLayer.value, base);
	if (cappedValue === undefined) return base;
	return resolved(capLayer.source, cappedValue, {
		source: capLayer.source,
		trustLevel: capLayer.trustLevel,
		value: cappedValue,
		cappedSource: base.source,
		cappedValue: base.value,
		reason: "safer-source",
	});
}

function scalarRiskCap<T>(risk: (value: T) => number): (candidate: T, base: CursorResolvedSetting<T>) => T | undefined {
	return (candidate, base) => (risk(candidate) < risk(base.value) ? candidate : undefined);
}

function envNamesCap(candidate: string[], base: CursorResolvedSetting<string[]>): string[] | undefined {
	if (base.source === "user") return undefined;
	const allowed = new Set(candidate);
	const filtered = base.value.filter((name) => allowed.has(name));
	return filtered.length === base.value.length ? undefined : filtered;
}

// Field/layer resolver table: each field declares the ordered list of sources it participates in (its
// precedence), plus its per-layer values. Sources omitted from a field's order (e.g. cloud fields skip
// "project", local fields skip "session", force skips both) are the field-specific omissions the review
// asked to keep explicit; test/cursor-config.test.ts asserts each one.
type CursorFieldSource = Exclude<CursorConfigSource, "model-alias">;
type CursorFieldValues<T> = Partial<Record<CursorFieldSource, T>>;

const RUNTIME_ORDER: CursorFieldSource[] = ["cli", "environment", "session", "project", "user", "builtin"];
const CLOUD_ORDER: CursorFieldSource[] = ["cli", "environment", "session", "user", "builtin"];
const LOCAL_ORDER: CursorFieldSource[] = ["cli", "environment", "project", "user", "builtin"];
// Subagent definitions are prompt/model records, so they come from config files rather than CLI flags
// or environment strings, and a trusted project layer replaces the user layer whole.
const SUBAGENTS_ORDER: CursorFieldSource[] = ["project", "user", "builtin"];
const LOCAL_FORCE_ORDER: CursorFieldSource[] = ["cli", "environment", "builtin"];
const HTTP1_ORDER: CursorFieldSource[] = ["session", "environment", "user", "builtin"];

function buildFieldLayers<T>(order: CursorFieldSource[], values: CursorFieldValues<T>): Array<CursorResolvedSetting<T> | undefined> {
	return order.map((source) => (source === "builtin" ? resolved("builtin", values.builtin as T) : valueFrom(source, values[source])));
}

function resolveOrdinaryField<T>(order: CursorFieldSource[], values: CursorFieldValues<T>): CursorResolvedSetting<T> {
	return resolveOrdinary(buildFieldLayers(order, values));
}

function resolveSafetyField<T>(order: CursorFieldSource[], values: CursorFieldValues<T>, risk: (value: T) => number): CursorResolvedSetting<T> {
	return resolveWithCap(buildFieldLayers(order, values), valueFrom("user", values.user), scalarRiskCap(risk));
}

function resolveEnvNamesSafetyField(order: CursorFieldSource[], values: CursorFieldValues<string[]>): CursorResolvedSetting<string[]> {
	return resolveWithCap(buildFieldLayers(order, values), valueFrom("user", values.user), envNamesCap);
}

export function cursorSdkConfigFromEnv(env: Record<string, string | undefined> = process.env): CursorSdkConfig {
	const config: CursorSdkConfig = {};
	const runtime = validateExplicitValue(env[CURSOR_RUNTIME_ENV], CURSOR_RUNTIME_ENV, isCursorRuntime, '"local" or "cloud"');
	if (runtime) config.runtime = runtime;
	const repo = parseNonEmptyString(env[CURSOR_CLOUD_REPO_ENV]);
	const branch = parseNonEmptyString(env[CURSOR_CLOUD_BRANCH_ENV]);
	const contextHandoff = validateExplicitValue(
		env[CURSOR_CLOUD_CONTEXT_ENV],
		CURSOR_CLOUD_CONTEXT_ENV,
		isCursorCloudContextHandoff,
		'"never", "fresh", or "bootstrap"',
	);
	const directPush = parseOptionalEnvBoolean(env[CURSOR_CLOUD_DIRECT_PUSH_ENV]);
	const autoCreatePR = parseOptionalEnvBoolean(env[CURSOR_CLOUD_AUTO_CREATE_PR_ENV]);
	const skipReviewerRequest = parseOptionalEnvBoolean(env[CURSOR_CLOUD_SKIP_REVIEWER_REQUEST_ENV]);
	const allowLocalState = parseOptionalEnvBoolean(env[CURSOR_CLOUD_ALLOW_LOCAL_STATE_ENV]);
	const envNames = parseExplicitCursorCloudEnvNames(env[CURSOR_CLOUD_ENV_ENV], CURSOR_CLOUD_ENV_ENV);
	const envFromFiles = parseOptionalEnvBoolean(env[CURSOR_CLOUD_ENV_FROM_FILES_ENV]);
	const environment = parseCloudEnvironment({
		type: env[CURSOR_CLOUD_ENV_TYPE_ENV],
		name: env[CURSOR_CLOUD_ENV_NAME_ENV],
	});
	const acknowledged = parseOptionalEnvBoolean(env[CURSOR_CLOUD_ACK_ENV]);
	if (
		repo !== undefined ||
		branch !== undefined ||
		isCursorCloudContextHandoff(contextHandoff) ||
		directPush !== undefined ||
		autoCreatePR !== undefined ||
		skipReviewerRequest !== undefined ||
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
			...(autoCreatePR !== undefined ? { autoCreatePR } : {}),
			...(skipReviewerRequest !== undefined ? { skipReviewerRequest } : {}),
			...(allowLocalState !== undefined ? { allowLocalState } : {}),
			...(envNames !== undefined ? { envNames } : {}),
			...(envFromFiles !== undefined ? { envFromFiles } : {}),
			...(environment !== undefined ? { environment } : {}),
			...(acknowledged !== undefined ? { acknowledged } : {}),
		};
	}
	const autoReview = parseOptionalEnvBoolean(env[CURSOR_AUTO_REVIEW_ENV]);
	const sandbox = parseOptionalEnvBoolean(env[CURSOR_SANDBOX_ENV]);
	const force = parseOptionalEnvBoolean(env[CURSOR_LOCAL_FORCE_ENV]);
	const resume = parseOptionalEnvBoolean(env[CURSOR_LOCAL_RESUME_ENV]);
	const useHttp1ForAgent = parseOptionalEnvBoolean(env[CURSOR_HTTP1_ENV]);
	if (autoReview !== undefined || sandbox !== undefined || force !== undefined || resume !== undefined || useHttp1ForAgent !== undefined) {
		config.local = {
			...(autoReview !== undefined ? { autoReview } : {}),
			...(sandbox !== undefined ? { sandboxOptions: { enabled: sandbox } } : {}),
			...(force !== undefined ? { force } : {}),
			...(resume !== undefined ? { resume } : {}),
			...(useHttp1ForAgent !== undefined ? { useHttp1ForAgent } : {}),
		};
	}
	return config;
}

export function resolveCursorSdkConfig(options: ResolveCursorSdkConfigOptions = {}): CursorResolvedSdkConfig {
	const cliRuntime = validateExplicitValue(options.cli?.runtime, "--cursor-runtime", isCursorRuntime, '"local" or "cloud"');
	const cliContextHandoff = validateExplicitValue(
		options.cli?.cloud?.contextHandoff,
		"--cursor-cloud-context",
		isCursorCloudContextHandoff,
		'"never", "fresh", or "bootstrap"',
	);
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
		runtime: resolveSafetyField(
			RUNTIME_ORDER,
			{
				cli: cliRuntime,
				environment: env.runtime,
				session: session?.runtime,
				project: project?.runtime,
				user: user?.runtime,
				builtin: builtIn.runtime,
			},
			(value) => (value === "cloud" ? 1 : 0),
		),
		subagents: resolveOrdinaryField(SUBAGENTS_ORDER, {
			project: project?.subagents,
			user: user?.subagents,
			builtin: builtIn.subagents ?? {},
		}),
		cloud: {
			repo: resolveOrdinaryField(CLOUD_ORDER, {
				cli: cli?.cloud?.repo,
				environment: env.cloud?.repo,
				session: session?.cloud?.repo,
				user: user?.cloud?.repo,
				builtin: undefined,
			}),
			branch: resolveOrdinaryField(CLOUD_ORDER, {
				cli: cli?.cloud?.branch,
				environment: env.cloud?.branch,
				session: session?.cloud?.branch,
				user: user?.cloud?.branch,
				builtin: undefined,
			}),
			contextHandoff: resolveSafetyField(
				CLOUD_ORDER,
				{
					cli: cliContextHandoff,
					environment: env.cloud?.contextHandoff,
					session: session?.cloud?.contextHandoff,
					user: user?.cloud?.contextHandoff,
					builtin: builtIn.cloud.contextHandoff,
				},
				(value) => ({ never: 0, fresh: 1, bootstrap: 2 })[value],
			),
			directPush: resolveSafetyField(
				CLOUD_ORDER,
				{
					cli: cli?.cloud?.directPush,
					environment: env.cloud?.directPush,
					session: session?.cloud?.directPush,
					user: user?.cloud?.directPush,
					builtin: builtIn.cloud.directPush,
				},
				(value) => (value ? 1 : 0),
			),
			autoCreatePR: resolveSafetyField(
				CLOUD_ORDER,
				{
					cli: cli?.cloud?.autoCreatePR,
					environment: env.cloud?.autoCreatePR,
					session: session?.cloud?.autoCreatePR,
					user: user?.cloud?.autoCreatePR,
					builtin: builtIn.cloud.autoCreatePR,
				},
				(value) => (value ? 1 : 0),
			),
			skipReviewerRequest: resolveSafetyField(
				CLOUD_ORDER,
				{
					cli: cli?.cloud?.skipReviewerRequest,
					environment: env.cloud?.skipReviewerRequest,
					session: session?.cloud?.skipReviewerRequest,
					user: user?.cloud?.skipReviewerRequest,
					builtin: builtIn.cloud.skipReviewerRequest,
				},
				(value) => (value ? 1 : 0),
			),
			allowLocalState: resolveSafetyField(
				CLOUD_ORDER,
				{
					cli: cli?.cloud?.allowLocalState,
					environment: env.cloud?.allowLocalState,
					session: session?.cloud?.allowLocalState,
					user: user?.cloud?.allowLocalState,
					builtin: builtIn.cloud.allowLocalState,
				},
				(value) => (value ? 1 : 0),
			),
			envNames: resolveEnvNamesSafetyField(CLOUD_ORDER, {
				cli: cli?.cloud?.envNames,
				environment: env.cloud?.envNames,
				session: session?.cloud?.envNames,
				user: user?.cloud?.envNames,
				builtin: builtIn.cloud.envNames,
			}),
			envFromFiles: resolveSafetyField(
				CLOUD_ORDER,
				{
					cli: cli?.cloud?.envFromFiles,
					environment: env.cloud?.envFromFiles,
					session: session?.cloud?.envFromFiles,
					user: user?.cloud?.envFromFiles,
					builtin: builtIn.cloud.envFromFiles,
				},
				(value) => (value ? 1 : 0),
			),
			environment: resolveOrdinaryField(CLOUD_ORDER, {
				cli: cli?.cloud?.environment,
				environment: env.cloud?.environment,
				session: session?.cloud?.environment,
				user: user?.cloud?.environment,
				builtin: undefined,
			}),
			acknowledged: resolveOrdinaryField(CLOUD_ORDER, {
				cli: cli?.cloud?.acknowledged,
				environment: env.cloud?.acknowledged,
				session: session?.cloud?.acknowledged,
				user: user?.cloud?.acknowledged,
				builtin: builtIn.cloud.acknowledged,
			}),
		},
		local: {
			autoReview: resolveOrdinaryField(LOCAL_ORDER, {
				cli: cli?.local?.autoReview,
				environment: env.local?.autoReview,
				project: project?.local?.autoReview,
				user: user?.local?.autoReview,
				builtin: false,
			}),
			sandboxEnabled: resolveOrdinaryField(LOCAL_ORDER, {
				cli: cli?.local?.sandboxOptions?.enabled ?? cli?.local?.sandbox,
				environment: env.local?.sandboxOptions?.enabled ?? env.local?.sandbox,
				project: project?.local?.sandboxOptions?.enabled ?? project?.local?.sandbox,
				user: user?.local?.sandboxOptions?.enabled ?? user?.local?.sandbox,
				builtin: false,
			}),
			force: resolveOrdinaryField(LOCAL_FORCE_ORDER, {
				cli: cli?.local?.force,
				environment: env.local?.force,
				builtin: false,
			}),
			resume: resolveOrdinaryField(LOCAL_ORDER, {
				cli: cli?.local?.resume,
				environment: env.local?.resume,
				project: project?.local?.resume,
				user: user?.local?.resume,
				builtin: true,
			}),
			useHttp1ForAgent: resolveOrdinaryField(HTTP1_ORDER, {
				session: session?.local?.useHttp1ForAgent,
				environment: env.local?.useHttp1ForAgent,
				user: user?.local?.useHttp1ForAgent,
				builtin: false,
			}),
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
