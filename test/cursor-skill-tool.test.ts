import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import type { SettingSource } from "@cursor/sdk";
import type { BeforeAgentStartEvent, ExtensionContext, Skill } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_ACTIVATE_SKILL_MCP_NAME,
	CURSOR_ACTIVATE_SKILL_TOOL_NAME,
	type CursorSkillCatalogContext,
	formatCursorSkillsForPrompt,
	registerCursorSkillTool,
	resolveCursorSkillSystemPrompt,
} from "../src/cursor-skill-tool.js";
import { buildCursorPiToolBridgeSnapshot } from "../src/cursor-pi-tool-bridge.js";
import { buildCursorPrompt } from "../src/context.js";
import {
	createDefaultSystemPromptOptions,
	createExtensionTestContext,
	createPiHarness,
	getHarnessRegisteredTool,
	makeModel,
} from "./helpers/pi-harness.js";

afterEach(() => {
	delete process.env.PI_CURSOR_RUNTIME;
});

function makeSkill(overrides: Partial<Skill> & Pick<Skill, "name" | "filePath">): Skill {
	return {
		description: `${overrides.name} description`,
		baseDir: overrides.filePath.slice(0, overrides.filePath.lastIndexOf("/")),
		sourceInfo: {
			source: "test",
			path: overrides.filePath,
			scope: "user",
			origin: "top-level",
		},
		disableModelInvocation: false,
		...overrides,
	};
}

describe("formatCursorSkillsForPrompt", () => {
	it("builds a Cursor-safe pi skill catalog and excludes explicit-only skills", () => {
		const prompt = formatCursorSkillsForPrompt([
			makeSkill({ name: "global-skill", description: "Use for global work", filePath: "/Users/me/.pi/agent/skills/global-skill/SKILL.md" }),
			makeSkill({ name: "manual-only", description: "Manual", filePath: "/skills/manual-only/SKILL.md", disableModelInvocation: true }),
		]);

		expect(prompt).toContain(CURSOR_ACTIVATE_SKILL_MCP_NAME);
		expect(prompt).toContain("<name>global-skill</name>");
		expect(prompt).toContain("/Users/me/.pi/agent/skills/global-skill/SKILL.md");
		expect(prompt).not.toContain("manual-only");
	});
});

