import { randomUUID as nodeRandomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const GITHUB_CLI_PATTERN = /^[A-Za-z0-9_./-]+$/;
export const CLOUD_SMOKE_REPO_NAME_PREFIX = "pi-cursor-cloud-smoke-";
export const CLOUD_SMOKE_OWNERSHIP_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OWNED_REPO_NAME_PATTERN = /^[^/]+\/pi-cursor-cloud-smoke-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

function fail(message, details = "") {
	const error = new Error(message);
	error.details = details;
	throw error;
}

function githubCli(options = {}) {
	const command = String(options.githubCli ?? process.env.CURSOR_CLOUD_SMOKE_GH_CLI ?? "gh").trim();
	if (!GITHUB_CLI_PATTERN.test(command)) fail("Cursor cloud smoke GitHub CLI must be one executable path without spaces");
	return command;
}

export function cloudSmokeRepositoryDescription(ownershipToken) {
	const token = String(ownershipToken ?? "").toLowerCase();
	if (!CLOUD_SMOKE_OWNERSHIP_TOKEN_PATTERN.test(token)) fail("cloud smoke ownership token must be a lowercase UUID");
	return `pi-cursor-sdk throwaway cloud smoke; ownership=${token}; safe to delete`;
}

export function assertOwnedThrowawayRepositoryHandle(repo) {
	if (!repo || typeof repo !== "object" || Array.isArray(repo)) fail("throwaway repository handle must be an object");
	const ownershipToken = String(repo.ownershipToken ?? "").toLowerCase();
	if (!CLOUD_SMOKE_OWNERSHIP_TOKEN_PATTERN.test(ownershipToken)) {
		fail("throwaway repository handle missing exact ownership token");
	}
	const fullName = String(repo.fullName ?? "").toLowerCase();
	const match = fullName.match(OWNED_REPO_NAME_PATTERN);
	if (!match || match[1] !== ownershipToken) {
		fail("throwaway repository handle fullName must match pi-cursor-cloud-smoke-<ownership-token>");
	}
	const expectedDescription = cloudSmokeRepositoryDescription(ownershipToken);
	if (repo.description !== expectedDescription) {
		fail("throwaway repository handle description must include exact ownership marker");
	}
	return {
		fullName,
		ownershipToken,
		description: expectedDescription,
		repoUrl: typeof repo.repoUrl === "string" ? repo.repoUrl : `https://github.com/${fullName}.git`,
		seedDir: typeof repo.seedDir === "string" ? repo.seedDir : undefined,
	};
}

export function runTimedCommand(commandName, commandArgs, options = {}) {
	const run = options.spawnSync ?? spawnSync;
	const result = run(commandName, commandArgs, {
		cwd: options.cwd,
		env: options.env ?? process.env,
		encoding: "utf8",
		maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
		timeout: options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
	});
	if (result.error || result.status !== 0) {
		fail(
			`${options.label ?? commandName} failed${result.status === null ? "" : ` with exit ${result.status}`}`,
			[result.error?.message, result.stderr, result.stdout].filter(Boolean).join("\n"),
		);
	}
	return String(result.stdout ?? "").trim();
}

export function authenticatedGitArgs(commandArgs) {
	return ["-c", "credential.helper=", "-c", `credential.helper=!${githubCli()} auth git-credential`, ...commandArgs];
}

function isTransientCommandFailure(error) {
	const text = `${error instanceof Error ? error.message : String(error)}\n${error?.details ?? ""}`;
	return /HTTP\s*5\d\d|Service Unavailable|timed?\s*out|ECONNRESET|EAI_AGAIN/i.test(text);
}

function runRetryableCommand(command, commandName, commandArgs, commandOptions, options = {}) {
	const sleep = options.sleep ?? ((ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));
	const attempts = options.verificationAttempts ?? 5;
	let lastError;
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		try {
			return command(commandName, commandArgs, commandOptions);
		} catch (error) {
			lastError = error;
			if (!isTransientCommandFailure(error) || attempt === attempts) throw error;
			sleep(options.verificationDelayMs ?? 500);
		}
	}
	throw lastError;
}

