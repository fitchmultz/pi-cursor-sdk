import type { AgentModeOption, AgentOptions, ModelSelection } from "@cursor/sdk";
import type { CursorCustomSubagentDefinitions } from "./cursor-custom-subagent-definitions.js";
import { isCursorCloudEnvironmentType, type CursorResolvedSdkConfig } from "./cursor-config.js";
import {
	normalizeCursorCloudStartingRef,
	parseCursorCloudRepositoryUrl,
	type CursorCloudLocalState,
	type CursorCloudLocalStateUnknownReason,
} from "./cursor-cloud-local-state.js";

export interface CursorCloudPreflightIssue {
	code:
		| "cloud_ack_required"
		| "context_handoff_required"
		| "local_state_not_allowed"
		| "env_forwarding_not_implemented"
		| "cloud_environment_type_invalid"
		| "cloud_environment_type_required"
		| "cloud_environment_repo_conflict"
		| "cloud_branch_repo_required"
		| "cloud_branch_invalid"
		| "cloud_repo_invalid";
	message: string;
}

export interface CursorCloudPreflightResult {
	ok: boolean;
	issues: CursorCloudPreflightIssue[];
}

const CLOUD_REPO_URL_MESSAGE = "Cursor cloud repository must be an HTTPS repository URL without embedded credentials, query parameters, or fragments.";
const CLOUD_STARTING_REF_MESSAGE = "Cursor cloud branch/ref must be a valid Git branch name, refs/heads/<branch>, or full commit SHA; invalid branch names and other refs/* are unsupported.";
const CLOUD_LOCAL_STATE_REASON_LABELS: Record<CursorCloudLocalStateUnknownReason["code"], string> = {
	bare_repo: "the repository is bare",
	repository_detection_failed: "Git could not determine whether the working directory is a repository",
	status_failed: "Git could not determine whether the worktree or index is clean",
	index_failed: "Git index inspection failed",
	hidden_index_state: "the index hides worktree changes",
	history_probe_failed: "Git could not inspect replacement or graft history overrides",
	history_overrides: "replacement refs or graft metadata are present",
	head_unavailable: "local HEAD is unavailable",
	unverified_target: "the cloud target has no locally verified tracking ref",
	target_probe_failed: "Git failed while resolving the cloud target",
	comparison_failed: "the local HEAD comparison failed",
};

export function buildCursorCloudAgentOptions(options: {
	apiKey: string;
	modelSelection: ModelSelection;
	agentMode: AgentModeOption;
	resolvedConfig: CursorResolvedSdkConfig;
	name?: string;
	customSubagents?: CursorCustomSubagentDefinitions;
}): AgentOptions {
	const { resolvedConfig } = options;
	const environment = resolvedConfig.cloud.environment.value;
	const environmentType = environment?.type;
	const environmentName = environment?.name;
	const configuredRepo = resolvedConfig.cloud.repo.value;
	const repo = parseCursorCloudRepositoryUrl(configuredRepo);
	if (configuredRepo && !repo) throw new Error(CLOUD_REPO_URL_MESSAGE);
	const startingRef = normalizeCursorCloudStartingRef(resolvedConfig.cloud.branch.value);
	if (startingRef.kind === "unsupported") throw new Error(CLOUD_STARTING_REF_MESSAGE);
	const cloud = {
		...(isCursorCloudEnvironmentType(environmentType)
			? {
					env: {
						type: environmentType,
						...(environmentName ? { name: environmentName } : {}),
					},
				}
			: {}),
		...(repo
			? {
					repos: [
						{
							url: repo,
							...(startingRef.kind === "branch" || startingRef.kind === "commit" ? { startingRef: startingRef.value } : {}),
						},
					],
				}
			: {}),
		...(resolvedConfig.cloud.directPush.value ? { workOnCurrentBranch: true } : {}),
		...(resolvedConfig.cloud.autoCreatePR.source !== "builtin"
			? { autoCreatePR: resolvedConfig.cloud.autoCreatePR.value }
			: {}),
		...(resolvedConfig.cloud.skipReviewerRequest.source !== "builtin"
			? { skipReviewerRequest: resolvedConfig.cloud.skipReviewerRequest.value }
			: {}),
	};
	return {
		apiKey: options.apiKey,
		model: options.modelSelection,
		mode: options.agentMode,
		...(options.name ? { name: options.name } : {}),
		...(options.customSubagents ? { agents: options.customSubagents } : {}),
		cloud,
	};
}

