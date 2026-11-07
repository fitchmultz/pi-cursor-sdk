import { mkdirSync, writeFileSync } from "node:fs";
import { devNull } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	inspectCursorCloudLocalState,
	normalizeCursorCloudStartingRef,
	runCursorCloudGit,
	sanitizeCursorCloudGitEnvironment,
	type CursorCloudGitRunner,
} from "../src/cursor-cloud-local-state.js";
import { preflightCursorCloudRuntime } from "../src/cursor-cloud-options.js";
import { resolveCursorSdkConfig } from "../src/cursor-config.js";
import { useTrackedGitRepoFixture, runGit as git } from "./helpers/git-repo.js";

describe("Cursor cloud local state identity", () => {
	const defaultRemote = "https://github.com/example/repo.git";
	const fixture = useTrackedGitRepoFixture();
	const { initTrackedRepo } = fixture;

	it("scrubs Git child environment names case-insensitively and installs canonical null config", () => {
		const env = sanitizeCursorCloudGitEnvironment({
			PATH: "/bin",
			git_dir: "/tmp/wrong",
			GiT_InDeX_FiLe: "/tmp/index",
			git_config_key_0: "url.test.insteadOf",
			GIT_CONFIG_VALUE_0: "secret",
			gIt_CeIlInG_DiReCtOrIeS: "/tmp",
		});

		expect(env).toEqual({
			PATH: "/bin",
			GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : devNull,
			GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : devNull,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_NO_REPLACE_OBJECTS: "1",
		});
	});

	it("returns Git output larger than Node's default 1 MiB buffer", () => {
		git(fixture.root, ["init"]);
		const blobPath = join(fixture.root, "two-megabyte-blob");
		writeFileSync(blobPath, "x".repeat(2 * 1024 * 1024));
		const oid = git(fixture.root, ["hash-object", "-w", blobPath]);

		expect(runCursorCloudGit(fixture.root, ["cat-file", "blob", oid])?.length).toBe(2 * 1024 * 1024);
	});

	it.each([
		["overlapping", "+refs/heads/*main:refs/remotes/orig*gin/main", "unknown"],
		["non-overlapping", "+refs/heads/*main:refs/remotes/ori*gin/main", "contains_head"],
	] as const)("checks %s wildcard prefix and suffix against the tracking ref", (_label, refspec, comparison) => {
		initTrackedRepo(fixture.root);
		git(fixture.root, ["config", "--replace-all", "remote.origin.fetch", refspec]);

		expect(inspectCursorCloudLocalState(fixture.root, { repo: defaultRemote, branch: "main" })).toMatchObject({
			insideGitRepo: true,
			dirty: false,
			comparison,
			...(comparison === "unknown" ? { reasons: [{ code: "unverified_target" }] } : {}),
		});
	});

	it("reports unborn HEAD and dirty state together in one preflight message", () => {
		git(fixture.root, ["init"]);
		writeFileSync(join(fixture.root, "untracked.txt"), "local");
		const localState = inspectCursorCloudLocalState(fixture.root);
		const result = preflightCursorCloudRuntime({
			resolvedConfig: resolveCursorSdkConfig({
				cli: { runtime: "cloud", cloud: { acknowledged: true } },
			}),
			localState,
		});

		expect(localState).toMatchObject({
			insideGitRepo: true,
			dirty: true,
			comparison: "unknown",
			reasons: expect.arrayContaining([{ code: "head_unavailable" }, { code: "unverified_target" }]),
		});
		expect(result.issues[0]?.message).toContain("worktree or index is dirty");
		expect(result.issues[0]?.message).toContain("local HEAD is unavailable");
	});

	it.each([
		["status failure", "status_failed", (args: string[]) => args.includes("status")],
		["index failure", "index_failed", (args: string[]) => args[0] === "ls-files"],
		["history failure", "history_probe_failed", (args: string[]) => args.includes("refs/replace")],
		["comparison failure", "comparison_failed", (args: string[]) => args[0] === "rev-list"],
	] as const)("preserves %s provenance", (_label, code, shouldFail) => {
		const runner: CursorCloudGitRunner = (_cwd, args) => {
			if (shouldFail(args)) return undefined;
			const command = args.join(" ");
			if (command === "rev-parse --is-inside-work-tree") return "true";
			if (args.includes("status")) return "";
			if (args[0] === "ls-files") return "H file.txt";
			if (command === "for-each-ref --format=%(refname) refs/replace") return "";
			if (command === "rev-parse --git-path info/grafts") return ".git/info/grafts";
			if (command === "rev-parse --verify HEAD") return "a".repeat(40);
			if (command === "rev-parse --abbrev-ref --symbolic-full-name @{upstream}") return "origin/main";
			if (command === "remote") return "origin";
			if (args[0] === "config" && args.includes("--null")) {
				return "remote.origin.url\nhttps://github.com/example/repo.git\0";
			}
			if (args[0] === "remote" && args.includes("get-url")) return "https://github.com/example/repo.git";
			if (command === "config --get-regexp ^remote\\..*\\.fetch$") return "remote.origin.fetch +refs/heads/*:refs/remotes/origin/*";
			if (args[0] === "for-each-ref" && args.at(-1) === "refs/remotes/origin/main") return "commit\t";
			if (args[0] === "rev-list") return "0";
			return undefined;
		};

		const state = inspectCursorCloudLocalState(fixture.root, {}, runner);
		expect(state).toMatchObject({
			comparison: "unknown",
			reasons: expect.arrayContaining([{ code }]),
		});
	});

	it.each([
		["empty", ""],
		["whitespace", " "],
		["trailing whitespace", "0 "],
		["hexadecimal", "0x0"],
		["negative", "-1"],
	])("rejects %s ahead-count output", (_label, ahead) => {
		const runner: CursorCloudGitRunner = (_cwd, args) => {
			const command = args.join(" ");
			if (command === "rev-parse --is-inside-work-tree") return "true";
			if (args.includes("status")) return "";
			if (args[0] === "ls-files") return "H file.txt";
			if (command === "for-each-ref --format=%(refname) refs/replace") return "";
			if (command === "rev-parse --git-path info/grafts") return ".git/info/grafts";
			if (command === "rev-parse --verify HEAD") return "a".repeat(40);
			if (command === "rev-parse --abbrev-ref --symbolic-full-name @{upstream}") return "origin/main";
			if (command === "remote") return "origin";
			if (args[0] === "config" && args.includes("--null")) {
				return "remote.origin.url\nhttps://github.com/example/repo.git\0";
			}
			if (args[0] === "remote" && args.includes("get-url")) return "https://github.com/example/repo.git";
			if (command === "config --get-regexp ^remote\\..*\\.fetch$") return "remote.origin.fetch +refs/heads/*:refs/remotes/origin/*";
			if (args[0] === "for-each-ref" && args.at(-1) === "refs/remotes/origin/main") return "commit\t";
			if (args[0] === "rev-list") return ahead;
			return undefined;
		};

		expect(inspectCursorCloudLocalState(fixture.root, {}, runner)).toMatchObject({
			comparison: "unknown",
			reasons: [{ code: "comparison_failed" }],
		});
	});

	it.each([
		["HEAD", "unsupported"],
		["-bad", "unsupported"],
		["foo..bar", "unsupported"],
		["foo.lock", "unsupported"],
		["bad branch", "unsupported"],
		["bad\\branch", "unsupported"],
		["bad~branch", "unsupported"],
		["bad^branch", "unsupported"],
		["bad:branch", "unsupported"],
		["bad?branch", "unsupported"],
		["bad*branch", "unsupported"],
		["bad[branch", "unsupported"],
		["foo//bar", "unsupported"],
		["foo/@{bar", "unsupported"],
		[".hidden", "unsupported"],
		["foo/.hidden", "unsupported"],
		["foo/bar.lock", "unsupported"],
		["foo.", "unsupported"],
		["foo/", "unsupported"],
		["main", "branch"],
		["feature/demo", "branch"],
		["foo]bar", "branch"],
		["@", "branch"],
	] as const)("normalizes Git starting ref %s as %s", (ref, kind) => {
		expect(normalizeCursorCloudStartingRef(ref).kind).toBe(kind);
	});

	it("normalizes refs/heads branches and preserves full commit SHAs", () => {
		expect(normalizeCursorCloudStartingRef("refs/heads/feature/demo")).toEqual({ kind: "branch", value: "feature/demo" });
		const sha = "a".repeat(40);
		expect(normalizeCursorCloudStartingRef(sha)).toEqual({ kind: "commit", value: sha });
	});

	it("matches explicit HTTPS remotes without case, trailing-slash, or .git differences", () => {
		initTrackedRepo(fixture.root, "https://GitHub.com/Example/Repo.git/");

		expect(inspectCursorCloudLocalState(fixture.root, {
			repo: "https://github.com/example/repo",
			branch: "refs/heads/main",
		})).toEqual({ insideGitRepo: true, dirty: false, comparison: "contains_head" });
	});

	it.each([
		["backslash URL", "https:\\github.com\\example\\repo.git"],
		["leading space", " https://github.com/example/repo.git"],
		["trailing space", "https://github.com/example/repo.git "],
		["trailing tab", "https://github.com/example/repo.git\t"],
		["trailing carriage return", "https://github.com/example/repo.git\r"],
		["trailing newline", "https://github.com/example/repo.git\n"],
		["encoded parent segment", "https://github.com/a/%2e%2e/example/repo.git"],
		["empty userinfo", "https://@github.com/example/repo.git"],
		["empty userinfo with delimiter", "https://:@github.com/example/repo.git"],
	])("rejects malformed local remote identity with %s", (_label, remoteUrl) => {
		initTrackedRepo(fixture.root, remoteUrl);

		expect(inspectCursorCloudLocalState(fixture.root, {
			repo: "https://github.com/example/repo.git",
			branch: "main",
		})).toMatchObject({ comparison: "unknown", reasons: [{ code: "unverified_target" }] });
	});

	it.each([
		["SSH URL", "ssh://git@github.com/Example/Repo.git"],
		["scp URL", "git@github.com:Example/Repo.git"],
	])("matches an explicit HTTPS repository to a %s local remote", (_label, remoteUrl) => {
		initTrackedRepo(fixture.root, remoteUrl);

		expect(inspectCursorCloudLocalState(fixture.root, {
			repo: "https://github.com/example/repo",
			branch: "main",
		})).toEqual({ insideGitRepo: true, dirty: false, comparison: "contains_head" });
	});

	it("matches mixed SSH fetch and scp push identities for the same repository", () => {
		initTrackedRepo(fixture.root, "ssh://git@github.com/Example/Repo.git");
		git(fixture.root, ["remote", "set-url", "--push", "origin", "git@github.com:example/repo.git"]);

		expect(inspectCursorCloudLocalState(fixture.root, {
			repo: "https://github.com/example/repo",
			branch: "main",
		})).toEqual({ insideGitRepo: true, dirty: false, comparison: "contains_head" });
	});

	it.each([
		["generic SSH URL", "ssh://git@git.example/repo.git", "https://git.example/repo.git"],
		["generic scp URL", "git@git.example:repo.git", "https://git.example/repo.git"],
		["DOS drive path", "C:repo.git", "https://c/repo.git"],
	])("does not equate a %s with HTTPS", (_label, remoteUrl, repo) => {
		initTrackedRepo(fixture.root, remoteUrl);

		expect(inspectCursorCloudLocalState(fixture.root, { repo, branch: "main" })).toMatchObject({
			comparison: "unknown",
			reasons: [{ code: "unverified_target" }],
		});
	});

	it("fails closed when SSH fetch and push identities differ", () => {
		initTrackedRepo(fixture.root, "ssh://git@github.com/example/repo.git");
		git(fixture.root, ["remote", "set-url", "--push", "origin", "git@github.com:example/other.git"]);

		expect(inspectCursorCloudLocalState(fixture.root, {
			repo: "https://github.com/example/repo",
			branch: "main",
		})).toMatchObject({ insideGitRepo: true, dirty: false, comparison: "unknown" });
	});

	it("does not fold path case for unknown HTTPS Git hosts", () => {
		initTrackedRepo(fixture.root, "https://git.example/Org/Repo.git");

		expect(inspectCursorCloudLocalState(fixture.root, {
			repo: "https://git.example/org/repo.git",
			branch: "main",
		})).toMatchObject({ insideGitRepo: true, dirty: false, comparison: "unknown" });
	});

	it.each([
		["mixed-case GitHub suffix", "https://github.com/example/repo.GIT", "https://github.com/example/repo"],
		["generic-host suffix", "https://git.example/Org/Repo.git", "https://git.example/Org/Repo"],
	])("does not normalize an unverified %s", (_label, remoteUrl, repo) => {
		initTrackedRepo(fixture.root, remoteUrl);

		expect(inspectCursorCloudLocalState(fixture.root, { repo, branch: "main" })).toMatchObject({
			insideGitRepo: true,
			dirty: false,
			comparison: "unknown",
		});
	});

	it("fails closed when the explicit repo does not match a local remote unless local state is allowed", () => {
		initTrackedRepo(fixture.root);
		const localState = inspectCursorCloudLocalState(fixture.root, {
			repo: "https://github.com/other/repo.git",
			branch: "main",
		});

		expect(localState).toMatchObject({ insideGitRepo: true, dirty: false, comparison: "unknown" });
		expect(preflightCursorCloudRuntime({
			resolvedConfig: resolveCursorSdkConfig({
				cli: {
					runtime: "cloud",
					cloud: { acknowledged: true, repo: "https://github.com/other/repo.git", branch: "main" },
				},
			}),
			localState,
		}).issues.map((issue) => issue.code)).toEqual(["local_state_not_allowed"]);
		expect(preflightCursorCloudRuntime({
			resolvedConfig: resolveCursorSdkConfig({
				cli: {
					runtime: "cloud",
					cloud: {
						acknowledged: true,
						allowLocalState: true,
						repo: "https://github.com/other/repo.git",
						branch: "main",
					},
				},
			}),
			localState,
		})).toEqual({ ok: true, issues: [] });
	});

	it("fails closed when more than one local remote matches the explicit repo", () => {
		initTrackedRepo(fixture.root);
		git(fixture.root, ["remote", "add", "mirror", "https://github.com/EXAMPLE/repo"]);

		expect(inspectCursorCloudLocalState(fixture.root, {
			repo: "https://github.com/example/repo.git",
			branch: "main",
		})).toMatchObject({ insideGitRepo: true, dirty: false, comparison: "unknown" });
	});

	it("fails closed when one remote has mixed repository URLs", () => {
		initTrackedRepo(fixture.root);
		git(fixture.root, ["config", "--add", "remote.origin.url", "https://github.com/other/repo.git"]);

		expect(inspectCursorCloudLocalState(fixture.root, {
			repo: "https://github.com/example/repo.git",
			branch: "main",
		})).toMatchObject({ insideGitRepo: true, dirty: false, comparison: "unknown" });
	});

	it.each([
		["insteadOf", ["config", "url.https://github.com/other/.insteadOf", "https://github.com/example/"]],
		["pushInsteadOf", ["config", "url.https://github.com/other/.pushInsteadOf", "https://github.com/example/"]],
		["pushurl", ["remote", "set-url", "--push", "origin", "https://github.com/other/repo.git"]],
	])("fails closed when Git rewrites the effective %s destination", (_label, command) => {
		initTrackedRepo(fixture.root);
		git(fixture.root, command);

		expect(inspectCursorCloudLocalState(fixture.root, {
			repo: "https://github.com/example/repo.git",
			branch: "main",
		})).toMatchObject({ insideGitRepo: true, dirty: false, comparison: "unknown" });
	});

	it("fails closed when a local rewrite destination has a trailing carriage return", () => {
		initTrackedRepo(fixture.root, "https://source.example/repo.git");
		git(fixture.root, [
			"config",
			"url.https://github.com/example/repo.git\r.insteadOf",
			"https://source.example/repo.git",
		]);

		expect(inspectCursorCloudLocalState(fixture.root, {
			repo: "https://github.com/example/repo.git",
			branch: "main",
		})).toMatchObject({ comparison: "unknown", reasons: [{ code: "unverified_target" }] });
	});

	it("ignores global pushInsteadOf when an explicit pushurl is configured", () => {
		initTrackedRepo(fixture.root);
		git(fixture.root, ["remote", "set-url", "--push", "origin", "https://github.com/example/repo.git"]);
		const home = join(fixture.root, ".git", "inactive-push-rewrite-home");
		mkdirSync(home);
		writeFileSync(
			join(home, ".gitconfig"),
			'[url "https://github.com/other/"]\n\tpushInsteadOf = https://github.com/example/\n',
		);
		const previousHome = process.env.HOME;
		process.env.HOME = home;

		try {
			expect(inspectCursorCloudLocalState(fixture.root, {
				repo: "https://github.com/example/repo.git",
				branch: "main",
			})).toEqual({ insideGitRepo: true, dirty: false, comparison: "contains_head" });
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
		}
	});

	it("ignores a shorter global rewrite shadowed by a local longest-prefix match", () => {
		initTrackedRepo(fixture.root, "https://source.example/org/repo.git");
		git(fixture.root, [
			"config",
			"url.https://github.com/example/repo.git.insteadOf",
			"https://source.example/org/repo.git",
		]);
		const home = join(fixture.root, ".git", "shadowed-rewrite-home");
		mkdirSync(home);
		writeFileSync(
			join(home, ".gitconfig"),
			'[url "https://github.com/other/"]\n\tinsteadOf = https://source.example/\n',
		);
		const previousHome = process.env.HOME;
		process.env.HOME = home;

		try {
			expect(inspectCursorCloudLocalState(fixture.root, {
				repo: "https://github.com/example/repo.git",
				branch: "main",
			})).toEqual({ insideGitRepo: true, dirty: false, comparison: "contains_head" });
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
		}
	});

	it("fails closed for an explicit repo without a starting ref because the server default is not locally provable", () => {
		initTrackedRepo(fixture.root);
		const localState = inspectCursorCloudLocalState(fixture.root, {
			repo: "https://github.com/example/repo.git",
		});

		expect(localState).toEqual({
			insideGitRepo: true,
			dirty: false,
			comparison: "unknown",
			reasons: [{ code: "unverified_target" }],
		});
		expect(preflightCursorCloudRuntime({
			resolvedConfig: resolveCursorSdkConfig({
				cli: { runtime: "cloud", cloud: { acknowledged: true, repo: "https://github.com/example/repo.git" } },
			}),
			localState,
		}).issues.map((issue) => issue.code)).toEqual(["local_state_not_allowed"]);
		expect(preflightCursorCloudRuntime({
			resolvedConfig: resolveCursorSdkConfig({
				cli: { runtime: "cloud", cloud: { acknowledged: true, allowLocalState: true, repo: "https://github.com/example/repo.git" } },
			}),
			localState,
		})).toEqual({ ok: true, issues: [] });
	});

});