export function normalizeCloudSmokeGitHubRepo(value) {
	if (typeof value !== "string" || !value.trim()) return undefined;
	let url;
	try {
		url = new URL(value.includes("://") ? value : `https://${value}`);
	} catch {
		return undefined;
	}
	if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || url.search || url.hash) {
		return undefined;
	}
	const segments = url.pathname.replace(/\.git$/, "").split("/").filter(Boolean);
	return segments.length === 2 ? `${segments[0]}/${segments[1]}`.toLowerCase() : undefined;
}

function explicitHttpStatus(stdout) {
	const firstLine = String(stdout ?? "").split(/\r?\n/, 1)[0].trim();
	return /^HTTP\/\S+\s+(\d{3})(?:\s|$)/i.exec(firstLine)?.[1];
}

function readRepositoryOwnership(fullName, options = {}) {
	const run = options.spawnSync ?? spawnSync;
	const probe = run(githubCli(options), ["api", "-i", `repos/${fullName}`], {
		cwd: options.cwd,
		env: options.env ?? process.env,
		encoding: "utf8",
		maxBuffer: 1024 * 1024,
		timeout: options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
	});
	const output = [probe.error?.message, probe.stdout, probe.stderr].filter(Boolean).join("\n");
	if (probe.error) fail(`probe throwaway repository ownership transport failed for ${fullName}`, output);
	const status = explicitHttpStatus(probe.stdout);
	if (status === "404" && probe.status !== 0) return { exists: false, isPrivate: false, description: "" };
	if (probe.status !== 0 || status !== "200") {
		fail(`probe throwaway repository ownership did not return explicit HTTP 200/404 for ${fullName}`, output);
	}
	const bodyStart = String(probe.stdout ?? "").indexOf("{");
	let parsed;
	try {
		parsed = JSON.parse(String(probe.stdout ?? "").slice(bodyStart));
	} catch (error) {
		fail(`probe throwaway repository ownership returned invalid JSON for ${fullName}`, error instanceof Error ? error.message : String(error));
	}
	return {
		exists: true,
		isPrivate: parsed.private === true,
		description: typeof parsed.description === "string" ? parsed.description : "",
	};
}

function probeRepositoryOwnership(fullName, options = {}) {
	const sleep = options.sleep ?? ((ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));
	const attempts = options.verificationAttempts ?? 5;
	let lastResult = { exists: false, isPrivate: false, description: "" };
	let lastError;
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		try {
			lastResult = readRepositoryOwnership(fullName, options);
			lastError = undefined;
			if (lastResult.exists) return lastResult;
		} catch (error) {
			lastError = error;
		}
		if (attempt < attempts) sleep(options.verificationDelayMs ?? 500);
	}
	if (lastError) throw lastError;
	return lastResult;
}

function verifyOwnedRepository(repo, options = {}) {
	const owned = assertOwnedThrowawayRepositoryHandle(repo);
	const command = options.runCommand ?? ((name, args, opts = {}) => runTimedCommand(name, args, { ...opts, spawnSync: options.spawnSync }));
	const view = JSON.parse(runRetryableCommand(command, githubCli(options), ["repo", "view", owned.fullName, "--json", "isPrivate,description"], {
		cwd: options.cwd,
		label: "verify throwaway repository ownership marker",
	}, options));
	if (view.isPrivate !== true) fail("throwaway repository is not private");
	if (view.description !== owned.description) fail("throwaway repository description does not match ownership marker");
	return owned;
}

