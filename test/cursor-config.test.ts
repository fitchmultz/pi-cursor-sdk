import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CURSOR_AUTO_REVIEW_ENV,
	CURSOR_CLOUD_ALLOW_LOCAL_STATE_ENV,
	CURSOR_CLOUD_BRANCH_ENV,
	CURSOR_CLOUD_CONTEXT_ENV,
	CURSOR_CLOUD_DIRECT_PUSH_ENV,
	CURSOR_CLOUD_ENV_ENV,
	CURSOR_CLOUD_ENV_FROM_FILES_ENV,
	CURSOR_CLOUD_ENV_NAME_ENV,
	CURSOR_CLOUD_ENV_TYPE_ENV,
	CURSOR_CLOUD_ACK_ENV,
	CURSOR_CLOUD_REPO_ENV,
	CURSOR_RUNTIME_ENV,
	CURSOR_SANDBOX_ENV,
	CURSOR_LOCAL_FORCE_ENV,
	CURSOR_LOCAL_RESUME_ENV,
	cursorFastDefaultsFromConfig,
	getCursorSdkProjectConfigPath,
	getCursorSdkUserConfigPath,
	loadCursorSdkConfig,
	loadCursorSdkUserConfig,
	mergeCursorSdkConfig,
	resolveCursorFastDefault,
	resolveCursorSdkConfig,
	saveCursorSdkUserConfig,
	withCursorFastDefaults,
} from "../src/cursor-config.js";

