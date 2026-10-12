import { appendFileSync, chmodSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	inspectCursorCloudLocalState,
	normalizeCursorCloudStartingRef,
	runCursorCloudGit,
	sanitizeCursorCloudGitEnvironment,
	type CursorCloudGitRunner,
} from "../src/cursor-cloud-local-state.js";
import { preflightCursorCloudRuntime } from "../src/cursor-cloud-options.js";
import { resolveCursorSdkConfig } from "../src/cursor-config.js";
import { initTrackedGitRepo, runGit as git } from "./helpers/git-repo.js";

describe("Cursor cloud local state", () => {
	const defaultRemote = "https://github.com/example/repo.git";
	let template: string;
	let root: string;
	let cleanHome: string;
	let cleanXdgConfigHome: string;
	let previousHome: string | undefined;
	let previousXdgConfigHome: string | undefined;

	beforeAll(() => {
		template = mkdtempSync(join(tmpdir(), "pi-cursor-cloud-local-state-template-"));
		initTrackedGitRepo(template);
	});

	afterAll(() => {
		rmSync(template, { recursive: true, force: true });
	});

	function initTrackedRepo(cwd: string, remoteUrl = defaultRemote): void {
		// Each case gets independent Git metadata; real Git still owns every probe.
		cpSync(template, cwd, { recursive: true });
		if (remoteUrl !== defaultRemote) git(cwd, ["remote", "set-url", "origin", remoteUrl]);
	}

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-cursor-cloud-local-state-"));
		// Ambient git probes read HOME/.gitconfig and $XDG_CONFIG_HOME/git/config.
		// Isolate every case from host url.*.insteadof rewrites.
		cleanHome = mkdtempSync(join(tmpdir(), "pi-cursor-cloud-local-state-home-"));
		cleanXdgConfigHome = mkdtempSync(join(tmpdir(), "pi-cursor-cloud-local-state-xdg-"));
		previousHome = process.env.HOME;
		previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
		process.env.HOME = cleanHome;
		process.env.XDG_CONFIG_HOME = cleanXdgConfigHome;
	});

	afterEach(() => {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
		rmSync(root, { recursive: true, force: true });
		rmSync(cleanHome, { recursive: true, force: true });
		rmSync(cleanXdgConfigHome, { recursive: true, force: true });
	});

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
		git(root, ["init"]);
		const blobPath = join(root, "two-megabyte-blob");
		writeFileSync(blobPath, "x".repeat(2 * 1024 * 1024));
		const oid = git(root, ["hash-object", "-w", blobPath]);

		expect(runCursorCloudGit(root, ["cat-file", "blob", oid])?.length).toBe(2 * 1024 * 1024);
	});

	it.each([
		["overlapping", "+refs/heads/*main:refs/remotes/orig*gin/main", "unknown"],
		["non-overlapping", "+refs/heads/*main:refs/remotes/ori*gin/main", "contains_head"],
	] as const)("checks %s wildcard prefix and suffix against the tracking ref", (_label, refspec, comparison) => {
		initTrackedRepo(root);
		git(root, ["config", "--replace-all", "remote.origin.fetch", refspec]);

		expect(inspectCursorCloudLocalState(root, { repo: defaultRemote, branch: "main" })).toMatchObject({
			insideGitRepo: true,
			dirty: false,
			comparison,
			...(comparison === "unknown" ? { reasons: [{ code: "unverified_target" }] } : {}),
		});
	});

	it("reports unborn HEAD and dirty state together in one preflight message", () => {
		git(root, ["init"]);
		writeFileSync(join(root, "untracked.txt"), "local");
		const localState = inspectCursorCloudLocalState(root);
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

		const state = inspectCursorCloudLocalState(root, {}, runner);
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

		expect(inspectCursorCloudLocalState(root, {}, runner)).toMatchObject({
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
		initTrackedRepo(root, "https://GitHub.com/Example/Repo.git/");

		expect(inspectCursorCloudLocalState(root, {
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
		initTrackedRepo(root, remoteUrl);

		expect(inspectCursorCloudLocalState(root, {
			repo: "https://github.com/example/repo.git",
			branch: "main",
		})).toMatchObject({ comparison: "unknown", reasons: [{ code: "unverified_target" }] });
	});

	it.each([
		["SSH URL", "ssh://git@github.com/Example/Repo.git"],
		["scp URL", "git@github.com:Example/Repo.git"],
	])("matches an explicit HTTPS repository to a %s local remote", (_label, remoteUrl) => {
		initTrackedRepo(root, remoteUrl);

		expect(inspectCursorCloudLocalState(root, {
			repo: "https://github.com/example/repo",
			branch: "main",
		})).toEqual({ insideGitRepo: true, dirty: false, comparison: "contains_head" });
	});

	it("matches mixed SSH fetch and scp push identities for the same repository", () => {
		initTrackedRepo(root, "ssh://git@github.com/Example/Repo.git");
		git(root, ["remote", "set-url", "--push", "origin", "git@github.com:example/repo.git"]);

		expect(inspectCursorCloudLocalState(root, {
			repo: "https://github.com/example/repo",
			branch: "main",
		})).toEqual({ insideGitRepo: true, dirty: false, comparison: "contains_head" });
	});

	it.each([
		["generic SSH URL", "ssh://git@git.example/repo.git", "https://git.example/repo.git"],
		["generic scp URL", "git@git.example:repo.git", "https://git.example/repo.git"],
		["DOS drive path", "C:repo.git", "https://c/repo.git"],
	])("does not equate a %s with HTTPS", (_label, remoteUrl, repo) => {
		initTrackedRepo(root, remoteUrl);

		expect(inspectCursorCloudLocalState(root, { repo, branch: "main" })).toMatchObject({
			comparison: "unknown",
			reasons: [{ code: "unverified_target" }],
		});
	});

	it("fails closed when SSH fetch and push identities differ", () => {
		initTrackedRepo(root, "ssh://git@github.com/example/repo.git");
		git(root, ["remote", "set-url", "--push", "origin", "git@github.com:example/other.git"]);

		expect(inspectCursorCloudLocalState(root, {
			repo: "https://github.com/example/repo",
			branch: "main",
		})).toMatchObject({ insideGitRepo: true, dirty: false, comparison: "unknown" });
	});

	it("does not fold path case for unknown HTTPS Git hosts", () => {
		initTrackedRepo(root, "https://git.example/Org/Repo.git");

		expect(inspectCursorCloudLocalState(root, {
			repo: "https://git.example/org/repo.git",
			branch: "main",
		})).toMatchObject({ insideGitRepo: true, dirty: false, comparison: "unknown" });
	});

	it.each([
		["mixed-case GitHub suffix", "https://github.com/example/repo.GIT", "https://github.com/example/repo"],
		["generic-host suffix", "https://git.example/Org/Repo.git", "https://git.example/Org/Repo"],
	])("does not normalize an unverified %s", (_label, remoteUrl, repo) => {
		initTrackedRepo(root, remoteUrl);

		expect(inspectCursorCloudLocalState(root, { repo, branch: "main" })).toMatchObject({
			insideGitRepo: true,
			dirty: false,
			comparison: "unknown",
		});
	});

	it("fails closed when the explicit repo does not match a local remote unless local state is allowed", () => {
		initTrackedRepo(root);
		const localState = inspectCursorCloudLocalState(root, {
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
		initTrackedRepo(root);
		git(root, ["remote", "add", "mirror", "https://github.com/EXAMPLE/repo"]);

		expect(inspectCursorCloudLocalState(root, {
			repo: "https://github.com/example/repo.git",
			branch: "main",
		})).toMatchObject({ insideGitRepo: true, dirty: false, comparison: "unknown" });
	});

	it("fails closed when one remote has mixed repository URLs", () => {
		initTrackedRepo(root);
		git(root, ["config", "--add", "remote.origin.url", "https://github.com/other/repo.git"]);

		expect(inspectCursorCloudLocalState(root, {
			repo: "https://github.com/example/repo.git",
			branch: "main",
		})).toMatchObject({ insideGitRepo: true, dirty: false, comparison: "unknown" });
	});

	it.each([
		["insteadOf", ["config", "url.https://github.com/other/.insteadOf", "https://github.com/example/"]],
		["pushInsteadOf", ["config", "url.https://github.com/other/.pushInsteadOf", "https://github.com/example/"]],
		["pushurl", ["remote", "set-url", "--push", "origin", "https://github.com/other/repo.git"]],
	])("fails closed when Git rewrites the effective %s destination", (_label, command) => {
		initTrackedRepo(root);
		git(root, command);

		expect(inspectCursorCloudLocalState(root, {
			repo: "https://github.com/example/repo.git",
			branch: "main",
		})).toMatchObject({ insideGitRepo: true, dirty: false, comparison: "unknown" });
	});

	it("fails closed when a local rewrite destination has a trailing carriage return", () => {
		initTrackedRepo(root, "https://source.example/repo.git");
		git(root, [
			"config",
			"url.https://github.com/example/repo.git\r.insteadOf",
			"https://source.example/repo.git",
		]);

		expect(inspectCursorCloudLocalState(root, {
			repo: "https://github.com/example/repo.git",
			branch: "main",
		})).toMatchObject({ comparison: "unknown", reasons: [{ code: "unverified_target" }] });
	});

	it("ignores global pushInsteadOf when an explicit pushurl is configured", () => {
		initTrackedRepo(root);
		git(root, ["remote", "set-url", "--push", "origin", "https://github.com/example/repo.git"]);
		const home = join(root, ".git", "inactive-push-rewrite-home");
		mkdirSync(home);
		writeFileSync(
			join(home, ".gitconfig"),
			'[url "https://github.com/other/"]\n\tpushInsteadOf = https://github.com/example/\n',
		);
		const previousHome = process.env.HOME;
		process.env.HOME = home;

		try {
			expect(inspectCursorCloudLocalState(root, {
				repo: "https://github.com/example/repo.git",
				branch: "main",
			})).toEqual({ insideGitRepo: true, dirty: false, comparison: "contains_head" });
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
		}
	});

	it("ignores a shorter global rewrite shadowed by a local longest-prefix match", () => {
		initTrackedRepo(root, "https://source.example/org/repo.git");
		git(root, [
			"config",
			"url.https://github.com/example/repo.git.insteadOf",
			"https://source.example/org/repo.git",
		]);
		const home = join(root, ".git", "shadowed-rewrite-home");
		mkdirSync(home);
		writeFileSync(
			join(home, ".gitconfig"),
			'[url "https://github.com/other/"]\n\tinsteadOf = https://source.example/\n',
		);
		const previousHome = process.env.HOME;
		process.env.HOME = home;

		try {
			expect(inspectCursorCloudLocalState(root, {
				repo: "https://github.com/example/repo.git",
				branch: "main",
			})).toEqual({ insideGitRepo: true, dirty: false, comparison: "contains_head" });
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
		}
	});

	it("fails closed for an explicit repo without a starting ref because the server default is not locally provable", () => {
		initTrackedRepo(root);
		const localState = inspectCursorCloudLocalState(root, {
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

	it("preserves current-upstream validation when no explicit target is configured", () => {
		initTrackedRepo(root);

		expect(inspectCursorCloudLocalState(root)).toEqual({
			insideGitRepo: true,
			dirty: false,
			comparison: "contains_head",
		});
		git(root, ["branch", "--unset-upstream"]);
		expect(inspectCursorCloudLocalState(root)).toMatchObject({
			insideGitRepo: true,
			dirty: false,
			comparison: "unknown",
		});
	});

	it("fails closed without an explicit target when upstream fetch/push identity is ambiguous", () => {
		initTrackedRepo(root);
		git(root, ["remote", "set-url", "--push", "origin", "https://github.com/other/repo.git"]);

		expect(inspectCursorCloudLocalState(root)).toMatchObject({
			insideGitRepo: true,
			dirty: false,
			comparison: "unknown",
		});
	});

	it("fails closed for a local-only upstream", () => {
		initTrackedRepo(root);
		git(root, ["config", "branch.main.remote", "."]);
		git(root, ["config", "branch.main.merge", "refs/heads/main"]);

		expect(inspectCursorCloudLocalState(root)).toMatchObject({
			insideGitRepo: true,
			dirty: false,
			comparison: "unknown",
		});
	});

	it("fails closed when the requested remote-tracking ref is missing", () => {
		initTrackedRepo(root);

		expect(inspectCursorCloudLocalState(root, {
			repo: "https://github.com/example/repo.git",
			branch: "missing",
		})).toMatchObject({ insideGitRepo: true, dirty: false, comparison: "unknown" });
	});

	it.each([
		["missing", ["config", "--unset-all", "remote.origin.fetch"]],
		["retargeted", ["config", "--replace-all", "remote.origin.fetch", "+refs/heads/*:refs/other/*"]],
		["excluded", ["config", "--add", "remote.origin.fetch", "^refs/heads/main"]],
	])("fails closed when the requested branch has a %s fetch refspec", (_label, command) => {
		initTrackedRepo(root);
		git(root, command);

		expect(inspectCursorCloudLocalState(root, {
			repo: "https://github.com/example/repo.git",
			branch: "main",
		})).toMatchObject({ insideGitRepo: true, dirty: false, comparison: "unknown" });
	}, 15_000);

	it.each([
		["forced negative", "+^refs/heads/main"],
		["mismatched wildcard", "+refs/heads/main:refs/remotes/origin/*"],
		["multiple wildcards", "+refs/heads/**:refs/remotes/origin/**"],
	])("fails closed when a %s fetch refspec is configured", (_label, refspec) => {
		initTrackedRepo(root);
		git(root, ["config", "--add", "remote.origin.fetch", refspec]);

		expect(inspectCursorCloudLocalState(root, {
			repo: "https://github.com/example/repo.git",
			branch: "main",
		})).toMatchObject({ insideGitRepo: true, dirty: false, comparison: "unknown" });
	});

	it("fails closed when another remote can write the target tracking ref", () => {
		initTrackedRepo(root);
		git(root, ["remote", "add", "other", "https://github.com/other/repo.git"]);
		git(root, ["config", "remote.other.fetch", "+refs/heads/*:refs/remotes/origin/*"]);

		expect(inspectCursorCloudLocalState(root, {
			repo: "https://github.com/example/repo.git",
			branch: "main",
		})).toMatchObject({ insideGitRepo: true, dirty: false, comparison: "unknown" });
	}, 15_000);

	it("fails closed when another source can write the target tracking ref", () => {
		initTrackedRepo(root);
		git(root, ["config", "--add", "remote.origin.fetch", "+refs/other/*:refs/remotes/origin/*"]);

		expect(inspectCursorCloudLocalState(root, {
			repo: "https://github.com/example/repo.git",
			branch: "main",
		})).toMatchObject({ insideGitRepo: true, dirty: false, comparison: "unknown" });
	});

	it("fails closed for symbolic remote-tracking refs", () => {
		initTrackedRepo(root);
		git(root, ["symbolic-ref", "refs/remotes/origin/main", "refs/heads/main"]);

		expect(inspectCursorCloudLocalState(root, {
			repo: "https://github.com/example/repo.git",
			branch: "main",
		})).toMatchObject({ insideGitRepo: true, dirty: false, comparison: "unknown" });
	});

	it("fails closed for local refs that do not prove remote observability", () => {
		initTrackedRepo(root);
		git(root, ["tag", "local-only"]);

		expect(inspectCursorCloudLocalState(root, {
			repo: "https://github.com/example/repo.git",
			branch: "refs/tags/local-only",
		})).toMatchObject({ insideGitRepo: true, dirty: false, comparison: "unknown" });
	});

	it("detects commits ahead of the requested remote-tracking ref", () => {
		initTrackedRepo(root);
		appendFileSync(join(root, "src", "file.txt"), "ahead");
		git(root, ["add", "."]);
		git(root, ["commit", "-m", "ahead"]);

		expect(inspectCursorCloudLocalState(root, {
			repo: "https://github.com/example/repo.git",
			branch: "main",
		})).toEqual({ insideGitRepo: true, dirty: false, comparison: "unpushed" });
	});

	it("accepts a clean HEAD behind the requested remote-tracking ref", () => {
		initTrackedRepo(root);
		appendFileSync(join(root, "src", "file.txt"), "remote");
		git(root, ["add", "."]);
		git(root, ["commit", "-m", "remote"]);
		git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
		git(root, ["reset", "--hard", "HEAD^"]);

		expect(inspectCursorCloudLocalState(root, {
			repo: "https://github.com/example/repo.git",
			branch: "main",
		})).toEqual({ insideGitRepo: true, dirty: false, comparison: "contains_head" });
	});

	it.each([
		["assume-unchanged", ["update-index", "--assume-unchanged", "src/file.txt"]],
		["skip-worktree", ["update-index", "--skip-worktree", "src/file.txt"]],
	])("fails closed for tracked changes hidden by %s", (_label, command) => {
		initTrackedRepo(root);
		git(root, command);
		appendFileSync(join(root, "src", "file.txt"), "hidden local change");

		expect(inspectCursorCloudLocalState(root, {
			repo: "https://github.com/example/repo.git",
			branch: "main",
		})).toMatchObject({ insideGitRepo: true, dirty: false, comparison: "unknown" });
	});

	it("finds hidden root-level index state when inspection starts in a subdirectory", () => {
		initTrackedRepo(root);
		writeFileSync(join(root, "top.txt"), "base");
		git(root, ["add", "top.txt"]);
		git(root, ["commit", "-m", "add top-level file"]);
		git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
		git(root, ["update-index", "--skip-worktree", "top.txt"]);
		writeFileSync(join(root, "top.txt"), "hidden local change");

		expect(inspectCursorCloudLocalState(join(root, "src"), {
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
		initTrackedRepo(root);
		git(root, ["config", "core.fileMode", "false"]);
		chmodSync(join(root, "src", "file.txt"), 0o755);

		expect(inspectCursorCloudLocalState(root, {
			repo: "https://github.com/example/repo.git",
			branch: "main",
		})).toEqual({ insideGitRepo: true, dirty: true, comparison: "contains_head" });
	});

	it("ignores an ambient alternate Git index", () => {
		initTrackedRepo(root);
		const alternateIndex = join(root, ".git", "alternate-index");
		copyFileSync(join(root, ".git", "index"), alternateIndex);
		git(root, ["rm", "--cached", "src/file.txt"]);
		const previousIndex = process.env.GIT_INDEX_FILE;
		process.env.GIT_INDEX_FILE = alternateIndex;

		try {
			expect(inspectCursorCloudLocalState(root, {
				repo: "https://github.com/example/repo.git",
				branch: "main",
			})).toEqual({ insideGitRepo: true, dirty: true, comparison: "contains_head" });
		} finally {
			if (previousIndex === undefined) delete process.env.GIT_INDEX_FILE;
			else process.env.GIT_INDEX_FILE = previousIndex;
		}
	});

	it("ignores ambient Git global-config redirection", () => {
		initTrackedRepo(root, "https://github.com/other/repo.git");
		const alternateConfig = join(root, ".git", "alternate-global-config");
		writeFileSync(alternateConfig, '[url "https://github.com/example/"]\n\tinsteadOf = https://github.com/other/\n');
		const previousGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
		process.env.GIT_CONFIG_GLOBAL = alternateConfig;

		try {
			expect(inspectCursorCloudLocalState(root, {
				repo: "https://github.com/example/repo.git",
				branch: "main",
			})).toMatchObject({ insideGitRepo: true, dirty: false, comparison: "unknown" });
		} finally {
			if (previousGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
			else process.env.GIT_CONFIG_GLOBAL = previousGlobalConfig;
		}
	});

	it("ignores ambient default global Git config", () => {
		initTrackedRepo(root, "https://github.com/other/repo.git");
		const home = join(root, ".git", "fake-home");
		mkdirSync(home);
		writeFileSync(join(home, ".gitconfig"), '[url "https://github.com/example/"]\n\tinsteadOf = https://github.com/other/\n');
		const previousHome = process.env.HOME;
		process.env.HOME = home;

		try {
			expect(inspectCursorCloudLocalState(root, {
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
		initTrackedRepo(root);
		const home = join(root, ".git", "whitespace-rewrite-home");
		mkdirSync(home);
		writeFileSync(
			join(home, ".gitconfig"),
			`[url "https://github.com/example/repo.git${suffix}"]\n\tinsteadOf = https://github.com/example/repo.git\n`,
		);
		const previousHome = process.env.HOME;
		process.env.HOME = home;

		try {
			expect(inspectCursorCloudLocalState(root, {
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
		initTrackedRepo(root, "https://git.example/repo.git");
		const home = join(root, ".git", "rewrite-home");
		mkdirSync(home);
		writeFileSync(
			join(home, ".gitconfig"),
			'[url "ssh://git@git.example/other/"]\n\tinsteadOf = https://git.example/\n',
		);
		const previousHome = process.env.HOME;
		process.env.HOME = home;

		try {
			expect(inspectCursorCloudLocalState(root, {
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
		initTrackedRepo(root);
		appendFileSync(join(root, "src", "file.txt"), "ahead");
		git(root, ["add", "."]);
		git(root, ["commit", "-m", "ahead"]);
		git(root, ["replace", "HEAD", "refs/remotes/origin/main"]);

		expect(inspectCursorCloudLocalState(root, {
			repo: "https://github.com/example/repo.git",
			branch: "main",
		})).toMatchObject({ insideGitRepo: true, dirty: false, comparison: "unknown" });
	});

	it("fails closed when graft metadata can alter ancestry", () => {
		initTrackedRepo(root);
		mkdirSync(join(root, ".git", "info"), { recursive: true });
		writeFileSync(join(root, ".git", "info", "grafts"), "");

		expect(inspectCursorCloudLocalState(root, {
			repo: "https://github.com/example/repo.git",
			branch: "main",
		})).toMatchObject({ insideGitRepo: true, dirty: false, comparison: "unknown" });
	});

	it("detects a dirty tree against an otherwise contained explicit target", () => {
		initTrackedRepo(root);
		appendFileSync(join(root, "src", "file.txt"), "dirty");

		expect(inspectCursorCloudLocalState(root, {
			repo: "https://github.com/example/repo.git",
			branch: "main",
		})).toEqual({ insideGitRepo: true, dirty: true, comparison: "contains_head" });
	});

	it("detects untracked files even when Git config hides them by default", () => {
		initTrackedRepo(root);
		git(root, ["config", "status.showUntrackedFiles", "no"]);
		writeFileSync(join(root, "untracked.txt"), "local only");

		expect(inspectCursorCloudLocalState(root, {
			repo: "https://github.com/example/repo.git",
			branch: "main",
		})).toEqual({ insideGitRepo: true, dirty: true, comparison: "contains_head" });
	});

	it("detects modified submodules even when Git config hides them by default", () => {
		const main = join(root, "main");
		const dependency = join(root, "dependency");
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
		initTrackedRepo(root);
		const state = inspectCursorCloudLocalState(root, {
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
		initTrackedRepo(root);
		let statusArgs: string[] | undefined;
		inspectCursorCloudLocalState(root, {}, (cwd, args) => {
			if (args.includes("status")) statusArgs = args;
			return runCursorCloudGit(cwd, args);
		});
		expect(statusArgs).toContain("--no-optional-locks");
	});

	it("reports unknown cleanliness without claiming the worktree is dirty", () => {
		initTrackedRepo(root);
		const localState = inspectCursorCloudLocalState(root, {}, (cwd, args) =>
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
		git(root, ["init", "--bare"]);

		expect(inspectCursorCloudLocalState(root)).toEqual({
			insideGitRepo: true,
			dirty: "unknown",
			comparison: "unknown",
			reasons: [{ code: "bare_repo" }],
		});
	});

	it("recognizes an ordinary directory when Git is available", () => {
		expect(inspectCursorCloudLocalState(root)).toEqual({ insideGitRepo: false });
	});

	it("fails closed when repository discovery fails in an empty directory", () => {
		const localState = inspectCursorCloudLocalState(root, {}, () => undefined);
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
		if (kind === "bare") git(root, ["init", "--bare"]);
		else mkdirSync(join(root, ".git"));
		expect(inspectCursorCloudLocalState(root, {}, (cwd, args) =>
			args[0] === "--version" ? runCursorCloudGit(cwd, args) : undefined)).toEqual({
			insideGitRepo: "unknown",
			dirty: "unknown",
			comparison: "unknown",
			reasons: [{ code: "repository_detection_failed" }],
		});
	});
});
