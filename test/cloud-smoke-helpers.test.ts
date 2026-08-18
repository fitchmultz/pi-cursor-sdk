import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	assertCloudSmokeEvidenceSafe,
	buildCloudSmokeEvidenceProvenance,
	cleanupCloudAgent,
	coordinateCloudSmokeReleaseGate,
	listCloudSmokePackageSourcePaths,
	projectCloudSmokeMatrixEvidence,
	validateCloudSmokeMatrixEvidence,
} from "../scripts/lib/cloud-smoke-cleanup-evidence.mjs";
import {
	awaitCloudSmokeShutdown,
	checkpointCloudSmokeShutdown,
	createCloudSmokeShutdownController,
	createCloudSmokeTerminalFailureState,
	installCloudSmokeChildErrorHandlers,
	installCloudSmokeSignalHandlers,
	routeCloudSmokeChildClose,
	routeCloudSmokeChildError,
	stopCloudSmokeTrackedChild,
} from "../scripts/lib/cloud-smoke-shutdown.mjs";
import {
	assertOwnedThrowawayRepositoryHandle,
	cloudSmokeRepositoryDescription,
	createThrowawayRepository,
	deleteThrowawayRepository,
	normalizeCloudSmokeGitHubRepo,
	validatePrUrl,
} from "../scripts/lib/cloud-smoke-github.mjs";

const agentId = "bc-00000000-0000-0000-0000-000000000099";
const ownershipToken = "11111111-2222-4333-8444-555555555555";
const ownedFullName = `owner/pi-cursor-cloud-smoke-${ownershipToken}`;
const ownedDescription = cloudSmokeRepositoryDescription(ownershipToken);
const ownedRepo = {
	fullName: ownedFullName,
	repoUrl: `https://github.com/${ownedFullName}.git`,
	seedDir: "/tmp/seed",
	ownershipToken,
	description: ownedDescription,
};

