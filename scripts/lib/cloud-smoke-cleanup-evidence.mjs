import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { CLOUD_AGENT_ID_PATTERN } from "../../shared/cursor-cloud-lifecycle-constants.mjs";
import { scrubSensitiveText } from "../../shared/cursor-sensitive-text.mjs";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CLOUD_RUN_ID_PATTERN = /^run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PACKAGE_SOURCE_SHA256_PATTERN = /^[a-f0-9]{64}$/;

const LANE_NAMES = Object.freeze([
	"cancel",
	"explicit-https-repo-starting-ref-branch-pr-reporting",
	"lifecycle-delete",
	"direct-push-opt-in",
	"missing-branch-failure",
	"passive-artifacts-and-raw-usage",
]);

function fail(message, details = "") {
	const error = new Error(message);
	error.details = details;
	error.isCloudSmokeFailure = true;
	throw error;
}

function requireObject(value, label) {
	if (!value || typeof value !== "object" || Array.isArray(value)) fail(`cloud smoke evidence ${label} must be an object`);
	return value;
}

function requireString(value, label) {
	if (typeof value !== "string" || value.length === 0) fail(`cloud smoke evidence ${label} must be a non-empty string`);
	return value;
}

function requireBoolean(value, label) {
	if (typeof value !== "boolean") fail(`cloud smoke evidence ${label} must be a boolean`);
	return value;
}

function requireTrue(value, label) {
	if (value !== true) fail(`cloud smoke evidence ${label} must be true`);
	return true;
}

function requireStatus(value, label) {
	if (value !== "passed") fail(`cloud smoke evidence ${label} must be "passed"`);
	return value;
}

function requireAgentId(value, label) {
	const agentId = requireString(value, label);
	if (!CLOUD_AGENT_ID_PATTERN.test(agentId)) fail(`cloud smoke evidence ${label} must be an exact cloud agent id`);
	return agentId;
}

function requireRunId(value, label) {
	const runId = requireString(value, label);
	if (!CLOUD_RUN_ID_PATTERN.test(runId)) fail(`cloud smoke evidence ${label} must be an exact cloud run id`);
	return runId;
}

function requireAgentIds(value, label) {
	if (!Array.isArray(value) || value.length > 5) fail(`cloud smoke evidence ${label} must be an array of at most 5 agent IDs`);
	const agentIds = value.map((agentId, index) => requireAgentId(agentId, `${label}[${index}]`));
	if (new Set(agentIds).size !== agentIds.length) fail(`cloud smoke evidence ${label} must contain unique agent IDs`);
	return agentIds;
}

function requireIsoTimestamp(value, label) {
	const timestamp = requireString(value, label);
	if (Number.isNaN(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp) {
		fail(`cloud smoke evidence ${label} must be a canonical ISO timestamp`);
	}
	return timestamp;
}

function requirePackageSourceSha256(value, label) {
	const hash = requireString(value, label);
	if (!PACKAGE_SOURCE_SHA256_PATTERN.test(hash)) fail(`cloud smoke evidence ${label} must be a sha256 hex digest`);
	return hash;
}

function normalizeRelativePath(value) {
	const normalized = String(value).replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
	if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => part === ".." || part === "")) {
		fail(`published package path is unsafe: ${value}`);
	}
	return normalized;
}

function projectBranches(report) {
	if (!report) return [];
	if (!Array.isArray(report.branches) || report.branches.length > 5) {
		fail("cloud smoke evidence report.branches must be an array of at most 5 entries when present");
	}
	return report.branches.map((branch, index) => {
		requireObject(branch, `report.branches[${index}]`);
		const branchName = branch.branch == null ? null : requireString(branch.branch, `report.branches[${index}].branch`);
		const prUrl = branch.prUrl == null ? null : requireString(branch.prUrl, `report.branches[${index}].prUrl`);
		if (branchName && branchName.length > 240) fail(`cloud smoke evidence report.branches[${index}].branch is too long`);
		if (prUrl && (prUrl.length > 500 || !prUrl.startsWith("https://github.com/"))) {
			fail(`cloud smoke evidence report.branches[${index}].prUrl must be a bounded GitHub URL`);
		}
		return { branch: branchName, prUrl };
	});
}