export function createThrowawayRepository(artifactRoot, onOwned, options = {}) {
	const command = options.runCommand ?? ((name, args, opts = {}) => runTimedCommand(name, args, { ...opts, spawnSync: options.spawnSync }));
	const writeFile = options.writeFileSync ?? writeFileSync;
	const randomUUID = options.randomUUID ?? nodeRandomUUID;
	const ownershipToken = String(randomUUID()).toLowerCase();
	if (!CLOUD_SMOKE_OWNERSHIP_TOKEN_PATTERN.test(ownershipToken)) fail("cloud smoke ownership token must be a lowercase UUID");
	const cwd = options.cwd;
	const gh = githubCli(options);

	command(gh, ["auth", "status"], { cwd, label: "gh auth status" });
	const owner = command(gh, ["api", "user", "--jq", ".login"], { cwd, label: "read gh user" });
	if (!owner) fail("gh auth did not return a GitHub login");
	const name = `${CLOUD_SMOKE_REPO_NAME_PREFIX}${ownershipToken}`;
	const fullName = `${owner}/${name}`.toLowerCase();
	const description = cloudSmokeRepositoryDescription(ownershipToken);
	const seedDir = join(artifactRoot, "repo-seed");
	const repo = {
		fullName,
		repoUrl: `https://github.com/${fullName}.git`,
		seedDir,
		ownershipToken,
		description,
	};

	const sleep = options.sleep ?? ((ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));
	const attempts = options.verificationAttempts ?? 5;
	let createError;
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		try {
			command(gh, ["repo", "create", fullName, "--private", "--description", description], {
				cwd,
				label: "create private throwaway repository",
			});
			createError = undefined;
			break;
		} catch (error) {
			createError = error;
			const probe = probeRepositoryOwnership(fullName, options);
			if (probe.exists && probe.description === description && probe.isPrivate) {
				// Creation was ambiguous but the exact ownership marker is present: expose cleanup only now.
				onOwned?.(repo);
				fail(
					"throwaway repository create failed after ownership marker was observed",
					[error instanceof Error ? error.message : String(error), error?.details].filter(Boolean).join("\n"),
				);
			}
			if (probe.exists) {
				const residual = new Error(`throwaway repository name exists without ownership marker; refusing cleanup: ${fullName}`);
				residual.residualRepositoryName = fullName;
				residual.details = [error instanceof Error ? error.message : String(error), error?.details].filter(Boolean).join("\n");
				throw residual;
			}
			if (!isTransientCommandFailure(error) || attempt === attempts) throw error;
			sleep(options.verificationDelayMs ?? 500);
		}
	}
	if (createError) throw createError;

	// A successful create establishes ownership; expose cleanup before later verification/seeding can fail.
	onOwned?.(repo);
	verifyOwnedRepository(repo, options);

	command(gh, ["repo", "clone", fullName, seedDir], { cwd, label: "clone throwaway repository" });
	command("git", ["config", "user.name", "pi-cursor-sdk cloud smoke"], { cwd: seedDir });
	command("git", ["config", "user.email", "pi-cursor-sdk-cloud-smoke@invalid.example"], { cwd: seedDir });
	command("git", ["switch", "-c", "main"], { cwd: seedDir });
	writeFile(join(seedDir, "README.md"), "# pi-cursor-sdk cloud smoke\n");
	command("git", ["add", "README.md"], { cwd: seedDir });
	command("git", ["commit", "-m", "seed main"], { cwd: seedDir });
	command("git", authenticatedGitArgs(["push", "-u", "origin", "main"]), { cwd: seedDir });
	runRetryableCommand(command, gh, ["repo", "edit", fullName, "--default-branch", "main"], { cwd, label: "set throwaway default branch" }, options);
	for (const branch of ["starting-ref", "direct-push"]) {
		command("git", ["switch", "-c", branch, "main"], { cwd: seedDir });
		writeFile(join(seedDir, `${branch}.txt`), `${branch} seed\n`);
		command("git", ["add", `${branch}.txt`], { cwd: seedDir });
		command("git", ["commit", "-m", `seed ${branch}`], { cwd: seedDir });
		command("git", authenticatedGitArgs(["push", "-u", "origin", branch]), { cwd: seedDir });
	}
	if (command("git", ["status", "--porcelain"], { cwd: seedDir })) fail("throwaway seed repository is not clean");
	const remoteRefs = command("git", authenticatedGitArgs(["ls-remote", "--heads", repo.repoUrl]), {
		cwd,
		label: "verify seeded throwaway branches",
	});
	for (const branch of ["main", "starting-ref", "direct-push"]) {
		if (!remoteRefs.includes(`refs/heads/${branch}`)) fail(`throwaway repository is missing seeded ${branch} branch`);
	}
	return repo;
}