describe("resolveCursorSkillSystemPrompt Cursor skill overlap", () => {
	const cursorModel = makeModel("composer-2.5");
	// The overlap rule compares real paths, so the fixture is a real tree rather
	// than synthetic absolute paths that never resolve.
	let home = "";
	let cwd = "";
	let fixtureRoot = "";
	let skills: Skill[] = [];

	afterAll(async () => {
		if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
	});

	beforeAll(async () => {
		fixtureRoot = await mkdtemp(join(tmpdir(), "pi-cursor-skill-overlap-fixture-"));
		home = join(fixtureRoot, "home");
		cwd = join(fixtureRoot, "repo");
		const skillPaths = [
			{ name: "home-skill", directory: join(home, ".agents", "skills", "home-skill") },
			{ name: "cursor-user", directory: join(home, ".cursor", "skills", "cursor-user") },
			{ name: "cursor-builtin", directory: join(home, ".cursor", "skills-cursor", "cursor-builtin") },
			{ name: "project-skill", directory: join(cwd, ".agents", "skills", "project-skill") },
			{ name: "project-cursor", directory: join(cwd, ".cursor", "skills", "project-cursor") },
			{ name: "claude-user", directory: join(home, ".claude", "skills", "claude-user") },
			{ name: "claude-project", directory: join(cwd, ".claude", "skills", "claude-project") },
			{ name: "pi-agent-skill", directory: join(home, ".pi", "agent", "skills", "pi-agent-skill") },
			{ name: "package-skill", directory: join(home, ".pi", "agent", "git", "example", "skills", "package-skill") },
			{ name: "near-miss", directory: join(home, ".agents", "skills-backup", "near-miss") },
		];
		skills = [];
		for (const { name, directory } of skillPaths) {
			await mkdir(directory, { recursive: true });
			const filePath = join(directory, "SKILL.md");
			await writeFile(filePath, `---\nname: ${name}\ndescription: ${name} description\n---\n# ${name}\n`);
			skills.push(makeSkill({ name, filePath }));
		}
	});

	function promptFor(settingSources: SettingSource[], systemPrompt = "System prompt."): string {
		const context: CursorSkillCatalogContext = { homeDir: home, cwd, settingSources };
		return resolveCursorSkillSystemPrompt(
			systemPrompt,
			cursorModel,
			{ ...createDefaultSystemPromptOptions(cwd), skills },
			"local",
			context,
		);
	}

	it.each([
		{
			sources: ["all"] satisfies SettingSource[],
			omitted: ["home-skill", "cursor-user", "project-skill", "project-cursor", "claude-user", "claude-project"],
			kept: ["cursor-builtin", "pi-agent-skill", "package-skill", "near-miss"],
		},
		{
			sources: ["user"] satisfies SettingSource[],
			omitted: ["home-skill", "cursor-user", "claude-user"],
			kept: ["cursor-builtin", "project-skill", "project-cursor", "claude-project", "pi-agent-skill", "package-skill", "near-miss"],
		},
		{
			sources: ["project"] satisfies SettingSource[],
			omitted: ["project-skill", "project-cursor", "claude-project"],
			kept: ["home-skill", "cursor-user", "cursor-builtin", "claude-user", "pi-agent-skill", "package-skill", "near-miss"],
		},
		{
			sources: ["plugins"] satisfies SettingSource[],
			omitted: [],
			kept: ["home-skill", "cursor-user", "cursor-builtin", "project-skill", "project-cursor", "claude-user", "claude-project", "pi-agent-skill", "package-skill", "near-miss"],
		},
		{
			sources: [] satisfies SettingSource[],
			omitted: [],
			kept: ["home-skill", "cursor-user", "cursor-builtin", "project-skill", "project-cursor", "claude-user", "claude-project", "pi-agent-skill", "package-skill", "near-miss"],
		},
	])("keeps Pi-only skills for $sources", ({ sources, omitted, kept }) => {
		const prompt = promptFor(sources);
		for (const name of omitted) expect(prompt).not.toContain(`<name>${name}</name>`);
		for (const name of kept) expect(prompt).toContain(`<name>${name}</name>`);
		expect(prompt).toContain(CURSOR_ACTIVATE_SKILL_MCP_NAME);
	});

	it("removes the Pi catalog when every skill is already scanned by Cursor", () => {
		const skill = skills[0];
		if (!skill) throw new Error("missing home skill");
		const systemPrompt = [
			"System prompt.",
			"",
			"The following skills provide specialized instructions for specific tasks.",
			"<available_skills>",
			"  <skill>",
			"    <name>home-skill</name>",
			`    <location>${skill.filePath}</location>`,
			"  </skill>",
			"</available_skills>",
		].join("\n");
		const prompt = resolveCursorSkillSystemPrompt(
			systemPrompt,
			cursorModel,
			{ ...createDefaultSystemPromptOptions(cwd), skills: [skill] },
			"local",
			{ homeDir: home, cwd, settingSources: ["user"] },
		);
		expect(prompt).toBe("System prompt.");
	});

	it("omits the home skill directory when only the project source is loaded and cwd is home", () => {
		const skill = skills[0];
		if (!skill) throw new Error("missing home skill");
		const prompt = resolveCursorSkillSystemPrompt(
			"System prompt.",
			cursorModel,
			{ ...createDefaultSystemPromptOptions(home), skills: [skill] },
			"local",
			{ homeDir: home, cwd: home, settingSources: ["project"] },
		);
		// With cwd at home, the project workspace root is home, so Cursor's project
		// scan lists these directories even though `user` is off.
		expect(prompt).not.toContain("<name>home-skill</name>");
	});

	it("omits a skill whose path is a symlink into a Cursor user skill directory", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-cursor-skill-link-"));
		onTestFinished(() => rm(root, { recursive: true, force: true }));
		const linkHome = join(root, "home");
		const sharedDir = join(linkHome, ".agents", "skills", "shared");
		await mkdir(sharedDir, { recursive: true });
		await writeFile(join(sharedDir, "SKILL.md"), "---\nname: shared\ndescription: Shared\n---\n# Shared\n");
		await mkdir(join(linkHome, ".pi", "agent"), { recursive: true });
		await symlink(join(linkHome, ".agents", "skills"), join(linkHome, ".pi", "agent", "skills"));
		const skill = makeSkill({
			name: "shared",
			description: "Shared",
			filePath: join(linkHome, ".pi", "agent", "skills", "shared", "SKILL.md"),
		});
		const prompt = resolveCursorSkillSystemPrompt(
			"System prompt.",
			cursorModel,
			{ ...createDefaultSystemPromptOptions(join(root, "repo")), skills: [skill] },
			"local",
			{ homeDir: linkHome, cwd: join(root, "repo"), settingSources: ["all"] },
		);
		expect(prompt).toBe("System prompt.");
	});

	it("keeps a skill whose literal path is under a scan root but whose symlink target is outside it", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-cursor-skill-outbound-"));
		onTestFinished(() => rm(root, { recursive: true, force: true }));
		const repo = join(root, "repo");
		const external = join(root, "external", "shared-skill");
		await mkdir(external, { recursive: true });
		await writeFile(join(external, "SKILL.md"), "---\nname: shared-skill\ndescription: Shared\n---\n# Shared\n");
		await mkdir(join(repo, ".agents", "skills"), { recursive: true });
		const linkPath = join(repo, ".agents", "skills", "shared-skill");
		await symlink(external, linkPath);
		const skill = makeSkill({
			name: "shared-skill",
			description: "Shared",
			filePath: join(linkPath, "SKILL.md"),
		});
		const prompt = resolveCursorSkillSystemPrompt(
			"System prompt.",
			cursorModel,
			{ ...createDefaultSystemPromptOptions(repo), skills: [skill] },
			"local",
			// `project` allows only the workspace root, so Cursor resolves this file
			// outside its allowed roots and never lists it.
			{ homeDir: root, cwd: repo, settingSources: ["project"] },
		);

		expect(prompt).toContain("<name>shared-skill</name>");
	});

	it("keeps a skill when the Cursor scan directory itself is a symlink outside the allowed root", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-cursor-skill-scandir-link-"));
		onTestFinished(() => rm(root, { recursive: true, force: true }));
		const linkHome = join(root, "home");
		const externalSkills = join(root, "external", "skills");
		const externalSkillDir = join(externalSkills, "shared-skill");
		await mkdir(externalSkillDir, { recursive: true });
		const filePath = join(externalSkillDir, "SKILL.md");
		await writeFile(filePath, "---\nname: shared-skill\ndescription: Shared\n---\n# Shared\n");
		// Cursor realpaths the allowed root (home), not the scan directory below it,
		// so this target is outside every allowed root and Cursor never lists it.
		await mkdir(join(linkHome, ".agents"), { recursive: true });
		await symlink(externalSkills, join(linkHome, ".agents", "skills"));
		const skill = makeSkill({
			name: "shared-skill",
			description: "Shared",
			filePath: join(linkHome, ".agents", "skills", "shared-skill", "SKILL.md"),
		});
		const prompt = resolveCursorSkillSystemPrompt(
			"System prompt.",
			cursorModel,
			{ ...createDefaultSystemPromptOptions(join(root, "repo")), skills: [skill] },
			"local",
			{ homeDir: linkHome, cwd: join(root, "repo"), settingSources: ["user"] },
		);

		expect(prompt).toContain("<name>shared-skill</name>");
	});

	it("keeps a skill whose frontmatter surfaces exclude Cursor's sdk surface", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-cursor-skill-surfaces-"));
		onTestFinished(() => rm(root, { recursive: true, force: true }));
		const repo = join(root, "repo");
		const skillDir = join(repo, ".agents", "skills", "ide-only");
		await mkdir(skillDir, { recursive: true });
		const filePath = join(skillDir, "SKILL.md");
		await writeFile(
			filePath,
			"---\nname: ide-only\ndescription: IDE only\nmetadata:\n  surfaces:\n    - ide\n---\n# IDE only\n",
		);
		const skill = makeSkill({ name: "ide-only", description: "IDE only", filePath });
		const prompt = resolveCursorSkillSystemPrompt(
			"System prompt.",
			cursorModel,
			{ ...createDefaultSystemPromptOptions(repo), skills: [skill] },
			"local",
			{ homeDir: root, cwd: repo, settingSources: ["project"] },
		);

		// Cursor's `ef` filter skips this skill, so Pi must keep the only copy.
		expect(prompt).toContain("<name>ide-only</name>");
	});

	it("drops a skill whose frontmatter surfaces include Cursor's sdk surface", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-cursor-skill-sdk-surface-"));
		onTestFinished(() => rm(root, { recursive: true, force: true }));
		const repo = join(root, "repo");
		const skillDir = join(repo, ".agents", "skills", "sdk-skill");
		await mkdir(skillDir, { recursive: true });
		const filePath = join(skillDir, "SKILL.md");
		await writeFile(filePath, "---\nname: sdk-skill\ndescription: SDK skill\nmetadata:\n  surfaces: ide,sdk\n---\n# SDK skill\n");
		const skill = makeSkill({ name: "sdk-skill", description: "SDK skill", filePath });
		const prompt = resolveCursorSkillSystemPrompt(
			"System prompt.",
			cursorModel,
			{ ...createDefaultSystemPromptOptions(repo), skills: [skill] },
			"local",
			{ homeDir: root, cwd: repo, settingSources: ["project"] },
		);

		expect(prompt).not.toContain("<name>sdk-skill</name>");
	});

	it("keeps an alwaysApply skill, which Cursor turns into a rule rather than a skill", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-cursor-skill-always-"));
		onTestFinished(() => rm(root, { recursive: true, force: true }));
		const repo = join(root, "repo");
		const skillDir = join(repo, ".agents", "skills", "always-skill");
		await mkdir(skillDir, { recursive: true });
		const filePath = join(skillDir, "SKILL.md");
		await writeFile(filePath, "---\nname: always-skill\ndescription: Always\nalwaysApply: true\n---\n# Always\n");
		const skill = makeSkill({ name: "always-skill", description: "Always", filePath });
		const prompt = resolveCursorSkillSystemPrompt(
			"System prompt.",
			cursorModel,
			{ ...createDefaultSystemPromptOptions(repo), skills: [skill] },
			"local",
			{ homeDir: root, cwd: repo, settingSources: ["project"] },
		);

		expect(prompt).toContain("<name>always-skill</name>");
	});

	it("keeps a skill whose surfaces exclusion is hidden behind a YAML merge key", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-cursor-skill-merge-surfaces-"));
		onTestFinished(() => rm(root, { recursive: true, force: true }));
		const repo = join(root, "repo");
		const skillDir = join(repo, ".agents", "skills", "merge-skill");
		await mkdir(skillDir, { recursive: true });
		const filePath = join(skillDir, "SKILL.md");
		await writeFile(
			filePath,
			"---\nname: merge-skill\ndescription: Merge\nmetadata:\n  <<: &meta {surfaces: [ide]}\n---\n# Merge\n",
		);
		const skill = makeSkill({ name: "merge-skill", description: "Merge", filePath });
		const prompt = resolveCursorSkillSystemPrompt(
			"System prompt.",
			cursorModel,
			{ ...createDefaultSystemPromptOptions(repo), skills: [skill] },
			"local",
			{ homeDir: root, cwd: repo, settingSources: ["project"] },
		);

		// Pi's parser leaves the merge key unexpanded. Cursor's gray-matter applies it and skips the skill.
		expect(prompt).toContain("<name>merge-skill</name>");
	});

	it("keeps a skill whose alwaysApply flag is hidden behind a YAML merge key", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-cursor-skill-merge-always-"));
		onTestFinished(() => rm(root, { recursive: true, force: true }));
		const repo = join(root, "repo");
		const skillDir = join(repo, ".agents", "skills", "merge-always");
		await mkdir(skillDir, { recursive: true });
		const filePath = join(skillDir, "SKILL.md");
		await writeFile(
			filePath,
			"---\nname: merge-always\ndescription: Merge always\nbase: &b {alwaysApply: true}\n<<: *b\n---\n# Merge always\n",
		);
		const skill = makeSkill({ name: "merge-always", description: "Merge always", filePath });
		const prompt = resolveCursorSkillSystemPrompt(
			"System prompt.",
			cursorModel,
			{ ...createDefaultSystemPromptOptions(repo), skills: [skill] },
			"local",
			{ homeDir: root, cwd: repo, settingSources: ["project"] },
		);

		// Cursor expands the merge into alwaysApply and stores a rule, not a skill.
		expect(prompt).toContain("<name>merge-always</name>");
	});

	it("keeps a merged-surfaces skill when the file starts with a UTF-8 BOM", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-cursor-skill-merge-bom-"));
		onTestFinished(() => rm(root, { recursive: true, force: true }));
		const repo = join(root, "repo");
		const skillDir = join(repo, ".agents", "skills", "merge-bom");
		await mkdir(skillDir, { recursive: true });
		const filePath = join(skillDir, "SKILL.md");
		await writeFile(
			filePath,
			"\uFEFF---\nname: merge-bom\ndescription: Merge\nmetadata:\n  <<: &meta {surfaces: [ide]}\n---\n# Merge\n",
		);
		const skill = makeSkill({ name: "merge-bom", description: "Merge", filePath });
		const prompt = resolveCursorSkillSystemPrompt(
			"System prompt.",
			cursorModel,
			{ ...createDefaultSystemPromptOptions(repo), skills: [skill] },
			"local",
			{ homeDir: root, cwd: repo, settingSources: ["project"] },
		);

		expect(prompt).toContain("<name>merge-bom</name>");
	});

	it("keeps a merged-surfaces skill when the closing delimiter has trailing spaces", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-cursor-skill-merge-space-"));
		onTestFinished(() => rm(root, { recursive: true, force: true }));
		const repo = join(root, "repo");
		const skillDir = join(repo, ".agents", "skills", "merge-space");
		await mkdir(skillDir, { recursive: true });
		const filePath = join(skillDir, "SKILL.md");
		await writeFile(
			filePath,
			"---\nname: merge-space\ndescription: Merge\nmetadata:\n  <<: &meta {surfaces: [ide]}\n---   \n# Merge\n",
		);
		const skill = makeSkill({ name: "merge-space", description: "Merge", filePath });
		const prompt = resolveCursorSkillSystemPrompt(
			"System prompt.",
			cursorModel,
			{ ...createDefaultSystemPromptOptions(repo), skills: [skill] },
			"local",
			{ homeDir: root, cwd: repo, settingSources: ["project"] },
		);

		expect(prompt).toContain("<name>merge-space</name>");
	});

	it("keeps a skill whose opening delimiter has a comment gray-matter rejects", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-cursor-skill-open-comment-"));
		onTestFinished(() => rm(root, { recursive: true, force: true }));
		const repo = join(root, "repo");
		const skillDir = join(repo, ".agents", "skills", "open-comment");
		await mkdir(skillDir, { recursive: true });
		const filePath = join(skillDir, "SKILL.md");
		await writeFile(
			filePath,
			"--- # SKILL frontmatter\nname: open-comment\ndescription: Open comment\n---\n# Open\n",
		);
		const skill = makeSkill({ name: "open-comment", description: "Open comment", filePath });
		const prompt = resolveCursorSkillSystemPrompt(
			"System prompt.",
			cursorModel,
			{ ...createDefaultSystemPromptOptions(repo), skills: [skill] },
			"local",
			{ homeDir: root, cwd: repo, settingSources: ["project"] },
		);

		expect(prompt).toContain("<name>open-comment</name>");
	});

	it("keeps a skill whose frontmatter uses CR-only line endings", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-cursor-skill-cr-only-"));
		onTestFinished(() => rm(root, { recursive: true, force: true }));
		const repo = join(root, "repo");
		const skillDir = join(repo, ".agents", "skills", "cr-only");
		await mkdir(skillDir, { recursive: true });
		const filePath = join(skillDir, "SKILL.md");
		await writeFile(filePath, "---\rname: cr-only\rdescription: CR only\r---\r# CR\r");
		const skill = makeSkill({ name: "cr-only", description: "CR only", filePath });
		const prompt = resolveCursorSkillSystemPrompt(
			"System prompt.",
			cursorModel,
			{ ...createDefaultSystemPromptOptions(repo), skills: [skill] },
			"local",
			{ homeDir: root, cwd: repo, settingSources: ["project"] },
		);

		expect(prompt).toContain("<name>cr-only</name>");
	});

	it("keeps a skill whose opening delimiter ends in a bare CR", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-cursor-skill-mixed-cr-"));
		onTestFinished(() => rm(root, { recursive: true, force: true }));
		const repo = join(root, "repo");
		const skillDir = join(repo, ".agents", "skills", "mixed-cr");
		await mkdir(skillDir, { recursive: true });
		const filePath = join(skillDir, "SKILL.md");
		await writeFile(filePath, "---\rname: mixed-cr\ndescription: Mixed CR\n---\n# Mixed CR\n");
		const skill = makeSkill({ name: "mixed-cr", description: "Mixed CR", filePath });
		const prompt = resolveCursorSkillSystemPrompt(
			"System prompt.",
			cursorModel,
			{ ...createDefaultSystemPromptOptions(repo), skills: [skill] },
			"local",
			{ homeDir: root, cwd: repo, settingSources: ["project"] },
		);

		expect(prompt).toContain("<name>mixed-cr</name>");
	});

	it("keeps a build-skipped symlink into a pruned Codex builtin", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-cursor-skill-build-link-"));
		onTestFinished(() => rm(root, { recursive: true, force: true }));
		const home = join(root, "home");
		const repo = join(root, "repo");
		const imagegenDir = join(home, ".codex", "skills", "imagegen");
		await mkdir(imagegenDir, { recursive: true });
		await mkdir(join(repo, ".agents", "skills"), { recursive: true });
		await writeFile(join(imagegenDir, "SKILL.md"), "---\nname: imagegen\ndescription: Image\n---\n# Image\n");
		await symlink(imagegenDir, join(repo, ".agents", "skills", "build"));
		const filePath = join(repo, ".agents", "skills", "build", "SKILL.md");
		const skill = makeSkill({ name: "imagegen", description: "Image", filePath });
		const prompt = resolveCursorSkillSystemPrompt(
			"System prompt.",
			cursorModel,
			{ ...createDefaultSystemPromptOptions(repo), skills: [skill] },
			"local",
			{ homeDir: home, cwd: repo, settingSources: ["all"] },
		);

		// `Op` never enters `build`, and `bp` prunes the `.codex` target, so Cursor lists nothing.
		expect(prompt).toContain("<name>imagegen</name>");
	});

	it("keeps a Codex builtin when the Cursor scan root is a symlink to Pi's skill directory", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-cursor-skill-scan-root-codex-"));
		onTestFinished(() => rm(root, { recursive: true, force: true }));
		const home = join(root, "home");
		const piSkillDir = join(home, ".pi", "agent", "skills", "imagegen");
		await mkdir(piSkillDir, { recursive: true });
		await writeFile(join(piSkillDir, "SKILL.md"), "---\nname: imagegen\ndescription: Image\n---\n# Image\n");
		await mkdir(join(home, ".codex"), { recursive: true });
		await symlink(join(home, ".pi", "agent", "skills"), join(home, ".codex", "skills"));
		const skill = makeSkill({
			name: "imagegen",
			description: "Image",
			filePath: join(piSkillDir, "SKILL.md"),
		});
		const prompt = resolveCursorSkillSystemPrompt(
			"System prompt.",
			cursorModel,
			{ ...createDefaultSystemPromptOptions(join(root, "repo")), skills: [skill] },
			"local",
			{ homeDir: home, cwd: join(root, "repo"), settingSources: ["user"] },
		);

		// Cursor records `~/.codex/skills/imagegen/SKILL.md` and `bp` prunes that literal path.
		expect(prompt).toContain("<name>imagegen</name>");
	});

	it("keeps a Pi skill when a symlinked agents root loses to an earlier Cursor file", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-cursor-skill-scan-root-agents-"));
		onTestFinished(() => rm(root, { recursive: true, force: true }));
		const home = join(root, "home");
		const piFoo = join(home, ".pi", "agent", "skills", "foo");
		const cursorFoo = join(home, ".cursor", "skills", "foo");
		await mkdir(piFoo, { recursive: true });
		await mkdir(cursorFoo, { recursive: true });
		await writeFile(join(piFoo, "SKILL.md"), "---\nname: pi-foo\ndescription: Pi\n---\n# Pi\n");
		await writeFile(join(cursorFoo, "SKILL.md"), "---\nname: cursor-foo\ndescription: Cursor\n---\n# Cursor\n");
		await mkdir(join(home, ".agents"), { recursive: true });
		await symlink(join(home, ".pi", "agent", "skills"), join(home, ".agents", "skills"));
		const skill = makeSkill({ name: "pi-foo", description: "Pi", filePath: join(piFoo, "SKILL.md") });
		const prompt = resolveCursorSkillSystemPrompt(
			"System prompt.",
			cursorModel,
			{ ...createDefaultSystemPromptOptions(join(root, "repo")), skills: [skill] },
			"local",
			{ homeDir: home, cwd: join(root, "repo"), settingSources: ["user"] },
		);

		// Cursor records the literal `~/.agents` path, then `Lp` keeps the earlier `.cursor` file.
		expect(prompt).toContain("<name>pi-foo</name>");
	});

	it("keeps a dot-nested skill that Cursor prunes from its skill scan", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-cursor-skill-dotnested-"));
		onTestFinished(() => rm(root, { recursive: true, force: true }));
		const repo = join(root, "repo");
		const skillDir = join(repo, ".agents", "skills", ".hidden", "nested-skill");
		await mkdir(skillDir, { recursive: true });
		const filePath = join(skillDir, "SKILL.md");
		await writeFile(filePath, "---\nname: nested-skill\ndescription: Nested\n---\n# Nested\n");
		const skill = makeSkill({ name: "nested-skill", description: "Nested", filePath });
		const prompt = resolveCursorSkillSystemPrompt(
			"System prompt.",
			cursorModel,
			{ ...createDefaultSystemPromptOptions(repo), skills: [skill] },
			"local",
			{ homeDir: root, cwd: repo, settingSources: ["project"] },
		);

		expect(prompt).toContain("<name>nested-skill</name>");
	});

	it("keeps a skill below a build-output directory, which Cursor's walk never enters", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-cursor-skill-skipdir-"));
		onTestFinished(() => rm(root, { recursive: true, force: true }));
		const repo = join(root, "repo");
		const skillDir = join(repo, ".agents", "skills", "build");
		await mkdir(skillDir, { recursive: true });
		const filePath = join(skillDir, "SKILL.md");
		await writeFile(filePath, "---\nname: build-skill\ndescription: Build\n---\n# Build\n");
		const skill = makeSkill({ name: "build-skill", description: "Build", filePath });
		const prompt = resolveCursorSkillSystemPrompt(
			"System prompt.",
			cursorModel,
			{ ...createDefaultSystemPromptOptions(repo), skills: [skill] },
			"local",
			{ homeDir: root, cwd: repo, settingSources: ["project"] },
		);

		// `Op` skips `build` (in `Dp`), so Cursor never lists it.
		expect(prompt).toContain("<name>build-skill</name>");
	});

	it("keeps a non-SKILL.md markdown skill under a Cursor root, which Cursor never enumerates", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-cursor-skill-md-"));
		onTestFinished(() => rm(root, { recursive: true, force: true }));
		const repo = join(root, "repo");
		const skillDir = join(repo, ".agents", "skills", "guide");
		await mkdir(skillDir, { recursive: true });
		const filePath = join(skillDir, "guide.md");
		await writeFile(filePath, "---\nname: guide\ndescription: Guide\n---\n# Guide\n");
		const skill = makeSkill({ name: "guide", description: "Guide", filePath });
		const prompt = resolveCursorSkillSystemPrompt(
			"System prompt.",
			cursorModel,
			{ ...createDefaultSystemPromptOptions(repo), skills: [skill] },
			"local",
			{ homeDir: root, cwd: repo, settingSources: ["project"] },
		);

		// `Vp` and `Mp` only accept a file named exactly `SKILL.md`.
		expect(prompt).toContain("<name>guide</name>");
	});

	it("keeps a project skill that resolves into the managed skills root", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-cursor-skill-managed-"));
		onTestFinished(() => rm(root, { recursive: true, force: true }));
		const home = join(root, "home");
		const managedDir = join(home, ".cursor", "skills-cursor", "foo");
		await mkdir(managedDir, { recursive: true });
		await writeFile(join(managedDir, "SKILL.md"), "---\nname: foo\ndescription: Foo\n---\n# Foo\n");
		await mkdir(join(home, ".agents", "skills"), { recursive: true });
		await symlink(managedDir, join(home, ".agents", "skills", "foo"));
		const skill = makeSkill({
			name: "foo",
			description: "Foo",
			filePath: join(home, ".agents", "skills", "foo", "SKILL.md"),
		});
		const prompt = resolveCursorSkillSystemPrompt(
			"System prompt.",
			cursorModel,
			{ ...createDefaultSystemPromptOptions(home), skills: [skill] },
			"local",
			{ homeDir: home, cwd: home, settingSources: ["project"] },
		);

		// The SDK excludes the managed root whenever its sync gate is closed, which
		// this extension never opens, so Cursor lists no copy for those sources.
		expect(prompt).toContain("<name>foo</name>");
	});

	it("keeps a builtin .codex name reached through a symlinked pi skill root", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-cursor-skill-codex-link-"));
		onTestFinished(() => rm(root, { recursive: true, force: true }));
		const home = join(root, "home");
		const codexSkillDir = join(home, ".codex", "skills", "imagegen");
		await mkdir(codexSkillDir, { recursive: true });
		await writeFile(join(codexSkillDir, "SKILL.md"), "---\nname: imagegen\ndescription: Image\n---\n# Image\n");
		await mkdir(join(home, ".pi", "agent"), { recursive: true });
		await symlink(join(home, ".codex", "skills"), join(home, ".pi", "agent", "skills"));
		const skill = makeSkill({
			name: "imagegen",
			description: "Image",
			filePath: join(home, ".pi", "agent", "skills", "imagegen", "SKILL.md"),
		});
		const prompt = resolveCursorSkillSystemPrompt(
			"System prompt.",
			cursorModel,
			{ ...createDefaultSystemPromptOptions(join(root, "repo")), skills: [skill] },
			"local",
			{ homeDir: home, cwd: join(root, "repo"), settingSources: ["user"] },
		);

		// `bp` prunes the builtin `.codex/skills` name, so Cursor lists no copy and
		// pi's symlinked one is the only usable copy.
		expect(prompt).toContain("<name>imagegen</name>");
	});

	it("keeps a project skill whose repo root itself sits under a Cursor config pair", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-cursor-skill-nested-repo-"));
		onTestFinished(() => rm(root, { recursive: true, force: true }));
		const home = join(root, "home");
		const repo = join(home, ".claude", "skills", "repo");
		const skillDir = join(repo, ".agents", "skills", "foo");
		await mkdir(skillDir, { recursive: true });
		execFileSync("git", ["init", "-q", repo]);
		const filePath = join(skillDir, "SKILL.md");
		await writeFile(filePath, "---\nname: foo\ndescription: Foo\n---\n# Foo\n");
		const skill = makeSkill({ name: "foo", description: "Foo", filePath });
		const prompt = resolveCursorSkillSystemPrompt(
			"System prompt.",
			cursorModel,
			{ ...createDefaultSystemPromptOptions(repo), skills: [skill] },
			"local",
			{ homeDir: home, cwd: repo, settingSources: ["project"] },
		);

		// `bp` runs on the full path, so the earlier `.claude/skills` pair followed by
		// the dot-prefixed `.agents` segment prunes it from Cursor's list.
		expect(prompt).toContain("<name>foo</name>");
	});

	it("uses the git repo root as Cursor's project root and leaves nested copies to Cursor's own list", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-cursor-skill-subdir-"));
		onTestFinished(() => rm(root, { recursive: true, force: true }));
		const repo = join(root, "repo");
		const subdir = join(repo, "packages", "app");
		await mkdir(subdir, { recursive: true });
		execFileSync("git", ["init", "-q", repo]);
		const cwdSkillDir = join(subdir, ".agents", "skills", "cwd-skill");
		const rootSkillDir = join(repo, ".agents", "skills", "root-skill");
		await mkdir(cwdSkillDir, { recursive: true });
		await mkdir(rootSkillDir, { recursive: true });
		const cwdSkillPath = join(cwdSkillDir, "SKILL.md");
		const rootSkillPath = join(rootSkillDir, "SKILL.md");
		await writeFile(cwdSkillPath, "---\nname: cwd-skill\ndescription: Cwd\n---\n# Cwd\n");
		await writeFile(rootSkillPath, "---\nname: root-skill\ndescription: Root\n---\n# Root\n");
		const cwdSkill = makeSkill({ name: "cwd-skill", description: "Cwd", filePath: cwdSkillPath });
		const rootSkill = makeSkill({ name: "root-skill", description: "Root", filePath: rootSkillPath });
		const prompt = resolveCursorSkillSystemPrompt(
			"System prompt.",
			cursorModel,
			{ ...createDefaultSystemPromptOptions(subdir), skills: [cwdSkill, rootSkill] },
			"local",
			{ homeDir: root, cwd: subdir, settingSources: ["project"] },
		);

		// The repo-root copy is a top-level Cursor scan root and is omitted. The nested
		// subdirectory copy stays: Cursor's nested walk has its own gates, and dropping
		// it on an unproven path would make the only copy unusable.
		expect(prompt).toContain("<name>cwd-skill</name>");
		expect(prompt).not.toContain("<name>root-skill</name>");
	});

	it("keeps the skill Cursor's cross-root dedupe drops when two roots share a relative path", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-cursor-skill-dedupe-"));
		onTestFinished(() => rm(root, { recursive: true, force: true }));
		const home = join(root, "home");
		const claudeDir = join(home, ".claude", "skills", "foo");
		const agentsDir = join(home, ".agents", "skills", "foo");
		await mkdir(claudeDir, { recursive: true });
		await mkdir(agentsDir, { recursive: true });
		const claudePath = join(claudeDir, "SKILL.md");
		const agentsPath = join(agentsDir, "SKILL.md");
		await writeFile(claudePath, "---\nname: claude-foo\ndescription: Claude\n---\n# Claude\n");
		await writeFile(agentsPath, "---\nname: agents-foo\ndescription: Agents\n---\n# Agents\n");
		const claudeSkill = makeSkill({ name: "claude-foo", description: "Claude", filePath: claudePath });
		const agentsSkill = makeSkill({ name: "agents-foo", description: "Agents", filePath: agentsPath });
		const prompt = resolveCursorSkillSystemPrompt(
			"System prompt.",
			cursorModel,
			{ ...createDefaultSystemPromptOptions(join(root, "repo")), skills: [agentsSkill, claudeSkill] },
			"local",
			{ homeDir: home, cwd: join(root, "repo"), settingSources: ["user"] },
		);

		// `.claude/skills` is scanned before `.agents/skills`, and Cursor keeps only the
		// first path for the shared key. The `.agents` copy is in neither list if Pi drops it too.
		expect(prompt).not.toContain("<name>claude-foo</name>");
		expect(prompt).toContain("<name>agents-foo</name>");
	});

	it("keeps a later skill when Cursor's earlier copy is not in Pi's catalog", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-cursor-skill-dedupe-hidden-"));
		onTestFinished(() => rm(root, { recursive: true, force: true }));
		const home = join(root, "home");
		const cursorDir = join(home, ".cursor", "skills", "foo");
		const agentsDir = join(home, ".agents", "skills", "foo");
		await mkdir(cursorDir, { recursive: true });
		await mkdir(agentsDir, { recursive: true });
		await writeFile(join(cursorDir, "SKILL.md"), "---\nname: cursor-foo\ndescription: Cursor\n---\n# Cursor\n");
		const agentsPath = join(agentsDir, "SKILL.md");
		await writeFile(agentsPath, "---\nname: agents-foo\ndescription: Agents\n---\n# Agents\n");
		const agentsSkill = makeSkill({ name: "agents-foo", description: "Agents", filePath: agentsPath });
		const prompt = resolveCursorSkillSystemPrompt(
			"System prompt.",
			cursorModel,
			{ ...createDefaultSystemPromptOptions(join(root, "repo")), skills: [agentsSkill] },
			"local",
			{ homeDir: home, cwd: join(root, "repo"), settingSources: ["user"] },
		);

		// Pi never loaded the `.cursor` copy, but Cursor scans it first and drops `.agents`.
		expect(prompt).toContain("<name>agents-foo</name>");
	});

	it("drops a later skill when the earlier file is one Cursor itself skips", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-cursor-skill-dedupe-skipped-"));
		onTestFinished(() => rm(root, { recursive: true, force: true }));
		const home = join(root, "home");
		const cursorDir = join(home, ".cursor", "skills", "foo");
		const agentsDir = join(home, ".agents", "skills", "foo");
		await mkdir(cursorDir, { recursive: true });
		await mkdir(agentsDir, { recursive: true });
		await writeFile(
			join(cursorDir, "SKILL.md"),
			"---\nname: cursor-foo\ndescription: Cursor\nmetadata:\n  surfaces:\n    - ide\n---\n# Cursor\n",
		);
		const agentsPath = join(agentsDir, "SKILL.md");
		await writeFile(agentsPath, "---\nname: agents-foo\ndescription: Agents\n---\n# Agents\n");
		const agentsSkill = makeSkill({ name: "agents-foo", description: "Agents", filePath: agentsPath });
		const prompt = resolveCursorSkillSystemPrompt(
			"System prompt.",
			cursorModel,
			{ ...createDefaultSystemPromptOptions(join(root, "repo")), skills: [agentsSkill] },
			"local",
			{ homeDir: home, cwd: join(root, "repo"), settingSources: ["user"] },
		);

		// The earlier file is not a skill on the sdk surface, so Cursor lists the `.agents` copy.
		expect(prompt).not.toContain("<name>agents-foo</name>");
	});

	it("keeps a later skill when the earlier file is malformed", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-cursor-skill-dedupe-malformed-"));
		onTestFinished(() => rm(root, { recursive: true, force: true }));
		const home = join(root, "home");
		const cursorDir = join(home, ".cursor", "skills", "foo");
		const agentsDir = join(home, ".agents", "skills", "foo");
		await mkdir(cursorDir, { recursive: true });
		await mkdir(agentsDir, { recursive: true });
		await writeFile(join(cursorDir, "SKILL.md"), "---\nname: [unclosed\ndescription: Cursor\n---\n# Cursor\n");
		const agentsPath = join(agentsDir, "SKILL.md");
		await writeFile(agentsPath, "---\nname: agents-foo\ndescription: Agents\n---\n# Agents\n");
		const agentsSkill = makeSkill({ name: "agents-foo", description: "Agents", filePath: agentsPath });
		const prompt = resolveCursorSkillSystemPrompt(
			"System prompt.",
			cursorModel,
			{ ...createDefaultSystemPromptOptions(join(root, "repo")), skills: [agentsSkill] },
			"local",
			{ homeDir: home, cwd: join(root, "repo"), settingSources: ["user"] },
		);

		// Cursor still records a parse-error skill at the earlier path, and that entry wins the key.
		expect(prompt).toContain("<name>agents-foo</name>");
	});

	it("keeps a later skill when the earlier file is a symlink into a pruned target", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-cursor-skill-dedupe-symlink-"));
		onTestFinished(() => rm(root, { recursive: true, force: true }));
		const home = join(root, "home");
		const imagegenDir = join(home, ".codex", "skills", "imagegen");
		const claudeFoo = join(home, ".claude", "skills", "foo");
		const agentsDir = join(home, ".agents", "skills", "foo");
		await mkdir(imagegenDir, { recursive: true });
		await mkdir(join(home, ".claude", "skills"), { recursive: true });
		await mkdir(agentsDir, { recursive: true });
		await writeFile(join(imagegenDir, "SKILL.md"), "---\nname: imagegen\ndescription: Image\n---\n# Image\n");
		await symlink(imagegenDir, claudeFoo);
		const agentsPath = join(agentsDir, "SKILL.md");
		await writeFile(agentsPath, "---\nname: agents-foo\ndescription: Agents\n---\n# Agents\n");
		const agentsSkill = makeSkill({ name: "agents-foo", description: "Agents", filePath: agentsPath });
		const prompt = resolveCursorSkillSystemPrompt(
			"System prompt.",
			cursorModel,
			{ ...createDefaultSystemPromptOptions(join(root, "repo")), skills: [agentsSkill] },
			"local",
			{ homeDir: home, cwd: join(root, "repo"), settingSources: ["user"] },
		);

		// Cursor records the literal `.claude/skills/foo/SKILL.md` path, which `bp` does not prune.
		expect(prompt).toContain("<name>agents-foo</name>");
	});
});