function artifactsObservedFromReport(report) {
	return Boolean(report && Array.isArray(report.artifacts) && report.artifacts.length > 0);
}

function rawUsageObservedFromReport(report) {
	return Boolean(report && report.usage && typeof report.usage === "object" && !Array.isArray(report.usage) && Object.keys(report.usage).length > 0);
}

function projectRawLane(lane, index) {
	const input = requireObject(lane, `lanes[${index}]`);
	const name = requireString(input.name, `lanes[${index}].name`);
	if (!LANE_NAMES.includes(name)) fail(`cloud smoke evidence unknown lane: ${name}`);
	const status = requireStatus(input.status, `lanes[${index}].status`);
	switch (name) {
		case "cancel":
			if (input.terminalStatus !== "cancelled") fail(`cloud smoke evidence lanes[${index}].terminalStatus must be "cancelled"`);
			if (input.runIdSource !== "metadata" && input.runIdSource !== "agent-list-runs") {
				fail(`cloud smoke evidence lanes[${index}].runIdSource must be metadata or agent-list-runs`);
			}
			return {
				name,
				status,
				agentId: requireAgentId(input.agentId, `lanes[${index}].agentId`),
				runId: requireRunId(input.runId, `lanes[${index}].runId`),
				runIdSource: input.runIdSource,
				terminalStatus: "cancelled",
				idsCapturedBeforeAbort: requireTrue(input.idsCapturedBeforeAbort, `lanes[${index}].idsCapturedBeforeAbort`),
			};
		case "explicit-https-repo-starting-ref-branch-pr-reporting":
			return {
				name,
				status,
				agentId: requireAgentId(input.agentId, `lanes[${index}].agentId`),
				runId: requireRunId(input.runId, `lanes[${index}].runId`),
				branchReportObserved: requireBoolean(input.branchReportObserved, `lanes[${index}].branchReportObserved`),
				startingRefAncestryVerified: requireTrue(input.startingRefAncestryVerified, `lanes[${index}].startingRefAncestryVerified`),
				remoteContentVerified: requireTrue(input.remoteContentVerified, `lanes[${index}].remoteContentVerified`),
				prUrlReturned: requireBoolean(input.prUrlReturned, `lanes[${index}].prUrlReturned`),
				branches: projectBranches(input.report),
				artifactsObserved: artifactsObservedFromReport(input.report),
				rawUsageObserved: rawUsageObservedFromReport(input.report),
			};
		case "lifecycle-delete":
			return {
				name,
				status,
				agentId: requireAgentId(input.agentId, `lanes[${index}].agentId`),
				runId: requireRunId(input.runId, `lanes[${index}].runId`),
				lifecycleDeleteVerified: requireTrue(input.lifecycleDeleteVerified, `lanes[${index}].lifecycleDeleteVerified`),
			};
		case "direct-push-opt-in":
			return {
				name,
				status,
				agentId: requireAgentId(input.agentId, `lanes[${index}].agentId`),
				runId: requireRunId(input.runId, `lanes[${index}].runId`),
				remoteContentChanged: requireTrue(input.remoteContentChanged, `lanes[${index}].remoteContentChanged`),
				branches: projectBranches(input.report),
				artifactsObserved: artifactsObservedFromReport(input.report),
				rawUsageObserved: rawUsageObservedFromReport(input.report),
			};
		case "missing-branch-failure":
			return {
				name,
				status,
				expectedFailureObserved: requireTrue(input.expectedFailureObserved, `lanes[${index}].expectedFailureObserved`),
				agentIds: requireAgentIds(input.agentIds, `lanes[${index}].agentIds`),
			};
		case "passive-artifacts-and-raw-usage":
			return {
				name,
				status,
				artifactsObserved: requireBoolean(input.artifactsObserved, `lanes[${index}].artifactsObserved`),
				rawUsageObserved: requireBoolean(input.rawUsageObserved, `lanes[${index}].rawUsageObserved`),
				observationsValidated: requireTrue(input.observationsValidated, `lanes[${index}].observationsValidated`),
			};
		default:
			fail(`cloud smoke evidence unknown lane: ${name}`);
	}
}