describe("cloud smoke helper contracts", () => {
	it("fail-closes cloud agent cleanup", async () => {
		const Agent = {
			get: async () => ({ archived: false }),
			archive: async () => undefined,
			delete: async () => undefined,
			list: async () => ({ items: [{ agentId }], nextCursor: undefined }),
		};
		let getCalls = 0;
		Agent.get = async () => {
			getCalls += 1;
			if (getCalls === 1) return { archived: false };
			if (getCalls === 2) return { archived: true };
			const error = new Error("agent_not_found");
			(error as Error & { code?: string }).code = "AgentNotFound";
			throw error;
		};
		await expect(cleanupCloudAgent(Agent, agentId, { apiKey: "test-key" })).rejects.toThrow(/remained in Agent\.list/);

		getCalls = 0;
		Agent.list = async () => ({ items: [], nextCursor: undefined });
		await expect(cleanupCloudAgent(Agent, agentId, { apiKey: "test-key" })).resolves.toEqual({
			agentId,
			archived: true,
			deleted: true,
			listExcluded: true,
		});

		const alreadyGone = {
			get: async () => {
				const error = new Error("404");
				(error as Error & { status?: number }).status = 404;
				throw error;
			},
			archive: async () => undefined,
			delete: async () => undefined,
			list: async () => ({ items: [], nextCursor: undefined }),
		};
		await expect(cleanupCloudAgent(alreadyGone, agentId, { apiKey: "test-key" })).resolves.toMatchObject({
			alreadyDeleted: true,
			deleted: true,
			listExcluded: true,
		});
	});

	it("requires exact ownership and explicit HTTP 404 for repository cleanup", () => {
		expect(() => assertOwnedThrowawayRepositoryHandle({ fullName: "owner/repo" })).toThrow(/ownership token/);
		expect(() => deleteThrowawayRepository(
			{ fullName: "owner/repo", ownershipToken: "not-a-uuid", description: "nope" },
			{ runCommand: () => "", spawnSync: () => ({ status: 0, stdout: "", stderr: "" }) as never },
		)).toThrow(/ownership token|pi-cursor-cloud-smoke/);
		expect(() => deleteThrowawayRepository(
			{ fullName: "owner/pre-existing-repo", ownershipToken, description: ownedDescription },
			{ runCommand: () => "", spawnSync: () => ({ status: 0, stdout: "", stderr: "" }) as never },
		)).toThrow(/pi-cursor-cloud-smoke/);

		const deletedCommands: string[] = [];
		expect(deleteThrowawayRepository(ownedRepo, {
			runCommand: (name, args) => {
				deletedCommands.push([name, ...args].join(" "));
				if (name === "gh" && args[0] === "repo" && args[1] === "view") {
					return JSON.stringify({ isPrivate: true, description: ownedDescription });
				}
				return "";
			},
			spawnSync: () => ({ status: 1, stdout: "HTTP/2 404", stderr: "" }) as never,
		})).toEqual({ deleted: true, httpStatus: 404 });
		expect(deletedCommands.some((line) => line.includes("repo delete"))).toBe(true);

		const transientProbes = [
			{ status: 1, stdout: "HTTP/2 503", stderr: "service unavailable" },
			{ status: 1, stdout: "HTTP/2 404", stderr: "not found" },
		];
		const retrySleep = vi.fn();
		expect(deleteThrowawayRepository(ownedRepo, {
			runCommand: (name, args) => {
				if (name === "gh" && args[0] === "repo" && args[1] === "view") {
					return JSON.stringify({ isPrivate: true, description: ownedDescription });
				}
				return "";
			},
			spawnSync: () => transientProbes.shift() as never,
			sleep: retrySleep,
		})).toEqual({ deleted: true, httpStatus: 404 });
		expect(retrySleep).toHaveBeenCalledTimes(1);
		expect(() => deleteThrowawayRepository(ownedRepo, {
			runCommand: (name, args) => {
				if (name === "gh" && args[0] === "repo" && args[1] === "view") {
					return JSON.stringify({ isPrivate: true, description: ownedDescription });
				}
				throw Object.assign(new Error("delete transport failure"), { details: "Could not resolve host: api.github.com" });
			},
			spawnSync: () => ({ status: 1, stdout: "", stderr: "Could not resolve host: api.github.com" }) as never,
			verificationAttempts: 2,
			verificationDelayMs: 0,
			sleep: () => undefined,
		})).toThrow(/explicit HTTP 200\/404|transport failed/);
		for (const probe of [
			{ status: 1, stdout: "HTTP/2.0 503 Service Unavailable\n\n{\"message\":\"upstream mentioned HTTP 404\"}", stderr: "" },
			{ status: null, stdout: "HTTP/2.0 404 Not Found", stderr: "socket closed", error: new Error("transport closed") },
		]) {
			expect(() => deleteThrowawayRepository(ownedRepo, {
				runCommand: (name, args) => name === "gh" && args[1] === "view"
					? JSON.stringify({ isPrivate: true, description: ownedDescription })
					: "",
				spawnSync: () => probe as never,
				verificationAttempts: 1,
				sleep: () => undefined,
			})).toThrow(/HTTP 404|explicit HTTP|independently verified/);
		}

		// Create collision without ownership marker: no cleanup handle, no delete.
		let exposed: unknown;
		const collisionCommands: string[] = [];
		expect(() => createThrowawayRepository("/tmp/artifacts", (repo) => { exposed = repo; }, {
			randomUUID: () => ownershipToken,
			runCommand: (name, args) => {
				collisionCommands.push([name, ...args].join(" "));
				if (name === "gh" && args.includes("auth")) return "";
				if (name === "gh" && args.includes("user")) return "owner";
				if (name === "gh" && args[1] === "create") throw Object.assign(new Error("create failed"), { details: "HTTP 422" });
				throw new Error(`unexpected command ${name} ${args.join(" ")}`);
			},
			spawnSync: () => ({
				status: 0,
				stdout: `HTTP/2.0 200 OK\n\n${JSON.stringify({ private: true, description: "someone else's repo" })}`,
				stderr: "",
			}) as never,
		})).toThrow(/without ownership marker|refusing cleanup/);
		expect(exposed).toBeUndefined();
		expect(collisionCommands.some((line) => line.includes("repo delete"))).toBe(false);

		// Ambiguous create retries transient ownership probes and exposes cleanup only for the exact marker.
		exposed = undefined;
		const ambiguousProbes = [
			{ status: 1, stdout: "HTTP/2.0 503 Service Unavailable", stderr: "service unavailable" },
			{ status: 0, stdout: `HTTP/2.0 200 OK\n\n${JSON.stringify({ private: true, description: ownedDescription })}`, stderr: "" },
		];
		const ambiguousSleep = vi.fn();
		expect(() => createThrowawayRepository("/tmp/artifacts", (repo) => { exposed = repo; }, {
			randomUUID: () => ownershipToken,
			runCommand: (name, args) => {
				if (name === "gh" && args.includes("auth")) return "";
				if (name === "gh" && args.includes("user")) return "owner";
				if (name === "gh" && args[1] === "create") throw Object.assign(new Error("create ambiguous"), { details: "timeout" });
				throw new Error(`unexpected command ${name} ${args.join(" ")}`);
			},
			spawnSync: () => ambiguousProbes.shift() as never,
			sleep: ambiguousSleep,
		})).toThrow(/ownership marker was observed/);
		expect(ambiguousSleep).toHaveBeenCalledTimes(1);
		expect(exposed).toMatchObject({ fullName: ownedFullName, ownershipToken, description: ownedDescription });

		// Successful create exposes the cleanup handle only after the create command establishes ownership.
		const ordered: string[] = [];
		exposed = undefined;
		const successRepo = createThrowawayRepository("/tmp/artifacts", (repo) => {
			ordered.push("owned");
			exposed = repo;
		}, {
			randomUUID: () => ownershipToken,
			writeFileSync: () => undefined,
			runCommand: (name, args) => {
				const line = [name, ...args].join(" ");
				ordered.push(line);
				if (name === "gh" && args.includes("auth")) return "";
				if (name === "gh" && args.includes("user")) return "owner";
				if (name === "gh" && args[1] === "create") {
					expect(exposed).toBeUndefined();
					return "";
				}
				if (name === "gh" && args[1] === "view") {
					return JSON.stringify({ isPrivate: true, description: ownedDescription });
				}
				if (name === "gh" && args[1] === "clone") return "";
				if (name === "gh" && args[1] === "edit") return "";
				if (name === "git" && args.includes("status")) return "";
				if (name === "git" && args.includes("ls-remote")) return "refs/heads/main\nrefs/heads/starting-ref\nrefs/heads/direct-push\n";
				if (name === "git") return "ok";
				return "";
			},
		});
		expect(successRepo).toMatchObject({ fullName: ownedFullName, ownershipToken });
		expect(exposed).toEqual(successRepo);
		expect(ordered.indexOf("owned")).toBeGreaterThan(ordered.findIndex((line) => line.includes("repo create")));

		expect(normalizeCloudSmokeGitHubRepo("https://github.com/Acme/Widget.git")).toBe("acme/widget");
		expect(() => validatePrUrl(
			{ fullName: "acme/widget" },
			"https://evil.example/acme/widget/pull/1",
			{ runCommand: () => "{}" },
		)).toThrow(/outside the throwaway repository/);
		expect(validatePrUrl(
			{ fullName: "acme/widget" },
			"https://github.com/acme/widget/pull/7",
			{ runCommand: () => JSON.stringify({ url: "https://github.com/acme/widget/pull/7", state: "OPEN" }) },
		)).toEqual({ url: "https://github.com/acme/widget/pull/7", state: "OPEN" });
	});

	it("hashes the published source surface and validates round-trippable evidence", () => {
		const packageFiles = [
			"package.json",
			"src/index.ts",
			"shared/constants.mjs",
			"scripts/cloud-runtime-smoke.mjs",
			"scripts/lib/cloud-smoke-cleanup-evidence.mjs",
			"scripts/lib/cloud-smoke-github.mjs",
			"README.md",
		];
		const fileContents = new Map<string, string>([
			["package.json", JSON.stringify({
				version: "9.9.9",
				files: ["src", "shared", "scripts/cloud-runtime-smoke.mjs", "scripts/lib/cloud-smoke-cleanup-evidence.mjs", "scripts/lib/cloud-smoke-github.mjs", "README.md"],
			})],
			["src/index.ts", "export const src = 1;\n"],
			["shared/constants.mjs", "export const shared = 1;\n"],
			["scripts/cloud-runtime-smoke.mjs", "smoke-entry\n"],
			["scripts/lib/cloud-smoke-cleanup-evidence.mjs", "cleanup\n"],
			["scripts/lib/cloud-smoke-github.mjs", "github\n"],
			["README.md", "readme\n"],
			["node_modules/@cursor/sdk/package.json", JSON.stringify({ version: "1.2.3" })],
			["docs/evidence/cursor-cloud-smoke-matrix-latest.json", "{\"should\":\"not-hash\"}\n"],
			["cloud-roadmap-change-scout.md", "protected\n"],
		]);
		const directories = new Set([
			"",
			"src",
			"shared",
			"scripts",
			"scripts/lib",
			"node_modules",
			"node_modules/@cursor",
			"node_modules/@cursor/sdk",
			"docs",
			"docs/evidence",
		]);
		const virtualRoot = resolve("/virtual");
		const virtualRelative = (target: string) => relative(virtualRoot, String(target)).replaceAll("\\", "/");
		const virtualFs = {
			readFileSync: ((target: string) => {
				const relative = virtualRelative(target);
				const content = fileContents.get(relative);
				if (content === undefined) throw new Error(`missing ${relative}`);
				return content;
			}) as typeof readFileSync,
			lstatSync: ((target: string) => {
				const relative = virtualRelative(target);
				if (directories.has(relative)) {
					return { isSymbolicLink: () => false, isFile: () => false, isDirectory: () => true };
				}
				if (fileContents.has(relative)) {
					return { isSymbolicLink: () => false, isFile: () => true, isDirectory: () => false };
				}
				throw new Error(`missing ${relative}`);
			}) as unknown as typeof import("node:fs").lstatSync,
			readdirSync: ((target: string) => {
				const relative = virtualRelative(target);
				const prefix = relative ? `${relative}/` : "";
				const names = new Set<string>();
				for (const dir of directories) {
					if (!dir.startsWith(prefix)) continue;
					const rest = dir.slice(prefix.length);
					if (rest && !rest.includes("/")) names.add(rest);
				}
				for (const file of fileContents.keys()) {
					if (!file.startsWith(prefix)) continue;
					const rest = file.slice(prefix.length);
					if (rest && !rest.includes("/")) names.add(rest);
				}
				return [...names].sort().map((name) => {
					const child = `${prefix}${name}`;
					const isDirectory = directories.has(child);
					return {
						name,
						isSymbolicLink: () => false,
						isDirectory: () => isDirectory,
						isFile: () => !isDirectory,
					};
				});
			}) as unknown as typeof import("node:fs").readdirSync,
		};

		const packageSourcePaths = listCloudSmokePackageSourcePaths({
			root: virtualRoot,
			...virtualFs,
		});
		expect(packageSourcePaths).toEqual([...packageFiles].sort((left, right) => left.localeCompare(right)));
		expect(packageSourcePaths).not.toContain("docs/evidence/cursor-cloud-smoke-matrix-latest.json");
		expect(packageSourcePaths).not.toContain("cloud-roadmap-change-scout.md");

		const realPackagePaths = listCloudSmokePackageSourcePaths();
		expect(realPackagePaths).toContain("package.json");
		expect(realPackagePaths).toContain("src/index.ts");
		expect(realPackagePaths).toContain("shared/cursor-sensitive-text.mjs");
		expect(realPackagePaths).toContain("scripts/cloud-runtime-smoke.mjs");
		expect(realPackagePaths).not.toContain("docs/evidence/cursor-cloud-smoke-matrix-latest.json");
		expect(realPackagePaths).not.toContain("cloud-roadmap-change-scout.md");
		expect(realPackagePaths).not.toContain("cloud-roadmap-reconciliation.md");
		expect(realPackagePaths).not.toContain("progress.md");

		const gitRevision = "d".repeat(40);
		const provenance = buildCloudSmokeEvidenceProvenance({
			root: virtualRoot,
			gitRevision,
			...virtualFs,
		});
		const again = buildCloudSmokeEvidenceProvenance({
			root: virtualRoot,
			gitRevision,
			...virtualFs,
		});
		expect(provenance).toEqual({
			extensionVersion: "9.9.9",
			cursorSdkVersion: "1.2.3",
			gitRevision,
			packageSourceSha256: again.packageSourceSha256,
		});
		expect(provenance.packageSourceSha256).toMatch(/^[a-f0-9]{64}$/);

		fileContents.set("src/index.ts", "export const src = 2;\n");
		const changed = buildCloudSmokeEvidenceProvenance({
			root: virtualRoot,
			gitRevision,
			...virtualFs,
		});
		expect(changed.packageSourceSha256).not.toBe(provenance.packageSourceSha256);

		const runId = "run-00000000-0000-0000-0000-000000000099";
		const missingAgentId = "bc-00000000-0000-0000-0000-000000000097";
		const rawLanes = [
			{ name: "cancel", status: "passed", agentId, runId, runIdSource: "metadata", terminalStatus: "cancelled", idsCapturedBeforeAbort: true },
			{
				name: "explicit-https-repo-starting-ref-branch-pr-reporting",
				status: "passed",
				agentId,
				runId,
				branchReportObserved: false,
				startingRefAncestryVerified: true,
				remoteContentVerified: true,
				prUrlReturned: false,
				report: { branches: [], artifacts: [], usage: { total: 1 } },
			},
			{ name: "lifecycle-delete", status: "passed", agentId, runId, lifecycleDeleteVerified: true },
			{
				name: "direct-push-opt-in",
				status: "passed",
				agentId,
				runId,
				remoteContentChanged: true,
				report: {
					branches: [{ branch: "direct-push", prUrl: null, extra: "drop" }],
					artifacts: [{ path: "a.txt", sizeBytes: 1, updatedAt: "2026-07-19T00:00:00.000Z" }],
					usage: { totalUsage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2 } },
					resultText: "must-not-leak",
				},
				missingRef: "drop-me",
				extraLaneField: "drop-me-too",
			},
			{ name: "missing-branch-failure", status: "passed", expectedFailureObserved: true, agentIds: [missingAgentId] },
			{ name: "passive-artifacts-and-raw-usage", status: "passed", artifactsObserved: true, rawUsageObserved: true, observationsValidated: true },
		];
		const summary = projectCloudSmokeMatrixEvidence({
			model: "cursor/grok-4.6",
			timestamp: "2026-07-19T00:00:00.000Z",
			provenance,
			cleanup: [
				{ agentId, archived: true, deleted: true, listExcluded: true },
				{ agentId: missingAgentId, alreadyDeleted: true, archiveRequired: false, deleted: true, listExcluded: true },
			],
			throwawayRepository: { name: ownedFullName, deleted: true, httpStatus: 404 },
			lanes: rawLanes,
		});
		expect(summary.provenance).toEqual(provenance);
		expect(summary.lanes[0]).toMatchObject({ runIdSource: "metadata" });
		expect(summary.lanes[4]).toMatchObject({ agentIds: [missingAgentId] });
		expect(summary.lanes[3]).toEqual({
			name: "direct-push-opt-in",
			status: "passed",
			agentId,
			runId,
			remoteContentChanged: true,
			branches: [{ branch: "direct-push", prUrl: null }],
			artifactsObserved: true,
			rawUsageObserved: true,
		});
		expect(summary.lanes[3]).not.toHaveProperty("report");
		expect(summary.lanes[3]).not.toHaveProperty("missingRef");
		expect(summary.lanes[3]).not.toHaveProperty("extraLaneField");
		expect(JSON.stringify(summary)).not.toContain("must-not-leak");
		expect(JSON.stringify(summary)).not.toContain("drop-me");
		expect(validateCloudSmokeMatrixEvidence(summary)).toEqual(summary);
		expect(validateCloudSmokeMatrixEvidence(validateCloudSmokeMatrixEvidence(summary))).toEqual(summary);
		expect(assertCloudSmokeEvidenceSafe(summary, "secret-key")).toContain('"packageSourceSha256"');
		expect(() => assertCloudSmokeEvidenceSafe({ ...summary, prompt: "nope" }, "secret-key")).toThrow("forbidden");

		expect(() => validateCloudSmokeMatrixEvidence({
			...summary,
			lanes: summary.lanes.map((lane, index) => index === 0 ? { ...lane, name: "unknown-lane" } : lane),
		})).toThrow(/unknown lane/);
		expect(() => validateCloudSmokeMatrixEvidence({
			...summary,
			cleanup: [{ agentId, archived: false, deleted: true, listExcluded: true }],
		})).toThrow(/cleanup/);
		expect(() => validateCloudSmokeMatrixEvidence({
			...summary,
			cleanup: summary.cleanup.filter((entry) => entry.agentId !== missingAgentId),
		})).toThrow(/cleanup is missing lane agent/);
		const uncoveredAgentId = "bc-00000000-0000-0000-0000-000000000098";
		expect(() => validateCloudSmokeMatrixEvidence({
			...summary,
			lanes: summary.lanes.map((lane) => lane.name === "direct-push-opt-in" ? { ...lane, agentId: uncoveredAgentId } : lane),
		})).toThrow(/cleanup is missing lane agent/);
		expect(() => validateCloudSmokeMatrixEvidence({
			...summary,
			provenance: { ...summary.provenance, packageSourceSha256: "nope" },
		})).toThrow(/packageSourceSha256|sha256/);
		expect(() => validateCloudSmokeMatrixEvidence({
			...summary,
			throwawayRepository: { name: ownedFullName, deleted: false, httpStatus: 404 },
		})).toThrow(/throwawayRepository/);
	});

	it("coordinates cleanup after failures and writes evidence only after complete success", async () => {
		const writes: unknown[] = [];
		const cleanedAgents: string[] = [];
		const cleanedRepos: string[] = [];

		await expect(coordinateCloudSmokeReleaseGate({
			run: async (state) => {
				state.repository = ownedRepo;
				state.lanes.push({
					name: "cancel",
					status: "passed",
					agentId,
					runId: "run-00000000-0000-0000-0000-000000000099",
					terminalStatus: "cancelled",
					idsCapturedBeforeAbort: true,
				});
				throw new Error("lane failed after repo established");
			},
			harvestAgentIds: () => [agentId],
			cleanupAgent: async (id) => {
				cleanedAgents.push(id);
				return { agentId: id, archived: true, deleted: true, listExcluded: true };
			},
			cleanupRepository: async (repo) => {
				cleanedRepos.push(repo.fullName);
				return { deleted: true as const, httpStatus: 404 as const };
			},
			writeEvidence: async (input) => { writes.push(input); },
		})).rejects.toThrow(/lane failed after repo established/);
		expect(cleanedAgents).toEqual([agentId]);
		expect(cleanedRepos).toEqual([ownedFullName]);
		expect(writes).toEqual([]);

		cleanedAgents.length = 0;
		cleanedRepos.length = 0;
		await expect(coordinateCloudSmokeReleaseGate({
			run: async (state) => {
				state.repository = ownedRepo;
				state.lanes.push({
					name: "missing-branch-failure",
					status: "passed",
					expectedFailureObserved: true,
				});
			},
			harvestAgentIds: () => [agentId],
			cleanupAgent: async () => {
				throw new Error("agent cleanup failed");
			},
			cleanupRepository: async (repo) => {
				cleanedRepos.push(repo.fullName);
				return { deleted: true as const, httpStatus: 404 as const };
			},
			writeEvidence: async (input) => { writes.push(input); },
		})).rejects.toThrow(/agent cleanup failed/);
		expect(cleanedRepos).toEqual([ownedFullName]);
		expect(writes).toEqual([]);

		cleanedRepos.length = 0;
		await expect(coordinateCloudSmokeReleaseGate({
			run: async (state) => {
				state.repository = ownedRepo;
				state.lanes.push({
					name: "missing-branch-failure",
					status: "passed",
					expectedFailureObserved: true,
				});
			},
			harvestAgentIds: () => [],
			cleanupAgent: async (id) => ({ agentId: id, archived: true, deleted: true, listExcluded: true }),
			cleanupRepository: async () => {
				throw new Error("repo cleanup failed");
			},
			writeEvidence: async (input) => { writes.push(input); },
		})).rejects.toThrow(/repo cleanup failed/);
		expect(writes).toEqual([]);

		await expect(coordinateCloudSmokeReleaseGate({
			run: async (state) => { state.repository = ownedRepo; },
			harvestAgentIds: async () => { throw new Error("agent harvest failed"); },
			cleanupAgent: async (id) => ({ agentId: id, archived: true, deleted: true, listExcluded: true }),
			cleanupRepository: async () => ({ deleted: true as const, httpStatus: 404 as const }),
			writeEvidence: async (input) => { writes.push(input); },
		})).rejects.toThrow(/agent harvest failed/);
		expect(writes).toEqual([]);

		await expect(coordinateCloudSmokeReleaseGate({
			run: async (state) => { state.repository = ownedRepo; },
			harvestAgentIds: () => [],
			cleanupAgent: async (id) => ({ agentId: id, archived: true, deleted: true, listExcluded: true }),
			cleanupRepository: async () => ({ deleted: true as const, httpStatus: 404 as const }),
			writeEvidence: async () => { throw new Error("evidence write failed"); },
		})).rejects.toThrow(/evidence write failed/);
		expect(writes).toEqual([]);

		await expect(coordinateCloudSmokeReleaseGate({
			run: async (state) => {
				state.repository = ownedRepo;
				state.lanes.push({
					name: "missing-branch-failure",
					status: "passed",
					expectedFailureObserved: true,
				});
			},
			harvestAgentIds: () => [agentId],
			cleanupAgent: async (id) => ({ agentId: id, archived: true, deleted: true, listExcluded: true }),
			cleanupRepository: async () => ({ deleted: true as const, httpStatus: 404 as const }),
			writeEvidence: async (input) => { writes.push(input); },
		})).resolves.toMatchObject({
			throwawayRepository: { name: ownedFullName, deleted: true, httpStatus: 404 },
		});
		expect(writes).toHaveLength(1);
	});

	it.skipIf(process.platform === "win32")("handles real OS signals on both sides of the evidence commit point", async () => {
		for (const mode of ["precommit", "postcommit"] as const) {
			const fixtureRoot = mkdtempSync(join(tmpdir(), "cloud-smoke-signal-test-"));
			const evidencePath = join(fixtureRoot, "evidence.json");
			const releasePath = join(fixtureRoot, "release");
			const child = spawn(process.execPath, [
				resolve("test/fixtures/cloud-smoke-signal-finalization.mjs"),
				evidencePath,
				releasePath,
				mode,
			], { cwd: resolve("."), stdio: ["ignore", "pipe", "pipe"] });
			let stdout = "";
			let stderr = "";
			child.stdout.setEncoding("utf8");
			child.stderr.setEncoding("utf8");
			child.stdout.on("data", (chunk) => { stdout += chunk; });
			child.stderr.on("data", (chunk) => { stderr += chunk; });
			try {
				const marker = mode === "postcommit" ? "COMMITTED" : "FINALIZING";
				await new Promise<void>((resolveReady, rejectReady) => {
					const timer = setTimeout(() => rejectReady(new Error(`fixture did not reach ${marker}: ${stderr}`)), 5_000);
					child.stdout.on("data", () => {
						if (!stdout.includes(marker)) return;
						clearTimeout(timer);
						resolveReady();
					});
				});
				const closed = new Promise<number | null>((resolveClose, rejectClose) => {
					const timer = setTimeout(() => rejectClose(new Error(`fixture did not exit: ${stderr}`)), 5_000);
					child.once("close", (code) => {
						clearTimeout(timer);
						resolveClose(code);
					});
				});
				expect(child.kill("SIGTERM")).toBe(true);
				writeFileSync(releasePath, "continue\n");
				const exitCode = await closed;
				expect(exitCode, stderr).toBe(1);
				expect(stdout).toContain("INTERRUPTED cloud smoke interrupted by SIGTERM");
				expect(stdout).not.toContain("UNEXPECTED_SUCCESS");
				expect(existsSync(evidencePath)).toBe(mode === "postcommit");
			} finally {
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
				rmSync(fixtureRoot, { recursive: true, force: true });
			}
		}
	}, 15_000);

	it.skipIf(process.platform === "win32")("routes an actual RPC stdin EPIPE into terminal state", async () => {
		const child = spawn(process.execPath, [
			"-e",
			"require('node:fs').closeSync(0); console.log('READY'); setTimeout(() => {}, 2000)",
		], { stdio: ["pipe", "pipe", "ignore"] });
		const closed = new Promise<void>((resolveClose) => { child.once("close", () => resolveClose()); });
		const shutdown = createCloudSmokeShutdownController(async () => {});
		await shutdown.track(child);
		let shutdownRoutes = 0;
		let resolveTerminalError!: (error: Error) => void;
		const terminalError = new Promise<Error>((resolveError) => { resolveTerminalError = resolveError; });
		const terminalState = createCloudSmokeTerminalFailureState(resolveTerminalError);
		installCloudSmokeChildErrorHandlers(child, shutdown, () => { shutdownRoutes++; }, terminalState.record);
		try {
			await new Promise<void>((resolveReady, rejectReady) => {
				const timer = setTimeout(() => rejectReady(new Error("EPIPE fixture did not become ready")), 5_000);
				child.stdout.once("data", () => {
					clearTimeout(timer);
					resolveReady();
				});
			});
			child.stdin.write(Buffer.alloc(1024 * 1024));
			const error = await new Promise<Error>((resolveError, rejectError) => {
				const timer = setTimeout(() => rejectError(new Error("stdin EPIPE was not routed")), 5_000);
				void terminalError.then((failure) => {
					clearTimeout(timer);
					resolveError(failure);
				});
			});
			expect((error as NodeJS.ErrnoException).code).toBe("EPIPE");
			expect(child.exitCode).toBeNull();
			expect(child.signalCode).toBeNull();
			expect(shutdownRoutes).toBe(0);
			expect(() => terminalState.throwIfFailed()).toThrow(error);
		} finally {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			await closed;
		}
	}, 10_000);

	it("waits for detached child termination before signal-triggered resource cleanup", async () => {
		const processLike = new EventEmitter();
		const child = new EventEmitter();
		let releaseTermination!: () => void;
		const terminate = vi.fn(() => new Promise<void>((resolveTermination) => {
			releaseTermination = () => {
				child.emit("close");
				resolveTermination();
			};
		}));
		const shutdown = createCloudSmokeShutdownController(terminate);
		await shutdown.track(child as unknown as ChildProcess);
		const observedSignals: string[] = [];
		const removeSignalHandlers = installCloudSmokeSignalHandlers(shutdown, processLike, (signalName) => observedSignals.push(signalName));
		const cleanedAgents: string[] = [];
		const cleanedRepos: string[] = [];
		const writes: unknown[] = [];

		const run = coordinateCloudSmokeReleaseGate({
			throwIfInterrupted: () => shutdown.throwIfRequested(),
			run: async (state) => {
				state.repository = ownedRepo;
				await new Promise((_, reject) => shutdown.signal.addEventListener("abort", () => {
					void shutdown.wait().then(() => reject(shutdown.reason), reject);
				}, { once: true }));
			},
			harvestAgentIds: () => [agentId],
			cleanupAgent: async (id) => {
				cleanedAgents.push(id);
				return { agentId: id, archived: true, deleted: true, listExcluded: true };
			},
			cleanupRepository: async (repo) => {
				cleanedRepos.push(repo.fullName);
				return { deleted: true as const, httpStatus: 404 as const };
			},
			writeEvidence: async (input) => { writes.push(input); },
		});
		processLike.emit("SIGTERM");
		await Promise.resolve();

		expect(cleanedAgents).toEqual([]);
		expect(cleanedRepos).toEqual([]);
		releaseTermination();
		await expect(run).rejects.toThrow(/interrupted by SIGTERM/);
		expect(terminate).toHaveBeenCalledWith(child);
		expect(observedSignals).toEqual(["SIGTERM"]);
		expect(cleanedAgents).toEqual([agentId]);
		expect(cleanedRepos).toEqual([ownedFullName]);
		expect(writes).toEqual([]);
		removeSignalHandlers();
		expect(processLike.listenerCount("SIGTERM")).toBe(0);

		const failedChild = new EventEmitter();
		const deferredChild = new EventEmitter();
		let releaseDeferred!: () => void;
		const failedShutdown = createCloudSmokeShutdownController((trackedChild) => {
			if (trackedChild === failedChild) throw new Error("terminate failed");
			return new Promise<void>((resolveTermination) => { releaseDeferred = resolveTermination; });
		});
		await failedShutdown.track(failedChild as unknown as ChildProcess);
		await failedShutdown.track(deferredChild as unknown as ChildProcess);
		const failedRequest = failedShutdown.request("SIGINT");
		let failedRequestSettled = false;
		void failedRequest.catch(() => { failedRequestSettled = true; });
		await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
		expect(failedRequestSettled).toBe(false);
		releaseDeferred();
		await expect(failedRequest).rejects.toThrow(/child termination failed/);

		const activeChild = new EventEmitter();
		const lateChild = new EventEmitter();
		let releaseActive!: () => void;
		let releaseLate!: () => void;
		const lateShutdown = createCloudSmokeShutdownController((trackedChild) => new Promise<void>((resolveTermination) => {
			if (trackedChild === activeChild) releaseActive = resolveTermination;
			else releaseLate = resolveTermination;
		}));
		await lateShutdown.track(activeChild as unknown as ChildProcess);
		const originalRequest = lateShutdown.request("SIGTERM");
		const originalWait = lateShutdown.wait();
		const rejectedLateTrack = lateShutdown.track(lateChild as unknown as ChildProcess);
		let combinedSettled = false;
		const combinedShutdown = awaitCloudSmokeShutdown(lateShutdown, rejectedLateTrack);
		void combinedShutdown.then(() => { combinedSettled = true; });
		await Promise.resolve();
		releaseActive();
		await expect(originalRequest).resolves.toMatchObject({ signal: "SIGTERM" });
		await expect(originalWait).resolves.toBeUndefined();
		await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
		expect(combinedSettled).toBe(false);
		releaseLate();
		await expect(rejectedLateTrack).rejects.toThrow(/interrupted by SIGTERM/);
		await expect(combinedShutdown).resolves.toMatchObject({ message: "cloud smoke interrupted by SIGTERM" });
	});

	it("routes child errors through the shutdown barrier after abort", async () => {
		const idleShutdown = createCloudSmokeShutdownController(async () => {});
		await expect(checkpointCloudSmokeShutdown(idleShutdown)).resolves.toBeUndefined();
		await expect(awaitCloudSmokeShutdown(idleShutdown)).resolves.toMatchObject({ message: "cloud smoke shutdown failed" });
		await expect(awaitCloudSmokeShutdown(idleShutdown, Promise.reject("tracking failed"))).resolves.toMatchObject({
			message: "cloud smoke shutdown failed",
			cause: "tracking failed",
		});
		const closeResults: string[] = [];
		routeCloudSmokeChildClose(idleShutdown, true, () => closeResults.push("shutdown"), (result) => closeResults.push(result), "closed");
		expect(closeResults).toEqual([]);
		routeCloudSmokeChildClose(idleShutdown, false, () => closeResults.push("shutdown"), (result) => closeResults.push(result), "closed");
		expect(closeResults).toEqual(["closed"]);
		await idleShutdown.request("SIGTERM");
		routeCloudSmokeChildClose(idleShutdown, true, () => closeResults.push("shutdown"), (result) => closeResults.push(result), "closed");
		expect(closeResults).toEqual(["closed", "shutdown"]);

		const exitedChild = new EventEmitter();
		const timeoutShutdown = createCloudSmokeShutdownController(async () => {});
		const exitedTracking = timeoutShutdown.track(exitedChild as unknown as ChildProcess);
		await exitedTracking;
		exitedChild.emit("close");
		let releaseTimeoutTermination!: () => void;
		const timeoutTermination = new Promise<void>((resolveTermination) => { releaseTimeoutTermination = resolveTermination; });
		await timeoutShutdown.request("SIGINT");
		const timeoutOutcome = awaitCloudSmokeShutdown(timeoutShutdown, timeoutTermination);
		let timeoutOutcomeSettled = false;
		void timeoutOutcome.then(() => { timeoutOutcomeSettled = true; });
		await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
		expect(timeoutOutcomeSettled).toBe(false);
		releaseTimeoutTermination();
		await expect(timeoutOutcome).resolves.toMatchObject({ message: "cloud smoke interrupted by SIGINT" });

		const exitedRpcChild = new EventEmitter();
		const rpcShutdown = createCloudSmokeShutdownController(async () => {});
		const rpcTracking = rpcShutdown.track(exitedRpcChild as unknown as ChildProcess);
		await rpcTracking;
		exitedRpcChild.emit("close");
		await rpcShutdown.request("SIGTERM");
		let releaseRpcTermination!: () => void;
		const terminateExitedRpc = vi.fn(() => new Promise<void>((resolveTermination) => { releaseRpcTermination = resolveTermination; }));
		const stoppedRpc = stopCloudSmokeTrackedChild(rpcShutdown, rpcTracking, terminateExitedRpc);
		let stoppedRpcSettled = false;
		void stoppedRpc.then(() => { stoppedRpcSettled = true; });
		await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
		expect(terminateExitedRpc).toHaveBeenCalledOnce();
		expect(stoppedRpcSettled).toBe(false);
		releaseRpcTermination();
		await expect(stoppedRpc).resolves.toMatchObject({ message: "cloud smoke interrupted by SIGTERM" });

		const rejectedTerminalFailures: Error[] = [];
		const terminalState = createCloudSmokeTerminalFailureState((error) => rejectedTerminalFailures.push(error));
		const firstTerminalFailure = new Error("RPC closed");
		terminalState.record(firstTerminalFailure);
		terminalState.record(new Error("later error"));
		expect(rejectedTerminalFailures).toEqual([firstTerminalFailure, firstTerminalFailure]);
		expect(() => terminalState.throwIfFailed()).toThrow(firstTerminalFailure);

		const child = new EventEmitter();
		let releaseTermination!: () => void;
		const shutdown = createCloudSmokeShutdownController(() => new Promise<void>((resolveTermination) => {
			releaseTermination = resolveTermination;
		}));
		const tracking = shutdown.track(child as unknown as ChildProcess);
		await tracking;
		let normalError: Error | undefined;
		let shutdownSettled = false;
		const childFailure = new Promise<Error>((resolveFailure) => {
			child.once("error", (error) => routeCloudSmokeChildError(
				shutdown,
				() => { void awaitCloudSmokeShutdown(shutdown, tracking).then(resolveFailure); },
				(failure) => { normalError = failure; resolveFailure(failure); },
				error,
			));
		});
		void childFailure.then(() => { shutdownSettled = true; });
		const request = shutdown.request("SIGINT");
		await Promise.resolve();
		child.emit("error", new Error("kill failed before close"));
		await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
		expect(normalError).toBeUndefined();
		expect(shutdownSettled).toBe(false);
		releaseTermination();
		await expect(request).resolves.toMatchObject({ signal: "SIGINT" });
		await expect(childFailure).resolves.toMatchObject({ message: "cloud smoke interrupted by SIGINT" });
	});

	it("fails without writing evidence when SIGTERM arrives during cleanup", async () => {
		const processLike = new EventEmitter();
		const shutdown = createCloudSmokeShutdownController(async () => {});
		const removeSignalHandlers = installCloudSmokeSignalHandlers(shutdown, processLike);
		const cleanedRepos: string[] = [];
		const writes: unknown[] = [];

		await expect(coordinateCloudSmokeReleaseGate({
			throwIfInterrupted: () => shutdown.throwIfRequested(),
			run: async (state) => { state.repository = ownedRepo; },
			harvestAgentIds: () => [agentId],
			cleanupAgent: async (id) => {
				processLike.emit("SIGTERM");
				return { agentId: id, archived: true, deleted: true, listExcluded: true };
			},
			cleanupRepository: async (repo) => {
				cleanedRepos.push(repo.fullName);
				return { deleted: true as const, httpStatus: 404 as const };
			},
			writeEvidence: async (input) => { writes.push(input); },
		})).rejects.toThrow(/interrupted by SIGTERM/);
		expect(cleanedRepos).toEqual([ownedFullName]);
		expect(writes).toEqual([]);
		removeSignalHandlers();
	});
});
