import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";
import { sanitizeCursorCloudGitEnvironment } from "../../src/cursor-cloud-local-state.js";

export function runGit(cwd: string, args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		env: sanitizeCursorCloudGitEnvironment(),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();
}

export function initTrackedGitRepo(cwd: string, remoteUrl = "https://github.com/example/repo.git"): void {
	runGit(cwd, ["init"]);
	runGit(cwd, ["config", "user.email", "test@example.com"]);
	runGit(cwd, ["config", "user.name", "Test User"]);
	mkdirSync(join(cwd, "src"), { recursive: true });
	writeFileSync(join(cwd, "src", "file.txt"), "base");
	runGit(cwd, ["add", "."]);
	runGit(cwd, ["commit", "-m", "base"]);
	runGit(cwd, ["branch", "-M", "main"]);
	runGit(cwd, ["remote", "add", "origin", remoteUrl]);
	runGit(cwd, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
	runGit(cwd, ["branch", "--set-upstream-to=origin/main"]);
}

// Ambient Git probes read HOME/.gitconfig and $XDG_CONFIG_HOME/git/config, so the
// suite swaps both to empty dirs to isolate it from host url.*.insteadOf rewrites.
// The swap is describe-scoped and shared by every case: cases that need hostile Git
// config must point HOME/XDG at their own temp dir, never write to the shared ones.
// Each case still gets independent Git metadata copied from one tracked template.
export function useTrackedGitRepoFixture() {
	const defaultRemote = "https://github.com/example/repo.git";
	let template: string;
	let root: string;
	let cleanHome: string;
	let cleanXdgConfigHome: string;
	let previousHome: string | undefined;
	let previousXdgConfigHome: string | undefined;

	beforeAll(() => {
		cleanHome = mkdtempSync(join(tmpdir(), "pi-cursor-cloud-local-state-home-"));
		cleanXdgConfigHome = mkdtempSync(join(tmpdir(), "pi-cursor-cloud-local-state-xdg-"));
		previousHome = process.env.HOME;
		previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
		process.env.HOME = cleanHome;
		process.env.XDG_CONFIG_HOME = cleanXdgConfigHome;
		template = mkdtempSync(join(tmpdir(), "pi-cursor-cloud-local-state-template-"));
		initTrackedGitRepo(template);
	});

	afterAll(() => {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
		rmSync(template, { recursive: true, force: true });
		rmSync(cleanHome, { recursive: true, force: true });
		rmSync(cleanXdgConfigHome, { recursive: true, force: true });
	});

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-cursor-cloud-local-state-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	return {
		get root() {
			return root;
		},
		initTrackedRepo(cwd: string, remoteUrl = defaultRemote): void {
			cpSync(template, cwd, { recursive: true });
			if (remoteUrl !== defaultRemote) runGit(cwd, ["remote", "set-url", "origin", remoteUrl]);
		},
	};
}