function projectCleanupEntry(entry, index) {
	const input = requireObject(entry, `cleanup[${index}]`);
	const agentId = requireAgentId(input.agentId, `cleanup[${index}].agentId`);
	if (input.alreadyDeleted === true) {
		if (input.archiveRequired !== false || input.deleted !== true || input.listExcluded !== true) {
			fail(`cloud smoke evidence cleanup[${index}] already-deleted proof is malformed`);
		}
		return {
			agentId,
			alreadyDeleted: true,
			archiveRequired: false,
			deleted: true,
			listExcluded: true,
		};
	}
	if (input.archived !== true || input.deleted !== true || input.listExcluded !== true) {
		fail(`cloud smoke evidence cleanup[${index}] archive-delete proof is malformed`);
	}
	return {
		agentId,
		archived: true,
		deleted: true,
		listExcluded: true,
	};
}

function projectThrowawayRepository(value) {
	const input = requireObject(value, "throwawayRepository");
	if (input.deleted !== true || input.httpStatus !== 404) {
		fail("cloud smoke evidence throwawayRepository must prove deleted:true with httpStatus 404");
	}
	const name = requireString(input.name, "throwawayRepository.name");
	if (!/^[^/]+\/pi-cursor-cloud-smoke-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(name)) {
		fail("cloud smoke evidence throwawayRepository.name must match the owned smoke repository shape");
	}
	return { name, deleted: true, httpStatus: 404 };
}

function projectProvenance(value) {
	const input = requireObject(value, "provenance");
	const extensionVersion = requireString(input.extensionVersion, "provenance.extensionVersion");
	const cursorSdkVersion = requireString(input.cursorSdkVersion, "provenance.cursorSdkVersion");
	const gitRevision = requireString(input.gitRevision, "provenance.gitRevision");
	if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(extensionVersion)) fail("cloud smoke evidence provenance.extensionVersion must be a version");
	if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(cursorSdkVersion)) fail("cloud smoke evidence provenance.cursorSdkVersion must be a version");
	if (!/^[a-f0-9]{40}$/.test(gitRevision)) fail("cloud smoke evidence provenance.gitRevision must be a full git revision");
	return {
		extensionVersion,
		cursorSdkVersion,
		gitRevision,
		packageSourceSha256: requirePackageSourceSha256(input.packageSourceSha256, "provenance.packageSourceSha256"),
	};
}

export function isAgentNotFound(error) {
	const text = `${error?.name ?? ""} ${error?.code ?? ""} ${error?.status ?? error?.statusCode ?? ""} ${error?.message ?? error ?? ""}`;
	return /AgentNotFound|agent_not_found|\b404\b/i.test(text);
}

export async function listCloudAgentIds(Agent, options = {}) {
	const apiKey = options.apiKey ?? process.env.CURSOR_API_KEY;
	const ids = new Set();
	const seenCursors = new Set();
	let cursor;
	do {
		if (cursor && seenCursors.has(cursor)) fail("Agent.list returned a repeated pagination cursor during cleanup verification");
		if (cursor) seenCursors.add(cursor);
		const page = await Agent.list({
			runtime: "cloud",
			includeArchived: true,
			apiKey,
			limit: 100,
			...(cursor ? { cursor } : {}),
		});
		for (const item of page.items) if (CLOUD_AGENT_ID_PATTERN.test(item.agentId)) ids.add(item.agentId);
		cursor = page.nextCursor;
	} while (cursor);
	return ids;
}

export async function assertAgentListExcludes(Agent, agentId, options = {}) {
	if ((await listCloudAgentIds(Agent, options)).has(agentId)) fail(`deleted cloud agent ${agentId} remained in Agent.list`);
}

export async function assertAgentDeleted(Agent, agentId, options = {}) {
	const apiKey = options.apiKey ?? process.env.CURSOR_API_KEY;
	try {
		await Agent.get(agentId, { apiKey });
		fail(`Agent.get still returned deleted cloud agent ${agentId}`);
	} catch (error) {
		if (error?.isCloudSmokeFailure || !isAgentNotFound(error)) throw error;
	}
	await assertAgentListExcludes(Agent, agentId, options);
}

