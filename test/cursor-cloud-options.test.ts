import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveCursorSdkConfig } from "../src/cursor-config.js";
import {
	buildCursorCloudAgentOptions,
	formatCursorCloudPreflightError,
	preflightCursorCloudRuntime,
} from "../src/cursor-cloud-options.js";

const OUTSIDE_GIT = { insideGitRepo: false } as const;

describe("Cursor cloud options", () => {
	it("tracks the installed SDK PR-control contract", () => {
		const sdkDist = new URL("../node_modules/@cursor/sdk/dist/esm/", import.meta.url);
		const options = readFileSync(new URL("options.d.ts", sdkDist), "utf8");
		const runtime = readdirSync(sdkDist)
			.filter((name) => name.endsWith(".js"))
			.map((name) => readFileSync(new URL(name, sdkDist), "utf8"))
			.find((source) => source.includes("autoCreatePR:") && source.includes("skipReviewerRequest:"));

		expect(options).toMatch(/autoCreatePR\?: boolean;[\s\S]*?openAsCursorGithubApp\?: boolean;[\s\S]*?skipReviewerRequest\?: boolean;/);
		expect(runtime).toBeDefined();
		if (!runtime) return;
		const autoCreatePrIndex = runtime.indexOf("autoCreatePR:");
		const projection = runtime.slice(
			runtime.lastIndexOf("createAgent(", autoCreatePrIndex),
			runtime.indexOf("idempotencyKey:", autoCreatePrIndex),
		);
		expect(projection).toMatch(/autoCreatePR:[^,}]*\.autoCreatePR/);
		expect(projection).toMatch(/openAsCursorGithubApp:[^,}]*\.openAsCursorGithubApp/);
		expect(projection).toMatch(/skipReviewerRequest:[^,}]*\.skipReviewerRequest/);
	});

	it("builds cloud Agent options without local tools, MCP servers, or agent ids", () => {
		const resolvedConfig = resolveCursorSdkConfig({
			cli: {
				runtime: "cloud",
				cloud: {
					repo: "https://github.com/example/repo.git",
					branch: "feature/demo",
					directPush: true,
					autoCreatePR: true,
					skipReviewerRequest: true,
					environment: { type: "pool", name: "large-linux" },
				},
			},
		});

		const result = buildCursorCloudAgentOptions({
			apiKey: "test-key",
			modelSelection: { id: "composer-2.5" },
			agentMode: "agent",
			resolvedConfig,
			name: "pi session",
		});

		expect(result).toEqual({
			apiKey: "test-key",
			model: { id: "composer-2.5" },
			mode: "agent",
			name: "pi session",
			cloud: {
				env: { type: "pool", name: "large-linux" },
				repos: [{ url: "https://github.com/example/repo.git", startingRef: "feature/demo" }],
				workOnCurrentBranch: true,
				autoCreatePR: true,
				skipReviewerRequest: true,
			},
		});
		expect(result).not.toHaveProperty("local");
		expect(result).not.toHaveProperty("mcpServers");
		expect(result).not.toHaveProperty("agentId");
	});

	it("omits PR controls when unset and maps explicitly configured false values", () => {
		const unset = buildCursorCloudAgentOptions({
			apiKey: "test-key",
			modelSelection: { id: "composer-2.5" },
			agentMode: "agent",
			resolvedConfig: resolveCursorSdkConfig({ env: {} }),
		});
		const configured = buildCursorCloudAgentOptions({
			apiKey: "test-key",
			modelSelection: { id: "composer-2.5" },
			agentMode: "agent",
			resolvedConfig: resolveCursorSdkConfig({
				env: {
					PI_CURSOR_CLOUD_AUTO_CREATE_PR: "0",
					PI_CURSOR_CLOUD_SKIP_REVIEWER_REQUEST: "false",
				},
			}),
		});

		expect(unset.cloud).not.toHaveProperty("autoCreatePR");
		expect(unset.cloud).not.toHaveProperty("skipReviewerRequest");
		expect(configured.cloud).toMatchObject({ autoCreatePR: false, skipReviewerRequest: false });
	});

	it("normalizes refs/heads starting refs for SDK options", () => {
		const resolvedConfig = resolveCursorSdkConfig({
			cli: {
				runtime: "cloud",
				cloud: { acknowledged: true, repo: "https://github.com/example/repo.git", branch: "refs/heads/main" },
			},
		});

		expect(buildCursorCloudAgentOptions({
			apiKey: "test-key",
			modelSelection: { id: "composer-2.5" },
			agentMode: "agent",
			resolvedConfig,
		}).cloud?.repos).toEqual([{ url: "https://github.com/example/repo.git", startingRef: "main" }]);
	});

	it("rejects unsupported refs in preflight and SDK options", () => {
		const resolvedConfig = resolveCursorSdkConfig({
			cli: {
				runtime: "cloud",
				cloud: { acknowledged: true, repo: "https://github.com/example/repo.git", branch: "refs/tags/release" },
			},
		});
		expect(preflightCursorCloudRuntime({ resolvedConfig, localState: OUTSIDE_GIT }).issues.map((issue) => issue.code)).toEqual(["cloud_branch_invalid"]);
		expect(() => buildCursorCloudAgentOptions({
			apiKey: "test-key",
			modelSelection: { id: "composer-2.5" },
			agentMode: "agent",
			resolvedConfig,
		})).toThrow("other refs/* are unsupported");
	});

	it("rejects an invalid Git branch before SDK creation", () => {
		const resolvedConfig = resolveCursorSdkConfig({
			cli: {
				runtime: "cloud",
				cloud: { acknowledged: true, repo: "https://github.com/example/repo.git", branch: "HEAD" },
			},
		});
		expect(preflightCursorCloudRuntime({ resolvedConfig, localState: OUTSIDE_GIT }).issues.map((issue) => issue.code)).toEqual(["cloud_branch_invalid"]);
		expect(() => buildCursorCloudAgentOptions({
			apiKey: "test-key",
			modelSelection: { id: "composer-2.5" },
			agentMode: "agent",
			resolvedConfig,
		})).toThrow("valid Git branch name");
	});

	it("passes a valid Git branch name to the SDK", () => {
		const branch = "feature/demo";
		const resolvedConfig = resolveCursorSdkConfig({
			cli: {
				runtime: "cloud",
				cloud: { acknowledged: true, repo: "https://github.com/example/repo.git", branch },
			},
		});
		expect(buildCursorCloudAgentOptions({
			apiKey: "test-key",
			modelSelection: { id: "composer-2.5" },
			agentMode: "agent",
			resolvedConfig,
		}).cloud?.repos).toEqual([{ url: "https://github.com/example/repo.git", startingRef: branch }]);
	});

	it("passes a full commit SHA to the SDK", () => {
		const sha = "a".repeat(40);
		const resolvedConfig = resolveCursorSdkConfig({
			cli: {
				runtime: "cloud",
				cloud: { acknowledged: true, repo: "https://github.com/example/repo.git", branch: sha },
			},
		});

		expect(buildCursorCloudAgentOptions({
			apiKey: "test-key",
			modelSelection: { id: "composer-2.5" },
			agentMode: "agent",
			resolvedConfig,
		}).cloud?.repos).toEqual([{ url: "https://github.com/example/repo.git", startingRef: sha }]);
	});

	it.each([
		{ directPush: false, label: "branch-only" },
		{ directPush: true, label: "branch plus direct push" },
	])("fails closed for $label config without a repo", ({ directPush }) => {
		const result = preflightCursorCloudRuntime({
			localState: OUTSIDE_GIT,
			resolvedConfig: resolveCursorSdkConfig({
				cli: {
					runtime: "cloud",
					cloud: { acknowledged: true, branch: "feature/demo", directPush },
				},
			}),
		});

		expect(result.ok).toBe(false);
		expect(result.issues.map((issue) => issue.code)).toEqual(["cloud_branch_repo_required"]);
		expect(formatCursorCloudPreflightError(result)).toContain("startingRef only on cloud.repos entries");
	});

	it("accepts a branch when its repo is configured", () => {
		const result = preflightCursorCloudRuntime({
			localState: OUTSIDE_GIT,
			resolvedConfig: resolveCursorSdkConfig({
				cli: {
					runtime: "cloud",
					cloud: {
						acknowledged: true,
						repo: "https://github.com/example/repo.git",
						branch: "feature/demo",
					},
				},
			}),
		});

		expect(result).toEqual({ ok: true, issues: [] });
	});

	it.each([
		["embedded credentials", "https://user:secret@example.com/org/repo.git"],
		["insecure scheme", "http://example.com/org/repo.git"],
		["query credentials", "https://example.com/org/repo.git?token=secret"],
		["backslashes", "https:\\github.com\\example\\repo.git"],
		["path whitespace", "https://example.com/org/repo git"],
		["encoded parent segment", "https://github.com/a/%2e%2e/repo.git"],
		["encoded parent and slash", "https://github.com/a/%2e%2e%2f/repo.git"],
		["encoded backslash", "https://github.com/a/%5c/repo.git"],
		["encoded space", "https://github.com/a/%20/repo.git"],
		["encoded newline", "https://github.com/a/%0a/repo.git"],
		["empty userinfo", "https://@github.com/repo.git"],
		["empty userinfo delimiter", "https://:@github.com/repo.git"],
		["scp transport", "git@example.com:org/repo.git"],
	])("rejects unsafe cloud repository URL with %s without echoing it", (_label, repo) => {
		const resolvedConfig = resolveCursorSdkConfig({
			cli: { runtime: "cloud", cloud: { acknowledged: true, repo } },
		});
		const result = preflightCursorCloudRuntime({ resolvedConfig, localState: OUTSIDE_GIT });
		const message = formatCursorCloudPreflightError(result);

		expect(result.issues.map((issue) => issue.code)).toEqual(["cloud_repo_invalid"]);
		expect(message).toContain("HTTPS repository URL without embedded credentials");
		expect(message).not.toContain(repo);
		expect(() => buildCursorCloudAgentOptions({
			apiKey: "test-key",
			modelSelection: { id: "composer-2.5" },
			agentMode: "agent",
			resolvedConfig,
		})).toThrow("HTTPS repository URL without embedded credentials");
	});

	it("fails closed with exact remediation for missing safety choices and disabled env forwarding", () => {
		const result = preflightCursorCloudRuntime({
			resolvedConfig: resolveCursorSdkConfig({
				cli: { runtime: "cloud", cloud: { envNames: ["SAFE_FLAG"], envFromFiles: true } },
				user: { cloud: { contextHandoff: "never" } },
			}),
			hasPriorContext: true,
			localState: { insideGitRepo: true, dirty: true, comparison: "unpushed" },
		});

		expect(result.ok).toBe(false);
		expect(result.issues.map((issue) => issue.code)).toEqual([
			"cloud_ack_required",
			"context_handoff_required",
			"local_state_not_allowed",
			"env_forwarding_not_implemented",
		]);
		expect(formatCursorCloudPreflightError(result)).toContain(".cursor/environment.json");
		expect(formatCursorCloudPreflightError(result)).toContain("--cursor-runtime local");
	});

	it("fails closed when a cloud environment name is supplied without a type", () => {
		const result = preflightCursorCloudRuntime({
			localState: OUTSIDE_GIT,
			resolvedConfig: resolveCursorSdkConfig({
				cli: { runtime: "cloud", cloud: { acknowledged: true, allowLocalState: true, environment: { name: "gpu-pool" } } },
			}),
		});

		expect(result.ok).toBe(false);
		expect(result.issues.map((issue) => issue.code)).toEqual(["cloud_environment_type_required"]);
		expect(formatCursorCloudPreflightError(result)).toContain("--cursor-cloud-env-type");
	});

	it("fails closed when a named Cursor cloud environment is combined with an explicit repo", () => {
		const result = preflightCursorCloudRuntime({
			localState: OUTSIDE_GIT,
			resolvedConfig: resolveCursorSdkConfig({
				cli: {
					runtime: "cloud",
					cloud: {
						acknowledged: true,
						allowLocalState: true,
						repo: "https://github.com/example/repo.git",
						environment: { type: "cloud", name: "dashboard-env" },
					},
				},
			}),
		});

		expect(result.ok).toBe(false);
		expect(result.issues.map((issue) => issue.code)).toEqual(["cloud_environment_repo_conflict"]);
		expect(formatCursorCloudPreflightError(result)).toContain("cannot be combined with --cursor-cloud-repo");
	});

	it("fails closed when a cloud environment type is invalid", () => {
		const result = preflightCursorCloudRuntime({
			localState: OUTSIDE_GIT,
			resolvedConfig: resolveCursorSdkConfig({
				env: { PI_CURSOR_CLOUD_ENV_TYPE: " poll " },
				cli: { runtime: "cloud", cloud: { acknowledged: true, allowLocalState: true } },
			}),
		});

		expect(result.ok).toBe(false);
		expect(result.issues.map((issue) => issue.code)).toEqual(["cloud_environment_type_invalid"]);
		expect(formatCursorCloudPreflightError(result)).toContain('Invalid Cursor cloud environment type "poll"');
	});

	it("does not require context handoff for a first cloud user prompt", () => {
		const result = preflightCursorCloudRuntime({
			resolvedConfig: resolveCursorSdkConfig({
				cli: {
					runtime: "cloud",
					cloud: { allowLocalState: true, acknowledged: true },
				},
			}),
			hasPriorContext: false,
			localState: { insideGitRepo: true, dirty: true, comparison: "unpushed" },
		});

		expect(result).toEqual({ ok: true, issues: [] });
	});
});