describe("Cursor SDK config resolver", () => {
	let root: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-cursor-config-"));
		agentDir = join(root, "agent");
		cwd = join(root, "repo");
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("resolves ordinary settings by CLI, env, trusted project, user, built-in order", () => {
		const user = { runtime: "cloud" as const };
		const project = { runtime: "local" as const };

		expect(resolveCursorSdkConfig({ user }).runtime).toMatchObject({ value: "cloud", source: "user", trustLevel: "user" });
		expect(resolveCursorSdkConfig({ user, project }).runtime).toMatchObject({
			value: "local",
			source: "project",
			trustLevel: "trusted-project",
		});
		expect(resolveCursorSdkConfig({ env: { [CURSOR_RUNTIME_ENV]: "cloud" }, user, project }).runtime).toMatchObject({
			value: "cloud",
			source: "environment",
		});
		expect(
			resolveCursorSdkConfig({ cli: { runtime: "local" }, env: { [CURSOR_RUNTIME_ENV]: "cloud" }, user, project }).runtime,
		).toMatchObject({ value: "local", source: "cli", trustLevel: "one-shot" });
		expect(resolveCursorSdkConfig().runtime).toMatchObject({ value: "local", source: "builtin" });
	});

	it("keeps legacy fastDefaults shape compatible and writes user config as 0600", () => {
		const path = getCursorSdkUserConfigPath(agentDir);
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(path, JSON.stringify({ fastDefaults: { "composer-2": false, bad: "true" } }));

		const config = loadCursorSdkUserConfig(path);
		expect(cursorFastDefaultsFromConfig(config)).toEqual(new Map([["composer-2", false]]));

		const savedPath = join(agentDir, "saved-cursor-sdk.json");
		saveCursorSdkUserConfig(withCursorFastDefaults(config, new Map([["composer-2", true]])), savedPath);
		expect(JSON.parse(readFileSync(savedPath, "utf-8"))).toEqual({ fastDefaults: { "composer-2": true } });
		if (process.platform !== "win32") expect(statSync(savedPath).mode & 0o777).toBe(0o600);
	});

	it("preserves current fast precedence through the resolver", () => {
		expect(resolveCursorFastDefault({ cliForceFast: true, aliasOverride: false, sessionValue: false, userValue: false, modelDefault: false })).toMatchObject({
			value: true,
			source: "cli",
		});
		expect(resolveCursorFastDefault({ aliasOverride: false, sessionValue: true, userValue: true, modelDefault: true })).toMatchObject({
			value: false,
			source: "model-alias",
		});
		expect(resolveCursorFastDefault({ sessionValue: false, userValue: true, modelDefault: true })).toMatchObject({
			value: false,
			source: "session",
		});
		expect(resolveCursorFastDefault({ userValue: false, modelDefault: true })).toMatchObject({ value: false, source: "user" });
		expect(resolveCursorFastDefault({ modelDefault: true })).toMatchObject({ value: true, source: "builtin" });
	});

	it("trust-gates project config loading through the caller's project trust state", () => {
		const projectPath = getCursorSdkProjectConfigPath(cwd);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(projectPath, JSON.stringify({ runtime: "cloud" }));

		expect(loadCursorSdkConfig({ cwd, agentDir, projectTrusted: false })).toEqual({ user: {} });
		expect(loadCursorSdkConfig({ cwd, agentDir, projectTrusted: true })).toEqual({ user: {}, project: { runtime: "cloud" } });
	});

	it("keeps explicit env safety allows above project defaults", () => {
		const resolved = resolveCursorSdkConfig({
			env: { [CURSOR_CLOUD_DIRECT_PUSH_ENV]: "true" },
			project: { cloud: { directPush: false } },
		}).cloud.directPush;

		expect(resolved).toMatchObject({ value: true, source: "environment", trustLevel: "environment" });
		expect(resolved).not.toHaveProperty("cappedBy");
	});

	it("caps project cloud runtime with user local runtime denial", () => {
		const projectCloud = resolveCursorSdkConfig({
			project: { runtime: "cloud" },
			user: { runtime: "local" },
		}).runtime;
		const cliCloud = resolveCursorSdkConfig({
			cli: { runtime: "cloud" },
			user: { runtime: "local" },
		}).runtime;

		expect(projectCloud).toMatchObject({ value: "local", source: "user" });
		expect(projectCloud.cappedBy).toMatchObject({ source: "user", cappedSource: "project", cappedValue: "cloud" });
		expect(cliCloud).toMatchObject({ value: "cloud", source: "cli" });
		expect(cliCloud).not.toHaveProperty("cappedBy");
	});

	it("applies user safety caps over explicit env allows", () => {
		const resolved = resolveCursorSdkConfig({
			env: { [CURSOR_CLOUD_DIRECT_PUSH_ENV]: "true" },
			user: { cloud: { directPush: false } },
		}).cloud.directPush;

		expect(resolved).toMatchObject({ value: false, source: "user", trustLevel: "user" });
		expect(resolved.cappedBy).toMatchObject({ source: "user", cappedSource: "environment", cappedValue: true });
	});

	it("ignores project cloud override and safety keys in the initial runtime", () => {
		const resolved = resolveCursorSdkConfig({
			project: {
				cloud: {
					repo: "project-repo",
					branch: "project-branch",
					contextHandoff: "bootstrap",
					directPush: true,
					allowLocalState: true,
					envNames: ["GH_TOKEN"],
					envFromFiles: true,
					environment: { type: "pool", name: "project-pool" },
					acknowledged: true,
				},
			},
		}).cloud;

		expect(resolved.repo).toMatchObject({ value: undefined, source: "builtin" });
		expect(resolved.branch).toMatchObject({ value: undefined, source: "builtin" });
		expect(resolved.contextHandoff).toMatchObject({ value: "fresh", source: "builtin" });
		expect(resolved.directPush).toMatchObject({ value: false, source: "builtin" });
		expect(resolved.allowLocalState).toMatchObject({ value: false, source: "builtin" });
		expect(resolved.envNames).toMatchObject({ value: [], source: "builtin" });
		expect(resolved.envFromFiles).toMatchObject({ value: false, source: "builtin" });
		expect(resolved.environment).toMatchObject({ value: undefined, source: "builtin" });
		expect(resolved.acknowledged).toMatchObject({ value: false, source: "builtin" });
	});

	it("lets explicit one-shot CLI safety allows override user denials", () => {
		const resolved = resolveCursorSdkConfig({
			cli: { cloud: { contextHandoff: "bootstrap", directPush: true, allowLocalState: true, envFromFiles: true } },
			env: { [CURSOR_CLOUD_CONTEXT_ENV]: "fresh" },
			user: { cloud: { contextHandoff: "never", directPush: false, allowLocalState: false, envFromFiles: false } },
		}).cloud;

		expect(resolved.contextHandoff).toMatchObject({ value: "bootstrap", source: "cli" });
		expect(resolved.contextHandoff).not.toHaveProperty("cappedBy");
		expect(resolved.directPush).toMatchObject({ value: true, source: "cli" });
		expect(resolved.directPush).not.toHaveProperty("cappedBy");
		expect(resolved.allowLocalState).toMatchObject({ value: true, source: "cli" });
		expect(resolved.allowLocalState).not.toHaveProperty("cappedBy");
		expect(resolved.envFromFiles).toMatchObject({ value: true, source: "cli" });
		expect(resolved.envFromFiles).not.toHaveProperty("cappedBy");
	});

	it("filters env cloud env names through the user allowlist unless CLI explicitly overrides", () => {
		const envFiltered = resolveCursorSdkConfig({
			env: { [CURSOR_CLOUD_ENV_ENV]: "GH_TOKEN,NODE_ENV" },
			user: { cloud: { envNames: ["NODE_ENV"] } },
		}).cloud.envNames;
		const cliOverride = resolveCursorSdkConfig({
			cli: { cloud: { envNames: ["GH_TOKEN"] } },
			user: { cloud: { envNames: ["NODE_ENV"] } },
		}).cloud.envNames;

		expect(envFiltered).toMatchObject({ value: ["NODE_ENV"], source: "user" });
		expect(envFiltered.cappedBy).toMatchObject({ source: "user", cappedSource: "environment", cappedValue: ["GH_TOKEN", "NODE_ENV"] });
		expect(cliOverride).toMatchObject({ value: ["GH_TOKEN"], source: "cli" });
		expect(cliOverride).not.toHaveProperty("cappedBy");
	});

	it("resolves remaining cloud scaffold keys from env without secret values", () => {
		const resolved = resolveCursorSdkConfig({
			env: {
				[CURSOR_CLOUD_REPO_ENV]: " https://github.com/acme/repo ",
				[CURSOR_CLOUD_BRANCH_ENV]: " main ",
				[CURSOR_CLOUD_ALLOW_LOCAL_STATE_ENV]: "true",
				[CURSOR_CLOUD_ENV_ENV]: "GH_TOKEN,CURSOR_SECRET,bad-name, NODE_ENV ,GH_TOKEN",
				[CURSOR_CLOUD_ENV_FROM_FILES_ENV]: "1",
				[CURSOR_CLOUD_ENV_TYPE_ENV]: " pool ",
				[CURSOR_CLOUD_ENV_NAME_ENV]: " large-linux ",
				[CURSOR_CLOUD_ACK_ENV]: "1",
			},
		}).cloud;

		expect(resolved.repo).toMatchObject({ value: "https://github.com/acme/repo", source: "environment" });
		expect(resolved.branch).toMatchObject({ value: "main", source: "environment" });
		expect(resolved.allowLocalState).toMatchObject({ value: true, source: "environment" });
		expect(resolved.envNames).toMatchObject({ value: ["GH_TOKEN", "NODE_ENV"], source: "environment" });
		expect(resolved.envFromFiles).toMatchObject({ value: true, source: "environment" });
		expect(resolved.environment).toMatchObject({ value: { type: "pool", name: "large-linux" }, source: "environment" });
		expect(resolved.acknowledged).toMatchObject({ value: true, source: "environment" });
	});

	it("resolves cloud environment atomically from one source", () => {
		const resolved = resolveCursorSdkConfig({
			env: { [CURSOR_CLOUD_ENV_NAME_ENV]: "gpu-pool" },
			user: { cloud: { environment: { type: "pool" } } },
		}).cloud;

		expect(resolved.environment).toMatchObject({ value: { name: "gpu-pool" }, source: "environment" });
	});

	it("preserves invalid explicit cloud environment types for preflight", () => {
		const resolved = resolveCursorSdkConfig({
			env: { [CURSOR_CLOUD_ENV_TYPE_ENV]: " poll " },
		}).cloud;

		expect(resolved.environment).toMatchObject({ value: { type: "poll" }, source: "environment" });
	});

	it("preserves invalid cloud environment type across unrelated save and reload", () => {
		mkdirSync(agentDir, { recursive: true });
		const path = getCursorSdkUserConfigPath(agentDir);
		writeFileSync(path, `${JSON.stringify({ cloud: { environment: { type: "poll" } } }, null, 2)}\n`);

		const loaded = loadCursorSdkUserConfig(path);
		saveCursorSdkUserConfig(mergeCursorSdkConfig(loaded, { runtime: "cloud" }), path);

		expect(JSON.parse(readFileSync(path, "utf8")).cloud.environment).toEqual({ type: "poll" });
		expect(loadCursorSdkUserConfig(path).cloud?.environment).toEqual({ type: "poll" });
	});

	it("merges nested cursor sdk config", () => {
		expect(
			mergeCursorSdkConfig(
				{ runtime: "local", cloud: { repo: "repo", environment: { type: "pool" }, acknowledged: false }, local: { sandboxOptions: { enabled: true } } },
				{ runtime: "cloud", cloud: { environment: { name: "gpu" }, acknowledged: true }, local: { autoReview: true } },
			),
		).toEqual({
			runtime: "cloud",
			cloud: { repo: "repo", environment: { name: "gpu" }, acknowledged: true },
			local: { sandboxOptions: { enabled: true }, autoReview: true },
		});
	});

	it("lets session runtime override config but not CLI or env", () => {
		expect(resolveCursorSdkConfig({ session: { runtime: "cloud" }, project: { runtime: "local" } }).runtime).toMatchObject({
			value: "cloud",
			source: "session",
		});
		expect(resolveCursorSdkConfig({ env: { [CURSOR_RUNTIME_ENV]: "local" }, session: { runtime: "cloud" } }).runtime).toMatchObject({
			value: "local",
			source: "environment",
		});
		expect(resolveCursorSdkConfig({ cli: { runtime: "local" }, session: { runtime: "cloud" } }).runtime).toMatchObject({
			value: "local",
			source: "cli",
		});
	});

	it("resolves local safety controls by CLI, env, project, user, built-in order", () => {
		const user = { local: { autoReview: true, sandboxOptions: { enabled: true }, force: true, resume: true } };
		const project = { local: { autoReview: false, sandbox: false, force: true, resume: false } };

		expect(resolveCursorSdkConfig().local.autoReview).toMatchObject({ value: false, source: "builtin" });
		expect(resolveCursorSdkConfig().local.force).toMatchObject({ value: false, source: "builtin" });
		expect(resolveCursorSdkConfig().local.resume).toMatchObject({ value: true, source: "builtin" });
		expect(resolveCursorSdkConfig({ user }).local.sandboxEnabled).toMatchObject({ value: true, source: "user" });
		expect(resolveCursorSdkConfig({ user, project }).local.autoReview).toMatchObject({ value: false, source: "project" });
		expect(resolveCursorSdkConfig({ user, project }).local.force).toMatchObject({ value: false, source: "builtin" });
		expect(resolveCursorSdkConfig({ user, project }).local.resume).toMatchObject({ value: false, source: "project" });
		expect(
			resolveCursorSdkConfig({
				env: { [CURSOR_AUTO_REVIEW_ENV]: "1", [CURSOR_SANDBOX_ENV]: "true", [CURSOR_LOCAL_FORCE_ENV]: "1", [CURSOR_LOCAL_RESUME_ENV]: "1" },
				user,
				project,
			}).local,
		).toMatchObject({
			autoReview: expect.objectContaining({ value: true, source: "environment" }),
			sandboxEnabled: expect.objectContaining({ value: true, source: "environment" }),
			force: expect.objectContaining({ value: true, source: "environment" }),
			resume: expect.objectContaining({ value: true, source: "environment" }),
		});
		expect(
			resolveCursorSdkConfig({
				cli: { local: { autoReview: false, sandboxOptions: { enabled: false }, force: false, resume: false } },
				env: { [CURSOR_AUTO_REVIEW_ENV]: "1", [CURSOR_SANDBOX_ENV]: "1", [CURSOR_LOCAL_FORCE_ENV]: "1", [CURSOR_LOCAL_RESUME_ENV]: "1" },
				user,
				project,
			}).local,
		).toMatchObject({
			autoReview: expect.objectContaining({ value: false, source: "cli" }),
			sandboxEnabled: expect.objectContaining({ value: false, source: "cli" }),
			force: expect.objectContaining({ value: false, source: "cli" }),
			resume: expect.objectContaining({ value: false, source: "cli" }),
		});
	});
});