export async function cleanupCloudAgent(Agent, agentId, options = {}) {
	const apiKey = options.apiKey ?? process.env.CURSOR_API_KEY;
	let existing;
	try {
		existing = await Agent.get(agentId, { apiKey });
	} catch (error) {
		if (!isAgentNotFound(error)) throw error;
		await assertAgentListExcludes(Agent, agentId, options);
		return { agentId, alreadyDeleted: true, archiveRequired: false, deleted: true, listExcluded: true };
	}
	if (existing.archived !== true) await Agent.archive(agentId, { apiKey });
	const archived = await Agent.get(agentId, { apiKey });
	if (archived.archived !== true) fail(`cloud agent ${agentId} did not report archived:true`);
	await Agent.delete(agentId, { apiKey });
	await assertAgentDeleted(Agent, agentId, options);
	return { agentId, archived: true, deleted: true, listExcluded: true };
}

export function assertCloudSmokeEvidenceSafe(summary, apiKey = process.env.CURSOR_API_KEY) {
	const text = `${JSON.stringify(summary, null, 2)}\n`;
	if (scrubSensitiveText(text, apiKey) !== text) throw new Error("cloud smoke evidence failed canonical secret scan");
	if (/\b(?:authorization|cookie|api[_-]?key|prompt|rawOutput|stderr|stdout)\b/i.test(text)) {
		throw new Error("cloud smoke evidence contains a forbidden raw/credential field");
	}
	return text;
}

function validatePersistedLane(lane, index) {
	const input = requireObject(lane, `lanes[${index}]`);
	if (input.name === "explicit-https-repo-starting-ref-branch-pr-reporting") {
		return projectRawLane({
			name: input.name,
			status: input.status,
			agentId: input.agentId,
			runId: input.runId,
			branchReportObserved: input.branchReportObserved,
			startingRefAncestryVerified: input.startingRefAncestryVerified,
			remoteContentVerified: input.remoteContentVerified,
			prUrlReturned: input.prUrlReturned,
			report: {
				branches: input.branches,
				artifacts: requireBoolean(input.artifactsObserved, `lanes[${index}].artifactsObserved`) ? [{}] : [],
				usage: requireBoolean(input.rawUsageObserved, `lanes[${index}].rawUsageObserved`) ? { observed: true } : {},
			},
		}, index);
	}
	if (input.name === "direct-push-opt-in") {
		return projectRawLane({
			name: input.name,
			status: input.status,
			agentId: input.agentId,
			runId: input.runId,
			remoteContentChanged: input.remoteContentChanged,
			report: {
				branches: input.branches,
				artifacts: requireBoolean(input.artifactsObserved, `lanes[${index}].artifactsObserved`) ? [{}] : [],
				usage: requireBoolean(input.rawUsageObserved, `lanes[${index}].rawUsageObserved`) ? { observed: true } : {},
			},
		}, index);
	}
	return projectRawLane(input, index);
}

