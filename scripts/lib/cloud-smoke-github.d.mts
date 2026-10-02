export const CLOUD_SMOKE_REPO_NAME_PREFIX: "pi-cursor-cloud-smoke-";
export const CLOUD_SMOKE_OWNERSHIP_TOKEN_PATTERN: RegExp;

export type CloudSmokeOwnedRepository = {
	fullName: string;
	repoUrl: string;
	seedDir: string;
	ownershipToken: string;
	description: string;
};

export function cloudSmokeRepositoryDescription(ownershipToken: string): string;

export function assertOwnedThrowawayRepositoryHandle(repo: unknown): {
	fullName: string;
	ownershipToken: string;
	description: string;
	repoUrl: string;
	seedDir?: string;
};

export function runTimedCommand(
	commandName: string,
	commandArgs: readonly string[],
	options?: {
		cwd?: string;
		env?: NodeJS.ProcessEnv;
		label?: string;
		maxBuffer?: number;
		timeoutMs?: number;
		spawnSync?: typeof import("node:child_process").spawnSync;
	},
): string;

export function authenticatedGitArgs(commandArgs: readonly string[]): string[];

export function normalizeCloudSmokeGitHubRepo(value: unknown): string | undefined;

export function createThrowawayRepository(
	artifactRoot: string,
	onOwned?: (repo: CloudSmokeOwnedRepository) => void,
	options?: {
		cwd?: string;
		githubCli?: string;
		randomUUID?: () => string;
		runCommand?: (commandName: string, commandArgs: readonly string[], options?: Record<string, unknown>) => string;
		spawnSync?: typeof import("node:child_process").spawnSync;
		writeFileSync?: typeof import("node:fs").writeFileSync;
		env?: NodeJS.ProcessEnv;
		timeoutMs?: number;
		verificationAttempts?: number;
		verificationDelayMs?: number;
		sleep?: (milliseconds: number) => unknown;
	},
): CloudSmokeOwnedRepository;

export function deleteThrowawayRepository(
	repo: CloudSmokeOwnedRepository | { fullName: string; ownershipToken: string; description: string; repoUrl?: string; seedDir?: string },
	options?: {
		cwd?: string;
		githubCli?: string;
		env?: NodeJS.ProcessEnv;
		timeoutMs?: number;
		verificationAttempts?: number;
		verificationDelayMs?: number;
		sleep?: (milliseconds: number) => unknown;
		runCommand?: (commandName: string, commandArgs: readonly string[], options?: Record<string, unknown>) => string;
		spawnSync?: typeof import("node:child_process").spawnSync;
	},
): { deleted: true; httpStatus: 404 };

export function validatePrUrl(
	repo: { fullName: string },
	prUrl: string,
	options?: {
		cwd?: string;
		githubCli?: string;
		runCommand?: (commandName: string, commandArgs: readonly string[], options?: Record<string, unknown>) => string;
		spawnSync?: typeof import("node:child_process").spawnSync;
	},
): { url: string; state: string };
