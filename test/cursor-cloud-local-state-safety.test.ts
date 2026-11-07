import { appendFileSync, chmodSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	inspectCursorCloudLocalState,
	runCursorCloudGit,
} from "../src/cursor-cloud-local-state.js";
import { preflightCursorCloudRuntime } from "../src/cursor-cloud-options.js";
import { resolveCursorSdkConfig } from "../src/cursor-config.js";
import { useTrackedGitRepoFixture, runGit as git } from "./helpers/git-repo.js";

describe("Cursor cloud local state safety", () => {
	const fixture = useTrackedGitRepoFixture();
	const { initTrackedRepo } = fixture;

	it("preserves current-upstream validation when no explicit target is configured", () => {
		initTrackedRepo(fixture.root);

		expect(inspectCursorCloudLocalState(fixture.root)).toEqual({
			insideGitRepo: true,
			dirty: false,
			comparison: "contains_head",
		});
		git(fixture.root, ["branch", "--unset-upstream"]);
		expect(inspectCursorCloudLocalState(fixture.root)).toMatchObject({
			insideGitRepo: true,
			dirty: false,
			comparison: "unknown",
		});
	});

	it("fails closed without an explicit target when upstream fetch/push identity is ambiguous", () => {
		initTrackedRepo(fixture.root);
		git(fixture.root, ["remote", "set-url", "--push", "origin", "https://github.com/other/repo.git"]);

		expect(inspectCursorCloudLocalState(fixture.root)).toMatchObject({
			insideGitRepo: true,
			dirty: false,
			comparison: "unknown",
		});
	});

	it("fails closed for a local-only upstream", () => {
		initTrackedRepo(fixture.root);
		git(fixture.root, ["config", "branch.main.remote", "."]);
		git(fixture.root, ["config", "branch.main.merge", "refs/heads/main"]);

		expect(inspectCursorCloudLocalState(fixture.root)).toMatchObject({
			insideGitRepo: true,
			dirty: false,
			comparison: "unknown",
		});
	});

	it("fails closed when the requested remote-tracking ref is missing", () => {
		initTrackedRepo(fixture.root);

		expect(inspectCursorCloudLocalState(fixture.root, {
			repo: "https://github.com/example/repo.git",
			branch: "missing",
		})).toMatchObject({ insideGitRepo: true, dirty: false, comparison: "unknown" });
	});

	it.each([
		["missing", ["config", "--unset-all", "remote.origin.fetch"]],
		["retargeted", ["config", "--replace-all", "remote.origin.fetch", "+refs/heads/*:refs/other/*"]],
		["excluded", ["config", "--add", "remote.origin.fetch", "^refs/heads/main"]],
	])("fails closed when the requested branch has a %s fetch refspec", (_label, command) => {
		initTrackedRepo(fixture.root);
		git(fixture.root, command);

		expect(inspectCursorCloudLocalState(fixture.root, {
			repo: "https://github.com/example/repo.git",
			branch: "main",
		})).toMatchObject({ insideGitRepo: true, dirty: false, comparison: "unknown" });
	}, 15_000);

	it.each([
		["forced negative", "+^refs/heads/main"],
		["mismatched wildcard", "+refs/heads/main:refs/remotes/origin/*"],
		["multiple wildcards", "+refs/heads/**:refs/remotes/origin/**"],
	])("fails closed when a %s fetch refspec is configured", (_label, refspec) => {
		initTrackedRepo(fixture.root);
		git(fixture.root, ["config", "--add", "remote.origin.fetch", refspec]);

		expect(inspectCursorCloudLocalState(fixture.root, {
			repo: "https://github.com/example/repo.git",
			branch: "main",
		})).toMatchObject({ insideGitRepo: true, dirty: false, comparison: "unknown" });
	});

	it("fails closed when another remote can write the target tracking ref", () => {
		initTrackedRepo(fixture.root);
		git(fixture.root, ["remote", "add", "other", "https://github.com/other/repo.git"]);
		git(fixture.root, ["config", "remote.other.fetch", "+refs/heads/*:refs/remotes/origin/*"]);

		expect(inspectCursorCloudLocalState(fixture.root, {
			repo: "https://github.com/example/repo.git",
			branch: "main",
		})).toMatchObject({ insideGitRepo: true, dirty: false, comparison: "unknown" });
	}, 15_000);

	it("fails closed when another source can write the target tracking ref", () => {
		initTrackedRepo(fixture.root);
		git(fixture.root, ["config", "--add", "remote.origin.fetch", "+refs/other/*:refs/remotes/origin/*"]);

		expect(inspectCursorCloudLocalState(fixture.root, {
			repo: "https://github.com/example/repo.git",
			branch: "main",
		})).toMatchObject({ insideGitRepo: true, dirty: false, comparison: "unknown" });
	});

	it("fails closed for symbolic remote-tracking refs", () => {
		initTrackedRepo(fixture.root);
		git(fixture.root, ["symbolic-ref", "refs/remotes/origin/main", "refs/heads/main"]);

		expect(inspectCursorCloudLocalState(fixture.root, {
			repo: "https://github.com/example/repo.git",
			branch: "main",
		})).toMatchObject({ insideGitRepo: true, dirty: false, comparison: "unknown" });
	});

	it("fails closed for local refs that do not prove remote observability", () => {
		initTrackedRepo(fixture.root);
		git(fixture.root, ["tag", "local-only"]);

		expect(inspectCursorCloudLocalState(fixture.root, {
			repo: "https://github.com/example/repo.git",
			branch: "refs/tags/local-only",
		})).toMatchObject({ insideGitRepo: true, dirty: false, comparison: "unknown" });
	});

	it("detects commits ahead of the requested remote-tracking ref", () => {
		initTrackedRepo(fixture.root);
		appendFileSync(join(fixture.root, "src", "file.txt"), "ahead");
		git(fixture.root, ["add", "."]);
		git(fixture.root, ["commit", "-m", "ahead"]);

		expect(inspectCursorCloudLocalState(fixture.root, {
			repo: "https://github.com/example/repo.git",
			branch: "main",
		})).toEqual({ insideGitRepo: true, dirty: false, comparison: "unpushed" });
	});

	it("accepts a clean HEAD behind the requested remote-tracking ref", () => {
		initTrackedRepo(fixture.root);
		appendFileSync(join(fixture.root, "src", "file.txt"), "remote");
		git(fixture.root, ["add", "."]);
		git(fixture.root, ["commit", "-m", "remote"]);
		git(fixture.root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
		git(fixture.root, ["reset", "--hard", "HEAD^"]);

		expect(inspectCursorCloudLocalState(fixture.root, {
			repo: "https://github.com/example/repo.git",
			branch: "main",
		})).toEqual({ insideGitRepo: true, dirty: false, comparison: "contains_head" });
	});

	it.each([
		["assume-unchanged", ["update-index", "--assume-unchanged", "src/file.txt"]],
		["skip-worktree", ["update-index", "--skip-worktree", "src/file.txt"]],
	])("fails closed for tracked changes hidden by %s", (_label, command) => {
		initTrackedRepo(fixture.root);
		git(fixture.root, command);
		appendFileSync(join(fixture.root, "src", "file.txt"), "hidden local change");

		expect(inspectCursorCloudLocalState(fixture.root, {
			repo: "https://github.com/example/repo.git",
			branch: "main",
		})).toMatchObject({ insideGitRepo: true, dirty: false, comparison: "unknown" });
	});

	it("finds hidden root-level index state when inspection starts in a subdirectory", () => {
		initTrackedRepo(fixture.root);
		writeFileSync(join(fixture.root, "top.txt"), "base");
		git(fixture.root, ["add", "top.txt"]);
		git(fixture.root, ["commit", "-m", "add top-level file"]);
		git(fixture.root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
		git(fixture.root, ["update-index", "--skip-worktree", "top.txt"]);
		writeFileSync(join(fixture.root, "top.txt"), "hidden local change");

		expect(inspectCursorCloudLocalState(join(fixture.root, "src"), {
			repo: "https://github.com/example/repo.git",
			branch: "main",
		})).toMatchObject({
			insideGitRepo: true,
			dirty: false,
			comparison: "unknown",
			reasons: [{ code: "hidden_index_state" }],
		});
	});

	it.skipIf(process.platform === "win32")("detects mode-only changes even when core.fileMode is disabled", () => {
		initTrackedRepo(fixture.root);
		git(fixture.root, ["config", "core.fileMode", "false"]);
		chmodSync(join(fixture.root, "src", "file.txt"), 0o755);

		expect(inspectCursorCloudLocalState(fixture.root, {
			repo: "https://github.com/example/repo.git",
			branch: "main",
		})).toEqual({ insideGitRepo: true, dirty: true, comparison: "contains_head" });
	});

	it("ignores an ambient alternate Git index", () => {
		initTrackedRepo(fixture.root);
		const alternateIndex = join(fixture.root, ".git", "alternate-index");
		copyFileSync(join(fixture.root, ".git", "index"), alternateIndex);
		git(fixture.root, ["rm", "--cached", "src/file.txt"]);
		const previousIndex = process.env.GIT_INDEX_FILE;
		process.env.GIT_INDEX_FILE = alternateIndex;

		try {
			expect(inspectCursorCloudLocalState(fixture.root, {
				repo: "https://github.com/example/repo.git",
				branch: "main",
			})).toEqual({ insideGitRepo: true, dirty: true, comparison: "contains_head" });
		} finally {
			if (previousIndex === undefined) delete process.env.GIT_INDEX_FILE;
			else process.env.GIT_INDEX_FILE = previousIndex;
		}
	});

	it("ignores ambient Git global-config redirection", () => {
		initTrackedRepo(fixture.root, "https://github.com/other/repo.git");
		const alternateConfig = join(fixture.root, ".git", "alternate-global-config");
		writeFileSync(alternateConfig, '[url "https://github.com/example/"]\n\tinsteadOf = https://github.com/other/\n');
		const previousGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
		process.env.GIT_CONFIG_GLOBAL = alternateConfig;

		try {
			expect(inspectCursorCloudLocalState(fixture.root, {
				repo: "https://github.com/example/repo.git",
				branch: "main",
			})).toMatchObject({ insideGitRepo: true, dirty: false, comparison: "unknown" });
		} finally {
			if (previousGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
			else process.env.GIT_CONFIG_GLOBAL = previousGlobalConfig;
		}
	});

	it("ignores ambient default global Git config", () => {
		initTrackedRepo(fixture.root, "https://github.com/other/repo.git");
		const home = join(fixture.root, ".git", "fake-home");
		mkdirSync(home);
		writeFileSync(join(home, ".gitconfig"), '[url "https://github.com/example/"]\n\tinsteadOf = https://github.com/other/\n');
		const previousHome = process.env.HOME;
		process.env.HOME = home;

		try {
			expect(inspectCursorCloudLocalState(fixture.root, {
				repo: "https://github.com/example/repo.git",
				branch: "main",
			})).toMatchObject({ insideGitRepo: true, dirty: false, comparison: "unknown" });
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
		}
	});

	it.each([
		["space", " "],
		["carriage return", "\r"],
	])("preserves a trailing %s so ordinary URL rewrites can veto authorization", (_label, suffix) => {
		initTrackedRepo(fixture.root);
		const home = join(fixture.root, ".git", "whitespace-rewrite-home");
		mkdirSync(home);
		writeFileSync(
			join(home, ".gitconfig"),
			`[url "https://github.com/example/repo.git${suffix}"]\n\tinsteadOf = https://github.com/example/repo.git\n`,
		);
		const previousHome = process.env.HOME;
		process.env.HOME = home;

		try {
			expect(inspectCursorCloudLocalState(fixture.root, {
				repo: "https://github.com/example/repo.git",
				branch: "main",
			})).toMatchObject({
				comparison: "unknown",
				reasons: [{ code: "target_probe_failed" }],
			});
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
		}
	});

	it("lets ordinary global URL rewrites veto hermetic target authorization", () => {
		initTrackedRepo(fixture.root, "https://git.example/repo.git");
		const home = join(fixture.root, ".git", "rewrite-home");
		mkdirSync(home);
		writeFileSync(
			join(home, ".gitconfig"),
			'[url "ssh://git@git.example/other/"]\n\tinsteadOf = https://git.example/\n',
		);
		const previousHome = process.env.HOME;
		process.env.HOME = home;

		try {
			expect(inspectCursorCloudLocalState(fixture.root, {
				repo: "https://git.example/repo.git",
				branch: "main",
			})).toMatchObject({
				insideGitRepo: true,
				dirty: false,
				comparison: "unknown",
				reasons: [{ code: "target_probe_failed" }],
			});
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
		}
	});

	it("fails closed when replacement refs can alter ancestry", () => {
		initTrackedRepo(fixture.root);
		appendFileSync(join(fixture.root, "src", "file.txt"), "ahead");
		git(fixture.root, ["add", "."]);
		git(fixture.root, ["commit", "-m", "ahead"]);
		git(fixture.root, ["replace", "HEAD", "refs/remotes/origin/main"]);

		expect(inspectCursorCloudLocalState(fixture.root, {
			repo: "https://github.com/example/repo.git",
			branch: "main",
		})).toMatchObject({ insideGitRepo: true, dirty: false, comparison: "unknown" });
	});

	it("fails closed when graft metadata can alter ancestry", () => {
		initTrackedRepo(fixture.root);
		mkdirSync(join(fixture.root, ".git", "info"), { recursive: true });
		writeFileSync(join(fixture.root, ".git", "info", "grafts"), "");

		expect(inspectCursorCloudLocalState(fixture.root, {
			repo: "https://github.com/example/repo.git",
			branch: "main",
		})).toMatchObject({ insideGitRepo: true, dirty: false, comparison: "unknown" });
	});

	it("detects a dirty tree against an otherwise contained explicit target", () => {
		initTrackedRepo(fixture.root);
		appendFileSync(join(fixture.root, "src", "file.txt"), "dirty");

		expect(inspectCursorCloudLocalState(fixture.root, {
			repo: "https://github.com/example/repo.git",
			branch: "main",
		})).toEqual({ insideGitRepo: true, dirty: true, comparison: "contains_head" });
	});

	it("detects untracked files even when Git config hides them by default", () => {
		initTrackedRepo(fixture.root);
		git(fixture.root, ["config", "status.showUntrackedFiles", "no"]);
		writeFileSync(join(fixture.root, "untracked.txt"), "local only");

		expect(inspectCursorCloudLocalState(fixture.root, {
			repo: "https://github.com/example/repo.git",
			branch: "main",
		})).toEqual({ insideGitRepo: true, dirty: true, comparison: "contains_head" });
	});

	it("detects modified submodules even when Git config hides them by default", () => {
		const main = join(fixture.root, "main");
		const dependency = join(fixture.root, "dependency");
		mkdirSync(main);
		mkdirSync(dependency);
		initTrackedRepo(main);
		initTrackedRepo(dependency, "https://github.com/example/dependency.git");
		git(main, ["-c", "protocol.file.allow=always", "submodule", "add", dependency, "dependency"]);
		git(main, ["commit", "-am", "add dependency"]);
		git(main, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
		git(main, ["config", "submodule.dependency.ignore", "all"]);
		appendFileSync(join(main, "dependency", "src", "file.txt"), "local only");

		expect(inspectCursorCloudLocalState(main, {
			repo: "https://github.com/example/repo.git",
			branch: "main",
		})).toEqual({ insideGitRepo: true, dirty: true, comparison: "contains_head" });
	}, 15_000);

	it.each([
		["remote listing", (args: string[]) => args.length === 1 && args[0] === "remote"],
		["remote URL", (args: string[]) => args[0] === "remote" && args[1] === "get-url"],
	] as const)("reports target_probe_failed when %s fails", (_label, shouldFail) => {
		initTrackedRepo(fixture.root);
		const state = inspectCursorCloudLocalState(fixture.root, {
			repo: "https://github.com/example/repo.git",
			branch: "main",
		}, (cwd, args) => shouldFail(args) ? undefined : runCursorCloudGit(cwd, args));

		expect(state).toMatchObject({
			insideGitRepo: true,
			dirty: false,
			comparison: "unknown",
			reasons: [{ code: "target_probe_failed" }],
		});
	});

	it("uses --no-optional-locks for status inspection", () => {
		initTrackedRepo(fixture.root);
		let statusArgs: string[] | undefined;
		inspectCursorCloudLocalState(fixture.root, {}, (cwd, args) => {
			if (args.includes("status")) statusArgs = args;
			return runCursorCloudGit(cwd, args);
		});
		expect(statusArgs).toContain("--no-optional-locks");
	});

	it("reports unknown cleanliness without claiming the worktree is dirty", () => {
		initTrackedRepo(fixture.root);
		const localState = inspectCursorCloudLocalState(fixture.root, {}, (cwd, args) =>
			args.includes("status") ? undefined : runCursorCloudGit(cwd, args));
		const result = preflightCursorCloudRuntime({
			resolvedConfig: resolveCursorSdkConfig({ cli: { runtime: "cloud", cloud: { acknowledged: true } } }),
			localState,
		});

		expect(localState).toMatchObject({ dirty: "unknown", reasons: [{ code: "status_failed" }] });
		expect(result.issues[0]?.message).toBe(
			"Cursor cloud runtime cannot safely omit local state because Git could not determine whether the worktree or index is clean. Configure an explicit repository branch/ref with current local tracking evidence, or pass --cursor-cloud-allow-local-state only after accepting that risk.",
		);
		expect(result.issues[0]?.message).not.toContain("is dirty");
	});

	it("fails closed inside a bare repository", () => {
		git(fixture.root, ["init", "--bare"]);

		expect(inspectCursorCloudLocalState(fixture.root)).toEqual({
			insideGitRepo: true,
			dirty: "unknown",
			comparison: "unknown",
			reasons: [{ code: "bare_repo" }],
		});
	});

	it("recognizes an ordinary directory when Git is available", () => {
		expect(inspectCursorCloudLocalState(fixture.root)).toEqual({ insideGitRepo: false });
	});

	it("fails closed when repository discovery fails in an empty directory", () => {
		const localState = inspectCursorCloudLocalState(fixture.root, {}, () => undefined);
		const result = preflightCursorCloudRuntime({
			resolvedConfig: resolveCursorSdkConfig({ cli: { runtime: "cloud", cloud: { acknowledged: true } } }),
			localState,
		});

		expect(localState).toEqual({
			insideGitRepo: "unknown",
			dirty: "unknown",
			comparison: "unknown",
			reasons: [{ code: "repository_detection_failed" }],
		});
		expect(result.issues[0]?.message).toBe(
			"Cursor cloud runtime cannot safely omit local state because Git could not determine whether the worktree or index is clean; Git could not determine whether the working directory is a repository. Configure an explicit repository branch/ref with current local tracking evidence, or pass --cursor-cloud-allow-local-state only after accepting that risk.",
		);
	});

	it.each(["bare", "worktree"])("fails closed when Git is available but cannot discover %s metadata", (kind) => {
		if (kind === "bare") git(fixture.root, ["init", "--bare"]);
		else mkdirSync(join(fixture.root, ".git"));
		expect(inspectCursorCloudLocalState(fixture.root, {}, (cwd, args) =>
			args[0] === "--version" ? runCursorCloudGit(cwd, args) : undefined)).toEqual({
			insideGitRepo: "unknown",
			dirty: "unknown",
			comparison: "unknown",
			reasons: [{ code: "repository_detection_failed" }],
		});
	});
});