function buildCloudSmokeMatrixEvidence(input, laneProjector, allowDefaultTimestamp = false) {
	const data = requireObject(input, "root");
	const {
		model,
		lanes,
		cleanup,
		throwawayRepository,
		provenance,
		schemaVersion = 1,
	} = data;
	const timestamp = data.timestamp ?? (allowDefaultTimestamp ? new Date().toISOString() : undefined);
	if (schemaVersion !== 1) fail("cloud smoke evidence schemaVersion must be 1");
	if (model !== "cursor/grok-4.6") fail("cloud smoke evidence model must be cursor/grok-4.6");
	if (!Array.isArray(lanes) || lanes.length !== LANE_NAMES.length) fail("cloud smoke evidence lanes must contain the complete required matrix");
	if (!Array.isArray(cleanup) || cleanup.length === 0) fail("cloud smoke evidence cleanup must be a non-empty array");
	const projectedLanes = lanes.map((lane, index) => laneProjector(lane, index));
	if (new Set(projectedLanes.map((lane) => lane.name)).size !== LANE_NAMES.length) {
		fail("cloud smoke evidence lanes must contain every required lane exactly once");
	}
	const projectedCleanup = cleanup.map((entry, index) => projectCleanupEntry(entry, index));
	const cleanupAgentIds = new Set(projectedCleanup.map((entry) => entry.agentId));
	if (cleanupAgentIds.size !== projectedCleanup.length) fail("cloud smoke evidence cleanup agent IDs must be unique");
	for (const lane of projectedLanes) {
		for (const agentId of [lane.agentId, ...(lane.agentIds ?? [])].filter(Boolean)) {
			if (!cleanupAgentIds.has(agentId)) fail(`cloud smoke evidence cleanup is missing lane agent ${agentId}`);
		}
	}
	return {
		schemaVersion: 1,
		timestamp: requireIsoTimestamp(timestamp, "timestamp"),
		model,
		provenance: projectProvenance(provenance),
		lanes: projectedLanes,
		cleanup: projectedCleanup,
		throwawayRepository: projectThrowawayRepository(throwawayRepository),
	};
}

export function projectCloudSmokeMatrixEvidence(input = {}) {
	return buildCloudSmokeMatrixEvidence(input, projectRawLane, true);
}

export function validateCloudSmokeMatrixEvidence(input) {
	return buildCloudSmokeMatrixEvidence(input, validatePersistedLane);
}

export function listCloudSmokePackageSourcePaths(options = {}) {
	const root = resolve(options.root ?? DEFAULT_ROOT);
	const readFile = options.readFileSync ?? readFileSync;
	const lstat = options.lstatSync ?? lstatSync;
	const readdir = options.readdirSync ?? readdirSync;
	const packageJson = JSON.parse(readFile(join(root, "package.json"), "utf8"));
	if (!Array.isArray(packageJson.files)) fail("package.json files must be an array");
	const seeds = ["package.json", ...packageJson.files.map((entry) => normalizeRelativePath(entry))];
	const paths = new Set();

	const visit = (relativePath) => {
		const absolutePath = join(root, ...relativePath.split("/"));
		let stats;
		try {
			stats = lstat(absolutePath);
		} catch (error) {
			fail(`published package path is unreadable: ${relativePath}`, error instanceof Error ? error.message : String(error));
		}
		if (stats.isSymbolicLink()) fail(`published package path must not be a symlink: ${relativePath}`);
		if (stats.isFile()) {
			paths.add(relativePath);
			return;
		}
		if (!stats.isDirectory()) fail(`published package path must be a regular file or directory: ${relativePath}`);
		let entries;
		try {
			entries = readdir(absolutePath, { withFileTypes: true });
		} catch (error) {
			fail(`published package directory is unreadable: ${relativePath}`, error instanceof Error ? error.message : String(error));
		}
		for (const entry of entries) {
			const childRelative = `${relativePath}/${entry.name}`;
			if (entry.isSymbolicLink()) fail(`published package path must not be a symlink: ${childRelative}`);
			if (entry.isDirectory()) {
				visit(childRelative);
				continue;
			}
			if (!entry.isFile()) fail(`published package path must be a regular file or directory: ${childRelative}`);
			const childAbsolute = join(absolutePath, entry.name);
			let childStats;
			try {
				childStats = lstat(childAbsolute);
			} catch (error) {
				fail(`published package path is unreadable: ${childRelative}`, error instanceof Error ? error.message : String(error));
			}
			if (childStats.isSymbolicLink() || !childStats.isFile()) {
				fail(`published package path must be a regular file: ${childRelative}`);
			}
			paths.add(childRelative);
		}
	};

	for (const seed of seeds) visit(seed);
	return [...paths].sort((left, right) => left.localeCompare(right));
}