export function deleteThrowawayRepository(repo, options = {}) {
	const owned = assertOwnedThrowawayRepositoryHandle(repo);
	const command = options.runCommand ?? ((name, args, opts = {}) => runTimedCommand(name, args, { ...opts, spawnSync: options.spawnSync }));
	const run = options.spawnSync ?? spawnSync;
	const sleep = options.sleep ?? ((ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));
	const attempts = options.verificationAttempts ?? 5;
	const cwd = options.cwd;
	const gh = githubCli(options);

	// Re-check remote ownership marker before any destructive delete.
	verifyOwnedRepository(owned, options);
	let deleteError;
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		try {
			command(gh, ["repo", "delete", owned.fullName, "--yes"], { cwd, label: "delete throwaway repository" });
			deleteError = undefined;
			break;
		} catch (error) {
			deleteError = error;
			const probe = probeRepositoryOwnership(owned.fullName, options);
			if (!probe.exists) return { deleted: true, httpStatus: 404 };
			if (!probe.isPrivate || probe.description !== owned.description) {
				fail("throwaway repository ownership changed after delete failed; refusing another delete", error?.details ?? "");
			}
			if (attempt < attempts) sleep(options.verificationDelayMs ?? 500);
		}
	}
	if (deleteError) throw deleteError;
	let output = "";
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		const probe = run(gh, ["api", "-i", `repos/${owned.fullName}`], {
			cwd,
			env: options.env ?? process.env,
			encoding: "utf8",
			maxBuffer: 1024 * 1024,
			timeout: options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
		});
		output = [probe.error?.message, probe.stdout, probe.stderr].filter(Boolean).join("\n");
		if (!probe.error && probe.status !== 0 && explicitHttpStatus(probe.stdout) === "404") {
			return { deleted: true, httpStatus: 404 };
		}
		if (attempt < attempts) sleep(options.verificationDelayMs ?? 500);
	}
	fail("throwaway repository deletion was not independently verified as HTTP 404", output);
}

export function validatePrUrl(repo, prUrl, options = {}) {
	const fullName = String(repo?.fullName ?? "").toLowerCase();
	if (!fullName.includes("/")) fail("throwaway repository fullName is required to validate PR URLs");
	const command = options.runCommand ?? ((name, args, opts = {}) => runTimedCommand(name, args, { ...opts, spawnSync: options.spawnSync }));
	let url;
	try {
		url = new URL(prUrl);
	} catch {
		fail("cloud report returned an invalid PR URL", prUrl);
	}
	if (
		url.protocol !== "https:"
		|| url.username
		|| url.password
		|| url.search
		|| url.hash
		|| url.hostname !== "github.com"
		|| !url.pathname.startsWith(`/${fullName}/pull/`)
	) {
		fail("cloud report returned a PR URL outside the throwaway repository", prUrl);
	}
	const result = JSON.parse(command(githubCli(options), ["pr", "view", prUrl, "--json", "url,state"], {
		cwd: options.cwd,
		label: "validate reported PR URL",
	}));
	if (result.url !== prUrl || typeof result.state !== "string") fail("gh could not validate reported PR URL", prUrl);
	return result;
}