describe("resolveCursorSkillSystemPrompt", () => {
	const cursorModel = makeModel("composer-2.5");
	const otherModel = { provider: "anthropic", id: "claude-sonnet-4-5" } as ReturnType<typeof makeModel>;
	const skill = makeSkill({ name: "global-skill", description: "Global pi skill", filePath: "/Users/me/.pi/agent/skills/global-skill/SKILL.md" });
	const piSkillSection = [
		"System prompt before skills.",
		"",
		"The following skills provide specialized instructions for specific tasks.",
		"Use the read tool to load a skill's file when the task matches its description.",
		"",
		"<available_skills>",
		"  <skill>",
		"    <name>global-skill</name>",
		"    <description>Global pi skill</description>",
		"    <location>/Users/me/.pi/agent/skills/global-skill/SKILL.md</location>",
		"  </skill>",
		"</available_skills>",
	].join("\n");

	it("does not change prompts for non-Cursor models", () => {
		expect(
			resolveCursorSkillSystemPrompt(piSkillSection, otherModel, { ...createDefaultSystemPromptOptions("/repo"), skills: [skill] }),
		).toBe(piSkillSection);
	});

	it("replaces pi's raw read-based skill wording and preserves the catalog through prompt sanitization", () => {
		const resolved = resolveCursorSkillSystemPrompt(
			piSkillSection,
			cursorModel,
			{ ...createDefaultSystemPromptOptions("/repo"), skills: [skill] },
		);
		expect(resolved).toContain(CURSOR_ACTIVATE_SKILL_MCP_NAME);
		expect(resolved).toContain("<name>global-skill</name>");
		expect(resolved).not.toContain("Use the read tool to load a skill's file");
		const prompt = buildCursorPrompt({ systemPrompt: resolved, messages: [] });

		expect(prompt.text).toContain(CURSOR_ACTIVATE_SKILL_MCP_NAME);
		expect(prompt.text).toContain("global-skill");
	});
});