export function buildCloudSmokeEvidenceProvenance(options = {}) {
	const root = resolve(options.root ?? DEFAULT_ROOT);
	const readFile = options.readFileSync ?? readFileSync;
	const packageSourcePaths = options.packageSourcePaths ?? listCloudSmokePackageSourcePaths(options);
	const hash = createHash("sha256");
	for (const relativePath of packageSourcePaths) {
		const normalized = normalizeRelativePath(relativePath);
		hash.update(normalized);
		hash.update("\0");
		hash.update(readFile(join(root, ...normalized.split("/"))));
		hash.update("\0");
	}
	const extensionPackage = JSON.parse(readFile(join(root, "package.json"), "utf8"));
	const sdkPackage = JSON.parse(readFile(join(root, "node_modules", "@cursor", "sdk", "package.json"), "utf8"));
	let gitRevision = options.gitRevision;
	if (gitRevision === undefined) {
		const run = options.spawnSync ?? spawnSync;
		const result = run("git", ["rev-parse", "HEAD"], {
			cwd: root,
			encoding: "utf8",
			env: options.env ?? process.env,
			timeout: options.timeoutMs ?? 30_000,
		});
		if (result.error || result.status !== 0) {
			fail(
				"cloud smoke provenance could not read git revision",
				[result.error?.message, result.stderr, result.stdout].filter(Boolean).join("\n"),
			);
		}
		gitRevision = String(result.stdout ?? "").trim();
	}
	if (!gitRevision) fail("cloud smoke provenance git revision was empty");
	return {
		extensionVersion: extensionPackage.version,
		cursorSdkVersion: sdkPackage.version,
		gitRevision,
		packageSourceSha256: hash.digest("hex"),
	};
}

/**
 * Offline release-gate resource coordinator:
 * run state -> harvest IDs -> cleanup every ID -> repo cleanup -> evidence only on complete success.
 */
export async function coordinateCloudSmokeReleaseGate(callbacks = {}) {
	const run = callbacks.run;
	const harvestAgentIds = callbacks.harvestAgentIds;
	const cleanupAgent = callbacks.cleanupAgent;
	const cleanupRepository = callbacks.cleanupRepository;
	const writeEvidence = callbacks.writeEvidence;
	const captureInterruption = () => {
		try {
			callbacks.throwIfInterrupted?.();
		} catch (error) {
			failure ??= error;
		}
	};
	if (typeof run !== "function") fail("coordinateCloudSmokeReleaseGate requires run()");
	if (typeof harvestAgentIds !== "function") fail("coordinateCloudSmokeReleaseGate requires harvestAgentIds()");
	if (typeof cleanupAgent !== "function") fail("coordinateCloudSmokeReleaseGate requires cleanupAgent()");
	if (typeof writeEvidence !== "function") fail("coordinateCloudSmokeReleaseGate requires writeEvidence()");

	const state = { lanes: [], repository: undefined };
	let failure;
	const cleanup = [];
	let throwawayRepository;

	try {
		await run(state);
	} catch (error) {
		failure = error;
	}
	captureInterruption();

	let agentIds = [];
	try {
		agentIds = [...await harvestAgentIds(state)];
	} catch (error) {
		failure ??= error;
	}
	captureInterruption();

	for (const agentId of agentIds) {
		try {
			cleanup.push(await cleanupAgent(agentId));
		} catch (error) {
			callbacks.onAgentCleanupError?.(error, agentId);
			failure ??= error;
		}
		captureInterruption();
	}

	if (state.repository) {
		if (typeof cleanupRepository !== "function") {
			failure ??= new Error("coordinateCloudSmokeReleaseGate requires cleanupRepository() when a repository is established");
		} else {
			try {
				const proof = await cleanupRepository(state.repository);
				throwawayRepository = {
					name: state.repository.fullName,
					deleted: proof?.deleted === true,
					httpStatus: proof?.httpStatus,
				};
			} catch (error) {
				callbacks.onRepositoryCleanupError?.(error, state.repository);
				failure ??= error;
			}
		}
	}

	captureInterruption();
	if (!failure) {
		try {
			await writeEvidence({
				lanes: state.lanes,
				cleanup,
				throwawayRepository,
				repository: state.repository,
			});
		} catch (error) {
			failure = error;
		}
		captureInterruption();
	}

	if (failure) throw failure;
	return {
		lanes: state.lanes,
		cleanup,
		throwawayRepository,
		repository: state.repository,
	};
}