export function preflightCursorCloudRuntime(options: {
	resolvedConfig: CursorResolvedSdkConfig;
	localState: CursorCloudLocalState;
	hasPriorContext?: boolean;
}): CursorCloudPreflightResult {
	const { resolvedConfig } = options;
	const issues: CursorCloudPreflightIssue[] = [];
	if (!resolvedConfig.cloud.acknowledged.value) {
		issues.push({
			code: "cloud_ack_required",
			message: "Cursor cloud runtime requires first-use acknowledgement; run /cursor-runtime cloud in an interactive session or pass --cursor-cloud-ack / PI_CURSOR_CLOUD_ACK=1.",
		});
	}
	if (options.hasPriorContext && resolvedConfig.cloud.contextHandoff.value === "never") {
		issues.push({
			code: "context_handoff_required",
			message: "Cursor cloud runtime needs --cursor-cloud-context=fresh or --cursor-cloud-context=bootstrap for sessions with prior pi context.",
		});
	}
	if (
		options.localState.insideGitRepo !== false &&
		(options.localState.dirty !== false || options.localState.comparison !== "contains_head") &&
		!resolvedConfig.cloud.allowLocalState.value
	) {
		const causes: string[] = [];
		if (options.localState.dirty === true) causes.push("the worktree or index is dirty");
		if (options.localState.dirty === "unknown") causes.push("Git could not determine whether the worktree or index is clean");
		if (options.localState.comparison === "unpushed") causes.push("local HEAD contains unpushed commits");
		if (options.localState.comparison === "unknown") {
			causes.push(...options.localState.reasons
				.filter((reason) => reason.code !== "status_failed")
				.map((reason) => CLOUD_LOCAL_STATE_REASON_LABELS[reason.code]));
		}
		issues.push({
			code: "local_state_not_allowed",
			message: `Cursor cloud runtime cannot safely omit local state because ${causes.join("; ")}. Configure an explicit repository branch/ref with current local tracking evidence, or pass --cursor-cloud-allow-local-state only after accepting that risk.`,
		});
	}
	if (resolvedConfig.cloud.envNames.value.length > 0 || resolvedConfig.cloud.envFromFiles.value) {
		issues.push({
			code: "env_forwarding_not_implemented",
			message: "Cursor cloud env forwarding is not implemented; use Cursor-native environment setup such as .cursor/environment.json or dashboard-managed secrets.",
		});
	}
	if (resolvedConfig.cloud.repo.value && !parseCursorCloudRepositoryUrl(resolvedConfig.cloud.repo.value)) {
		issues.push({
			code: "cloud_repo_invalid",
			message: CLOUD_REPO_URL_MESSAGE,
		});
	}
	if (resolvedConfig.cloud.branch.value && !resolvedConfig.cloud.repo.value) {
		issues.push({
			code: "cloud_branch_repo_required",
			message: "Cursor cloud branch/ref requires --cursor-cloud-repo because the installed Cursor SDK supports startingRef only on cloud.repos entries.",
		});
	}
	if (normalizeCursorCloudStartingRef(resolvedConfig.cloud.branch.value).kind === "unsupported") {
		issues.push({ code: "cloud_branch_invalid", message: CLOUD_STARTING_REF_MESSAGE });
	}
	const environment = resolvedConfig.cloud.environment.value;
	if (environment?.type && !isCursorCloudEnvironmentType(environment.type)) {
		issues.push({
			code: "cloud_environment_type_invalid",
			message: `Invalid Cursor cloud environment type "${environment.type}"; expected cloud, pool, or machine.`,
		});
	}
	if (environment?.name && !environment.type) {
		issues.push({
			code: "cloud_environment_type_required",
			message: "Cursor cloud environment name requires --cursor-cloud-env-type=cloud|pool|machine or PI_CURSOR_CLOUD_ENV_TYPE.",
		});
	}
	if (environment?.type === "cloud" && environment.name && resolvedConfig.cloud.repo.value) {
		issues.push({
			code: "cloud_environment_repo_conflict",
			message: "Cursor cloud named environments cannot be combined with --cursor-cloud-repo; omit the repo or use a pool/machine environment.",
		});
	}
	return { ok: issues.length === 0, issues };
}

export function formatCursorCloudPreflightError(result: CursorCloudPreflightResult): string {
	const details = result.issues.map((issue) => `- ${issue.message}`).join("\n");
	return `Cursor cloud runtime is not ready to start.\n${details}\nUse --cursor-runtime local or /cursor-runtime local to run with the local Cursor SDK agent.`;
}
