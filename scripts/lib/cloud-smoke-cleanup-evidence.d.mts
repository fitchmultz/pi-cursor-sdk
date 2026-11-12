import type { CloudSmokeOwnedRepository } from "./cloud-smoke-github.mjs";

export type CloudSmokeLaneName =
	| "cancel"
	| "explicit-https-repo-starting-ref-branch-pr-reporting"
	| "lifecycle-delete"
	| "direct-push-opt-in"
	| "missing-branch-failure"
	| "passive-artifacts-and-raw-usage";

export type CloudSmokeEvidenceBranch = {
	branch: string | null;
	prUrl: string | null;
};

export type CloudSmokeCancelLaneEvidence = {
	name: "cancel";
	status: "passed";
	agentId: string;
	runId: string;
	runIdSource: "metadata" | "agent-list-runs";
	terminalStatus: "cancelled";
	idsCapturedBeforeAbort: true;
};

export type CloudSmokeBranchLaneEvidence = {
	name: "explicit-https-repo-starting-ref-branch-pr-reporting";
	status: "passed";
	agentId: string;
	runId: string;
	branchReportObserved: boolean;
	startingRefAncestryVerified: true;
	remoteContentVerified: true;
	prUrlReturned: boolean;
	branches: CloudSmokeEvidenceBranch[];
	artifactsObserved: boolean;
	rawUsageObserved: boolean;
};

export type CloudSmokeLifecycleDeleteLaneEvidence = {
	name: "lifecycle-delete";
	status: "passed";
	agentId: string;
	runId: string;
	lifecycleDeleteVerified: true;
};

export type CloudSmokeDirectPushLaneEvidence = {
	name: "direct-push-opt-in";
	status: "passed";
	agentId: string;
	runId: string;
	remoteContentChanged: true;
	branches: CloudSmokeEvidenceBranch[];
	artifactsObserved: boolean;
	rawUsageObserved: boolean;
};

export type CloudSmokeMissingBranchLaneEvidence = {
	name: "missing-branch-failure";
	status: "passed";
	expectedFailureObserved: true;
	agentIds: string[];
};

export type CloudSmokePassiveArtifactsLaneEvidence = {
	name: "passive-artifacts-and-raw-usage";
	status: "passed";
	artifactsObserved: boolean;
	rawUsageObserved: boolean;
	observationsValidated: true;
};

export type CloudSmokeLaneEvidence =
	| CloudSmokeCancelLaneEvidence
	| CloudSmokeBranchLaneEvidence
	| CloudSmokeLifecycleDeleteLaneEvidence
	| CloudSmokeDirectPushLaneEvidence
	| CloudSmokeMissingBranchLaneEvidence
	| CloudSmokePassiveArtifactsLaneEvidence;

export type CloudSmokeCleanupEvidence =
	| { agentId: string; alreadyDeleted: true; archiveRequired: false; deleted: true; listExcluded: true }
	| { agentId: string; archived: true; deleted: true; listExcluded: true };

export type CloudSmokeThrowawayRepositoryEvidence = {
	name: string;
	deleted: true;
	httpStatus: 404;
};

export type CloudSmokeEvidenceProvenance = {
	extensionVersion: string;
	cursorSdkVersion: string;
	gitRevision: string;
	packageSourceSha256: string;
};

export type CloudSmokeMatrixEvidence = {
	schemaVersion: 1;
	timestamp: string;
	model: string;
	provenance: CloudSmokeEvidenceProvenance;
	lanes: CloudSmokeLaneEvidence[];
	cleanup: CloudSmokeCleanupEvidence[];
	throwawayRepository: CloudSmokeThrowawayRepositoryEvidence;
};

export type CloudSmokeReleaseGateState = {
	lanes: unknown[];
	/** Assign from `createThrowawayRepository()`'s `onOwned`, which fires once create ownership is established, before seeding. */
	repository?: CloudSmokeOwnedRepository;
};

export function isAgentNotFound(error: unknown): boolean;