describe("registerCursorSkillTool", () => {
	it("adds a bridgeable activation tool for Cursor runs with visible pi skills", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-cursor-skill-"));
		onTestFinished(() => rm(dir, { recursive: true, force: true }));
		const skillDir = join(dir, "global-skill");
		await mkdir(join(skillDir, "references"), { recursive: true });
		const skillPath = join(skillDir, "SKILL.md");
		await writeFile(skillPath, "---\nname: global-skill\ndescription: Global skill\n---\n# Global Skill\nFollow this skill.");
		await writeFile(join(skillDir, "references", "guide.md"), "Reference details");
		const skill = makeSkill({ name: "global-skill", description: "Global skill", filePath: skillPath });
		const pi = createPiHarness({ activeTools: ["read"] });
		registerCursorSkillTool(pi);

		const event = {
			type: "before_agent_start",
			messageType: "user",
			prompt: "hello",
			systemPrompt: "System prompt.",
			systemPromptOptions: { ...createDefaultSystemPromptOptions(dir), skills: [skill] },
		} satisfies BeforeAgentStartEvent & { messageType: "user" };
		const result = await pi.invokeEvent("before_agent_start", event, { model: makeModel("composer-2.5"), cwd: dir });

		expect(result?.systemPrompt).toContain(CURSOR_ACTIVATE_SKILL_MCP_NAME);
		expect(pi._activeToolNames()).toContain(CURSOR_ACTIVATE_SKILL_TOOL_NAME);
		expect(buildCursorPiToolBridgeSnapshot(pi).piToolNameToMcpToolName.get(CURSOR_ACTIVATE_SKILL_TOOL_NAME)).toBe(CURSOR_ACTIVATE_SKILL_MCP_NAME);

		const tool = getHarnessRegisteredTool(pi._tools, CURSOR_ACTIVATE_SKILL_TOOL_NAME);
		const toolResult = await tool.execute("call-1", { name: "global-skill" }, undefined, undefined, createExtensionTestContext({ model: makeModel("composer-2.5"), cwd: dir }));
		const text = toolResult.content?.[0]?.type === "text" ? toolResult.content[0].text : "";

		expect(toolResult).not.toMatchObject({ isError: true });
		expect(text).toContain("<skill_content name=\"global-skill\">");
		expect(text).toContain("# Global Skill");
		expect(text).toContain("references/guide.md");
	});

	it("keeps the activation tool inactive and omits the catalog in cloud runtime", async () => {
		process.env.PI_CURSOR_RUNTIME = "cloud";
		const skill = makeSkill({ name: "global-skill", description: "Global skill", filePath: "/repo/global-skill/SKILL.md" });
		const pi = createPiHarness({ activeTools: ["read"] });
		registerCursorSkillTool(pi);

		const event = {
			type: "before_agent_start",
			messageType: "user",
			prompt: "hello",
			systemPrompt: [
				"System prompt.",
				"",
				"The following skills provide specialized instructions for specific tasks.",
				"<available_skills><skill><name>global-skill</name><location>/repo/global-skill/SKILL.md</location></skill></available_skills>",
			].join("\n"),
			systemPromptOptions: { ...createDefaultSystemPromptOptions("/repo"), skills: [skill] },
		} satisfies BeforeAgentStartEvent & { messageType: "user" };
		const result = await pi.invokeEvent("before_agent_start", event, { model: makeModel("composer-2.5"), cwd: "/repo" });

		expect(result?.systemPrompt).toContain("System prompt.");
		expect(result?.systemPrompt).not.toContain("<available_skills>");
		expect(result?.systemPrompt).not.toContain("/repo/global-skill/SKILL.md");
		expect(result?.systemPrompt).not.toContain(CURSOR_ACTIVATE_SKILL_MCP_NAME);
		expect(pi._activeToolNames()).not.toContain(CURSOR_ACTIVATE_SKILL_TOOL_NAME);
	});

	it("ignores invalid Cursor runtime overrides for non-Cursor models", async () => {
		process.env.PI_CURSOR_RUNTIME = "remote";
		const pi = createPiHarness({ activeTools: ["read"] });
		registerCursorSkillTool(pi);
		const model = { provider: "anthropic", id: "claude-sonnet-4-5" } as ExtensionContext["model"];

		const event = {
			type: "before_agent_start",
			messageType: "user",
			prompt: "hello",
			systemPrompt: "System prompt.",
			systemPromptOptions: createDefaultSystemPromptOptions("/repo"),
		} satisfies BeforeAgentStartEvent & { messageType: "user" };
		const result = await pi.invokeEvent("before_agent_start", event, { model, cwd: "/repo" });

		expect(result).toBeUndefined();
		expect(pi._activeToolNames()).not.toContain(CURSOR_ACTIVATE_SKILL_TOOL_NAME);
	});

	it("drops Cursor-scanned skills from the prompt and the activation tool", async () => {
		const previousSettingSources = process.env.PI_CURSOR_SETTING_SOURCES;
		process.env.PI_CURSOR_SETTING_SOURCES = "all";
		onTestFinished(() => {
			if (previousSettingSources === undefined) delete process.env.PI_CURSOR_SETTING_SOURCES;
			else process.env.PI_CURSOR_SETTING_SOURCES = previousSettingSources;
		});
		const dir = await mkdtemp(join(tmpdir(), "pi-cursor-skill-overlap-"));
		onTestFinished(() => rm(dir, { recursive: true, force: true }));
		const keptDir = join(dir, "pi-only");
		await mkdir(keptDir, { recursive: true });
		const keptPath = join(keptDir, "SKILL.md");
		await writeFile(keptPath, "---\nname: pi-only\ndescription: Pi only\n---\n# Pi only\nKeep this skill.");
		const projectSkillDir = join(dir, ".agents", "skills", "project-skill");
		await mkdir(projectSkillDir, { recursive: true });
		const projectSkillPath = join(projectSkillDir, "SKILL.md");
		await writeFile(projectSkillPath, "---\nname: project-skill\ndescription: Project skill\n---\n# Project skill\n");
		const skills = [
			makeSkill({ name: "project-skill", description: "Project skill", filePath: projectSkillPath }),
			makeSkill({ name: "pi-only", description: "Pi only", filePath: keptPath }),
		];
		const pi = createPiHarness({ activeTools: ["read"] });
		registerCursorSkillTool(pi);
		const event = {
			type: "before_agent_start",
			messageType: "user",
			prompt: "hello",
			systemPrompt: "System prompt.",
			systemPromptOptions: { ...createDefaultSystemPromptOptions(dir), skills },
		} satisfies BeforeAgentStartEvent & { messageType: "user" };
		const result = await pi.invokeEvent("before_agent_start", event, { model: makeModel("composer-2.5"), cwd: dir });
		const prompt = result?.systemPrompt ?? "";
		expect(prompt).toContain("<name>pi-only</name>");
		expect(prompt).not.toContain("project-skill");

		const tool = getHarnessRegisteredTool(pi._tools, CURSOR_ACTIVATE_SKILL_TOOL_NAME);
		const context = createExtensionTestContext({ model: makeModel("composer-2.5"), cwd: dir });
		await expect(tool.execute("call-project", { name: "project-skill" }, undefined, undefined, context)).rejects.toThrow(/project-skill/);
		const kept = await tool.execute("call-kept", { name: "pi-only" }, undefined, undefined, context);
		const text = kept.content?.[0]?.type === "text" ? kept.content[0].text : "";
		expect(text).toContain("<skill_content name=\"pi-only\">");
		expect(text).toContain("# Pi only");
	});

	it("does not expose the activation tool when no visible skills are available", async () => {
		const pi = createPiHarness({ activeTools: ["read"] });
		registerCursorSkillTool(pi);
		const event = {
			type: "before_agent_start",
			messageType: "user",
			prompt: "hello",
			systemPrompt: "System prompt.",
			systemPromptOptions: createDefaultSystemPromptOptions("/repo"),
		} satisfies BeforeAgentStartEvent & { messageType: "user" };
		await pi.invokeEvent("before_agent_start", event, { model: makeModel("composer-2.5"), cwd: "/repo" });

		expect(pi._activeToolNames()).not.toContain(CURSOR_ACTIVATE_SKILL_TOOL_NAME);
	});
});