export function listCloudAgentIds(
	Agent: {
		list: (options: Record<string, unknown>) => Promise<{ items: Array<{ agentId: string }>; nextCursor?: string }>;
	},
	options?: { apiKey?: string },
): Promise<Set<string>>;

export function assertAgentListExcludes(
	Agent: {
		list: (options: Record<string, unknown>) => Promise<{ items: Array<{ agentId: string }>; nextCursor?: string }>;
	},
	agentId: string,
	options?: { apiKey?: string },
): Promise<void>;

export function assertAgentDeleted(
	Agent: {
		get: (agentId: string, options: Record<string, unknown>) => Promise<unknown>;
		list: (options: Record<string, unknown>) => Promise<{ items: Array<{ agentId: string }>; nextCursor?: string }>;
	},
	agentId: string,
	options?: { apiKey?: string },
): Promise<void>;

export function cleanupCloudAgent(
	Agent: {
		get: (agentId: string, options: Record<string, unknown>) => Promise<{ archived?: boolean }>;
		archive: (agentId: string, options: Record<string, unknown>) => Promise<unknown>;
		delete: (agentId: string, options: Record<string, unknown>) => Promise<unknown>;
		list: (options: Record<string, unknown>) => Promise<{ items: Array<{ agentId: string }>; nextCursor?: string }>;
	},
	agentId: string,
	options?: { apiKey?: string },
): Promise<CloudSmokeCleanupEvidence>;

export function assertCloudSmokeEvidenceSafe(summary: unknown, apiKey?: string): string;

export function projectCloudSmokeMatrixEvidence(input?: {
	model?: string;
	lanes?: unknown[];
	cleanup?: unknown[];
	throwawayRepository?: unknown;
	provenance?: unknown;
	timestamp?: string;
	schemaVersion?: number;
}): CloudSmokeMatrixEvidence;

export function validateCloudSmokeMatrixEvidence(input: unknown): CloudSmokeMatrixEvidence;

export function listCloudSmokePackageSourcePaths(options?: {
	root?: string;
	readFileSync?: typeof import("node:fs").readFileSync;
	lstatSync?: typeof import("node:fs").lstatSync;
	readdirSync?: typeof import("node:fs").readdirSync;
}): string[];

export function buildCloudSmokeEvidenceProvenance(options?: {
	root?: string;
	packageSourcePaths?: readonly string[];
	gitRevision?: string;
	readFileSync?: typeof import("node:fs").readFileSync;
	lstatSync?: typeof import("node:fs").lstatSync;
	readdirSync?: typeof import("node:fs").readdirSync;
	spawnSync?: typeof import("node:child_process").spawnSync;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
}): CloudSmokeEvidenceProvenance;

export function coordinateCloudSmokeReleaseGate(callbacks: {
	throwIfInterrupted?: () => void;
	run: (state: CloudSmokeReleaseGateState) => void | Promise<void>;
	harvestAgentIds: (state: CloudSmokeReleaseGateState) => Iterable<string> | Promise<Iterable<string>>;
	cleanupAgent: (agentId: string) => CloudSmokeCleanupEvidence | Promise<CloudSmokeCleanupEvidence>;
	cleanupRepository?: (repository: CloudSmokeOwnedRepository) =>
		| { deleted: true; httpStatus: 404 }
		| Promise<{ deleted: true; httpStatus: 404 }>;
	writeEvidence: (input: {
		lanes: unknown[];
		cleanup: CloudSmokeCleanupEvidence[];
		throwawayRepository?: CloudSmokeThrowawayRepositoryEvidence;
	}) => void | Promise<void>;
	onAgentCleanupError?: (error: unknown, agentId: string) => void;
	/** Receives the exact residual repository when deletion fails or is not proven. */
	onRepositoryCleanupError?: (error: unknown, repository: CloudSmokeOwnedRepository) => void;
}): Promise<{
	lanes: unknown[];
	cleanup: CloudSmokeCleanupEvidence[];
	throwawayRepository?: CloudSmokeThrowawayRepositoryEvidence;
}>;
