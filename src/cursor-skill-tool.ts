import { readFileSync, realpathSync, statSync, type Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { SettingSource } from "@cursor/sdk";
import {
	parseFrontmatter,
	type BuildSystemPromptOptions,
	type ExtensionAPI,
	type ExtensionContext,
	type Skill,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { arePiToolsDisabled } from "./cursor-active-tools.js";
import type { CursorRuntime } from "./cursor-config.js";
import { isCursorModel } from "./cursor-model.js";
import { registerCursorModelLifecycle, type CursorModelLifecycleExtensionApi } from "./cursor-model-lifecycle.js";
import { resolveCursorPiToolBridgeEnabled } from "./cursor-pi-tool-bridge-env.js";
import { asRecord } from "./cursor-record-utils.js";
import { resolveCursorSessionRepoRoot } from "./cursor-session-agent-resume.js";
import { resolveEffectiveCursorConfigForContext } from "./cursor-runtime-state.js";
import { cursorSettingSourcesIncludes, getEffectiveCursorSettingSources } from "./cursor-setting-sources.js";

export const CURSOR_ACTIVATE_SKILL_TOOL_NAME = "cursor_activate_skill";
export const CURSOR_ACTIVATE_SKILL_MCP_NAME = "pi__cursor_activate_skill";

const AVAILABLE_SKILLS_SECTION_PATTERN = /<skills>\nThe following skills provide specialized instructions for specific tasks\.[\s\S]*?<\/available_skills>\n<\/skills>|\n\nThe following skills provide specialized instructions for specific tasks\.[\s\S]*?<\/available_skills>/;
const MAX_SKILL_RESOURCES = 80;
const RESOURCE_DIR_NAMES = ["scripts", "references", "assets"] as const;

type CursorSkillToolExtensionApi = Pick<ExtensionAPI, "getActiveTools" | "registerTool" | "setActiveTools"> & CursorModelLifecycleExtensionApi;

/** Cursor's `configDir/subdir` pairs for skill pruning (`bp`), including the builtin and `.cursor` roots. */
const CURSOR_SKILL_SCAN_SEGMENTS: readonly (readonly [string, string])[] = [
	[".cursor", "skills"],
	[".claude", "skills"],
	[".codex", "skills"],
	[".grok", "skills"],
	[".agents", "skills"],
	[".cursor", "skills-cursor"],
];

/** Builtin `.codex/skills` names Cursor prunes outright (`vp`). */
const CURSOR_CODEX_BUILTIN_SKILL_NAMES: ReadonlySet<string> = new Set([
	"imagegen",
	"openai-docs",
	"opneai-docs",
	"plugin-creator",
	"skill-creator",
	"skill-installer",
]);

/** Directories `Op` refuses to descend into (`Dp`). Dot-prefixed names are skipped too. */
const CURSOR_SKILL_WALK_SKIP_DIRECTORIES: ReadonlySet<string> = new Set(["node_modules", "__pycache__", "dist", "build"]);

/** `Op`'s `maxDepth` default: it stops descending past this depth below the scan root. */
const CURSOR_SKILL_WALK_MAX_DEPTH = 10;

/**
 * Skill directories Cursor local agents already scan.
 * `user` is relative to the home directory. `project` is relative to the session cwd.
 * Home copies are not treated as project skills when the session cwd is the home directory.
 *
 * Verified against `@cursor/sdk` 1.0.40. `.cursor/skills`, `.claude/skills`,
 * `.codex/skills`, `.grok/skills`, and `.agents/skills` are allowed roots. The
 * third-party ones depend on `getThirdPartyExtensibilityEnabled`, which defaults
 * to `() => true` and which this extension never turns off.
 *
 * `~/.cursor/skills-cursor` is deliberately absent. The SDK lists it only through
 * its managed-skills sync: `includeManagedSkills` requires the `team` source and a
 * dashboard transport, and its root is excluded when that sync does not run. This
 * extension supplies no dashboard transport, so that directory is never scanned
 * and dropping skills found there would remove the only copy.
 */
const CURSOR_USER_SKILL_DIRECTORIES = [
	[".agents", "skills"],
	[".cursor", "skills"],
	[".claude", "skills"],
	[".codex", "skills"],
	[".grok", "skills"],
] as const;

const CURSOR_PROJECT_SKILL_DIRECTORIES = [
	[".agents", "skills"],
	[".cursor", "skills"],
	[".claude", "skills"],
	[".codex", "skills"],
	[".grok", "skills"],
] as const;

/** Overrides for tests. Omitted fields use the live home directory, session cwd, and `PI_CURSOR_SETTING_SOURCES`. */
export type CursorSkillCatalogContext = {
	homeDir?: string;
	cwd?: string;
	/** Cursor's project workspace root; omitted fields use the cwd's git root, then the cwd. */
	projectRoot?: string;
	settingSources?: SettingSource[] | undefined;
};

type CursorActivateSkillParams = {
	name?: string;
};

interface CursorSkillActivationDetails {
	name: string;
	filePath: string;
	baseDir: string;
	resources: string[];
	availableSkillNames: string[];
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function getVisibleSkills(skills: readonly Skill[] | undefined): Skill[] {
	return (skills ?? []).filter((skill) => !skill.disableModelInvocation);
}

function pathKey(filePath: string): string {
	const normalized = resolve(filePath).replace(/\\/g, "/");
	return process.platform === "win32" || process.platform === "darwin" ? normalized.toLowerCase() : normalized;
}

function pathIsInside(filePath: string, root: string): boolean {
	const file = pathKey(filePath);
	const base = pathKey(root);
	return file === base || file.startsWith(`${base}/`);
}

function tryRealpath(filePath: string): string | undefined {
	try {
		return realpathSync(filePath);
	} catch {
		return undefined;
	}
}

function effectiveSettingSources(context: CursorSkillCatalogContext | undefined): SettingSource[] | undefined {
	if (context && Object.hasOwn(context, "settingSources")) return context.settingSources;
	return getEffectiveCursorSettingSources();
}

/**
 * Cursor's project workspace root. `ZC.resolveWorkspaceState` derives it with
 * `git rev-parse --show-toplevel` and falls back to the working directory, and
 * `DP()` uses that as both the `project` allowed root and the scan root. Pi instead
 * walks `.agents/skills` from the cwd up to the repo root, so using the cwd here
 * would drop a subdirectory skill Cursor never sees and duplicate a repo-root skill.
 */
function cursorSkillProjectRoot(
	systemPromptOptions: Pick<BuildSystemPromptOptions, "cwd"> | undefined,
	context?: CursorSkillCatalogContext,
): string | undefined {
	const cwd = context?.cwd ?? systemPromptOptions?.cwd;
	if (!cwd) return undefined;
	if (context?.projectRoot) return context.projectRoot;
	return resolveCursorSessionRepoRoot(cwd) ?? cwd;
}

/** One session's picture of what Cursor's local SDK scans, derived once per prompt. */
export type CursorSkillScanPlan = {
	/** Directories Cursor enumerates for `SKILL.md` (`Ep`/`Cp` roots walked by `Vp`). */
	scanRoots: string[];
	/** Directories Cursor allows discovered files to resolve inside (`allowedRoots`). */
	allowedRoots: string[];
	/** Directories Cursor excludes from its list even when discovered (`excludedRoots`). */
	excludedRoots: string[];
};

/**
 * What Cursor's local SDK definitely scans for this session.
 *
 * Only the top-level `Ep`/`Cp` roots are modelled. Cursor's nested `Mp` walk has a
 * git gate, a home-equality early return, a different exclude set, and a depth
 * limit, and getting one of those wrong would drop a skill Cursor never lists. A
 * duplicate costs tokens; a wrongly dropped skill is unusable, so duplicates stay.
 */
export function cursorSkillScanPlan(
	systemPromptOptions: Pick<BuildSystemPromptOptions, "cwd"> | undefined,
	context?: CursorSkillCatalogContext,
): CursorSkillScanPlan {
	const homeDir = context?.homeDir ?? homedir();
	const settingSources = effectiveSettingSources(context);
	const includeUser = cursorSettingSourcesIncludes(settingSources, "user");
	const projectRoot = cursorSettingSourcesIncludes(settingSources, "project")
		? cursorSkillProjectRoot(systemPromptOptions, context)
		: undefined;
	const scanRoots = new Map<string, string>();
	const allowedRoots = new Map<string, string>();
	const excludedRoots = new Map<string, string>();
	const add = (map: Map<string, string>, value: string) => {
		const key = pathKey(value);
		if (!map.has(key)) map.set(key, value);
	};
	if (includeUser) {
		for (const parts of CURSOR_USER_SKILL_DIRECTORIES) add(scanRoots, join(homeDir, ...parts));
		add(allowedRoots, homeDir);
	}
	if (projectRoot) {
		for (const parts of CURSOR_PROJECT_SKILL_DIRECTORIES) add(scanRoots, join(projectRoot, ...parts));
		add(allowedRoots, projectRoot);
	}
	// `DP()` excludes the managed skills root unless its sync ran, which needs the
	// `team` source and a dashboard transport this extension never supplies. That gate
	// is independent of which setting sources are loaded.
	add(excludedRoots, join(homeDir, ".cursor", "skills-cursor"));
	return {
		scanRoots: [...scanRoots.values()],
		allowedRoots: [...allowedRoots.values()],
		excludedRoots: [...excludedRoots.values()],
	};
}

/**
 * Skills that stay in Pi's Cursor catalog.
 *
 * A skill is dropped only when Cursor can be shown to list it, because a duplicate
 * costs tokens while a wrongly dropped skill is unusable. Cursor's top-level scan is
 * predictable: `Vp` walks each `Ep`/`Cp` root with `Op`, which follows symlinks,
 * skips dot-prefixed and `Dp` directories, and stops past depth 10; `OP` then
 * requires the resolved file inside a resolved allowed root; `bp` on the enumerated
 * path, not the symlink target, drops a builtin `.codex` name; `ef` and `rf` drop a
 * `metadata.surfaces` list without `sdk` and an `alwaysApply` rule. A YAML merge key
 * or custom tag is untrusted, so those filters are not applied to it. `Lp` then
 * keeps one skill per cross-root key (`jp`: the path
 * before the first `.cursor`, `.claude`, `.codex`, `.grok`, or `.agents` marker,
 * plus the path after it). Those roots are scanned in that order. Only the earliest
 * file Cursor keeps is dropped, including one Pi did not load and one Cursor records
 * as a parse or read error. Every later copy stays.
 *
 * Cursor's nested `Mp` walk is deliberately not modelled. It adds a git gate, a
 * home-equality early return, its own exclude globs, and its own depth handling, so a
 * nested skill stays in Pi's catalog and may also appear in Cursor's list.
 */
function selectCursorCatalogSkills(
	skills: readonly Skill[] | undefined,
	plan: CursorSkillScanPlan,
): Skill[] {
	const visible = getVisibleSkills(skills);
	if (plan.scanRoots.length === 0) return visible;
	const resolvedAllowedRoots = plan.allowedRoots.map((root) => tryRealpath(root) ?? root);
	const resolvedExcludedRoots = plan.excludedRoots.map((root) => tryRealpath(root) ?? root);
	return visible.filter((skill) => !cursorListsSkill(skill, plan, resolvedAllowedRoots, resolvedExcludedRoots));
}

/**
 * `jp`'s marker priority. It matches the order `Ep`/`Cp` insert scan roots, and
 * `Lp` keeps the first listable file per key. Two files share a key only when the
 * path before the marker is the same, so they are walked in this order.
 */
const CURSOR_SKILL_DEDUPE_MARKERS = ["/.cursor/", "/.claude/", "/.codex/", "/.grok/", "/.agents/"] as const;

type CursorSkillDedupeKey =
	| { readonly kind: "marked"; readonly markerIndex: number; readonly prefix: string; readonly remainder: string }
	| { readonly kind: "raw" };

/** Whether Cursor's merged list includes this skill, so Pi's catalog should drop it. */
function cursorListsSkill(
	skill: Skill,
	plan: CursorSkillScanPlan,
	resolvedAllowedRoots: readonly string[],
	resolvedExcludedRoots: readonly string[],
): boolean {
	if (cursorSkillListing(skill, plan, resolvedAllowedRoots, resolvedExcludedRoots) !== "listed") return false;
	return !earlierCursorFileHidesSkill(skill, plan, resolvedAllowedRoots, resolvedExcludedRoots);
}

/**
 * True when an earlier scan root has a different `SKILL.md` that `Lp` keeps for this key.
 * A listable file and a parse or read error both occupy the key. A file Cursor skips
 * does not. Pi may never have loaded the earlier copy.
 */
function earlierCursorFileHidesSkill(
	skill: Skill,
	plan: CursorSkillScanPlan,
	resolvedAllowedRoots: readonly string[],
	resolvedExcludedRoots: readonly string[],
): boolean {
	const enumerated = cursorEnumeratedSkillPath(skill, plan) ?? skill.filePath;
	const parsed = cursorSkillDedupeKey(enumerated);
	if (parsed.kind !== "marked") return false;
	const ownReal = pathKey(tryRealpath(skill.filePath) ?? skill.filePath);
	for (let index = 0; index < parsed.markerIndex; index++) {
		const marker = CURSOR_SKILL_DEDUPE_MARKERS[index];
		if (marker === undefined) continue;
		const candidate = `${parsed.prefix}${marker}${parsed.remainder}`;
		const candidateReal = tryRealpath(candidate);
		if (!candidateReal || pathKey(candidateReal) === ownReal) continue;
		const listing = cursorSkillListing({ filePath: candidate }, plan, resolvedAllowedRoots, resolvedExcludedRoots);
		if (listing === "listed" || listing === "error") return true;
	}
	return false;
}

/**
 * The path `Op` records and `jp` keys.
 *
 * A literal path under a scan root counts only when `Op` would walk it. A `build`
 * directory is skipped before the symlink is followed, so `bp` then sees the
 * resolved target instead of the skipped literal path. When the scan root itself
 * is a symlink, `Op` still records the literal root plus the relative entry, not
 * the target path Pi loaded.
 */
function cursorEnumeratedSkillPath(skill: Pick<Skill, "filePath">, plan: CursorSkillScanPlan): string | undefined {
	for (const scanRoot of plan.scanRoots) {
		const literalSegments = relativeSegments(skill.filePath, scanRoot);
		if (literalSegments !== undefined && cursorWalkKeepsSegments(literalSegments)) return skill.filePath;
	}
	const resolvedFile = tryRealpath(skill.filePath);
	if (!resolvedFile) return undefined;
	for (const scanRoot of plan.scanRoots) {
		const resolvedRoot = tryRealpath(scanRoot) ?? scanRoot;
		const resolvedSegments = relativeSegments(resolvedFile, resolvedRoot);
		if (resolvedSegments === undefined || !cursorWalkKeepsSegments(resolvedSegments)) continue;
		// `Op` records join(literal scan root, entry name), not the symlink target.
		const rel = relative(resolvedRoot, resolvedFile);
		if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) continue;
		return join(scanRoot, rel);
	}
	return undefined;
}

/** Cursor's `jp`: prefix before the first marker, then the path after that marker. */
function cursorSkillDedupeKey(filePath: string): CursorSkillDedupeKey {
	const normalized = filePath.replace(/\\/g, "/");
	const lower = normalized.toLowerCase();
	for (const [markerIndex, marker] of CURSOR_SKILL_DEDUPE_MARKERS.entries()) {
		const at = lower.indexOf(marker);
		if (at === -1) continue;
		return {
			kind: "marked",
			markerIndex,
			prefix: normalized.slice(0, at),
			remainder: normalized.slice(at + marker.length),
		};
	}
	return { kind: "raw" };
}

/** How Cursor's top-level scan treats one `SKILL.md` before `Lp` merges keys. */
type CursorSkillListing = "listed" | "error" | "skipped";

function cursorSkillListing(
	skill: Pick<Skill, "filePath">,
	plan: CursorSkillScanPlan,
	resolvedAllowedRoots: readonly string[],
	resolvedExcludedRoots: readonly string[],
): CursorSkillListing {
	// Both `Op` and `Mp` only enumerate a file named exactly `SKILL.md`.
	if (!/[/\\]SKILL\.md$/.test(skill.filePath)) return "skipped";
	const resolvedFile = tryRealpath(skill.filePath);
	// Cursor drops a file it cannot resolve, so it lists nothing here.
	if (!resolvedFile) return "skipped";
	if (!isCursorDiscoveredSkill(skill.filePath, resolvedFile, plan)) return "skipped";
	if (resolvedExcludedRoots.some((root) => pathIsInside(resolvedFile, root))) return "skipped";
	if (!resolvedAllowedRoots.some((root) => pathIsInside(resolvedFile, root))) return "skipped";
	// `bp` runs on the path `Op` records: the literal path under a scan root, or the
	// resolved path when pi reached the file through a symlink into one. The symlink
	// target is not a second check. A `.claude` path that points at a pruned `.codex`
	// builtin is still listed, and `Lp` keeps it.
	const enumerated = cursorEnumeratedSkillPath(skill, plan) ?? skill.filePath;
	if (cursorSkillPathIsPruned(enumerated)) return "skipped";
	// `Op` records files only. A directory named `SKILL.md` is not an error skill.
	if (!isRegularFile(resolvedFile)) return "skipped";
	const frontmatter = readCursorSkillFrontmatter(skill.filePath);
	// `Jp` still returns an AgentSkill on read or parse failure, and `Lp` keys it.
	if (!frontmatter) return "error";
	// Cursor turns an `alwaysApply` entry into a rule, so it is never a skill there.
	if (frontmatter.alwaysApply === true) return "skipped";
	if (frontmatterExcludesSdkSurface(frontmatter)) return "skipped";
	return "listed";
}

function isRegularFile(filePath: string): boolean {
	try {
		return statSync(filePath).isFile();
	} catch {
		return false;
	}
}

/**
 * Whether `Op` would enumerate this `SKILL.md` from one of the top-level scan roots.
 *
 * `Op` starts at the literal scan root and realpaths each directory as it descends, so
 * a skill qualifies when either its literal path or its resolved path sits below that
 * root and every directory below the root survives `Op`'s prune and depth rules.
 */
function isCursorDiscoveredSkill(skillFilePath: string, resolvedFile: string, plan: CursorSkillScanPlan): boolean {
	for (const scanRoot of plan.scanRoots) {
		const resolvedSegments = relativeSegments(resolvedFile, tryRealpath(scanRoot) ?? scanRoot);
		if (resolvedSegments !== undefined && cursorWalkKeepsSegments(resolvedSegments)) return true;
		// A symlinked scan root is still walked from its literal location; the
		// allowed-root check above decides whether the target is usable.
		const literalSegments = relativeSegments(skillFilePath, scanRoot);
		if (literalSegments !== undefined && cursorWalkKeepsSegments(literalSegments)) return true;
	}
	return false;
}

/** `Op`'s prune and depth rules over the directories between a root and the file. */
function cursorWalkKeepsSegments(segments: readonly string[]): boolean {
	// `Op` stops descending when depth would exceed 10; directories + file name.
	if (segments.length > CURSOR_SKILL_WALK_MAX_DEPTH + 1) return false;
	// Both walkers skip dot-prefixed and `Dp` directories.
	if (segments.slice(0, -1).some(cursorWalkSkipsDirectory)) return false;
	return true;
}

/** Path segments of `filePath` below `root`, or undefined when it is not inside. */
function relativeSegments(filePath: string, root: string): string[] | undefined {
	const file = pathKey(filePath).replace(/\/+$/, "");
	const base = pathKey(root).replace(/\/+$/, "");
	if (file === base) return [];
	if (!file.startsWith(`${base}/`)) return undefined;
	return file.slice(base.length + 1).split("/").filter(Boolean);
}

/** Directory names `Op` refuses to descend into. */
function cursorWalkSkipsDirectory(name: string): boolean {
	return name.startsWith(".") || CURSOR_SKILL_WALK_SKIP_DIRECTORIES.has(name);
}

/**
 * Cursor's `bp` filter, applied to the full absolute path exactly as `yf.loadAll` does:
 * the first `configDir/subdir` pair anywhere in the path, followed by a dot-prefixed
 * segment, prunes the skill. A builtin `.codex/skills` name is pruned outright.
 * Unreadable input returns false so the skill stays.
 */
function cursorSkillPathIsPruned(skillFilePath: string): boolean {
	const segments = skillFilePath.replace(/\\/g, "/").split("/").filter(Boolean);
	const pairIndex = segments.findIndex((segment, index) =>
		CURSOR_SKILL_SCAN_SEGMENTS.some(([configDir, subdir]) => configDir === segment && subdir === segments[index + 1]));
	if (pairIndex !== -1 && segments.slice(pairIndex + 2).some((segment) => segment.startsWith("."))) return true;
	const codexIndex = segments.lastIndexOf(".codex");
	if (codexIndex === -1 || segments[codexIndex + 1] !== "skills") return false;
	const name = segments.at(-1) === "SKILL.md" ? segments.at(-2) : segments.at(-1);
	return name !== undefined && CURSOR_CODEX_BUILTIN_SKILL_NAMES.has(name);
}

/** Cursor's `ef` filter: a non-empty `metadata.surfaces` list without `sdk` is skipped. */
function frontmatterExcludesSdkSurface(frontmatter: Record<string, unknown>): boolean {
	const metadata = asRecord(frontmatter.metadata);
	if (!metadata) return false;
	const surfaces = Array.isArray(metadata.surfaces)
		? metadata.surfaces
		: typeof metadata.surfaces === "string"
			? metadata.surfaces.split(",").map((entry) => entry.trim()).filter(Boolean)
			: [];
	return surfaces.length > 0 && !surfaces.includes("sdk");
}

/**
 * Frontmatter Cursor parses before deciding what to list. Unreadable, unparsable,
 * or untrusted files return undefined. The skill under test stays in Pi's catalog,
 * and an earlier file in that state still occupies Cursor's dedupe key.
 *
 * Pi's YAML parser does not match gray-matter. A merge key stays literal, so
 * `metadata.surfaces` and `alwaysApply` hidden behind `<<:` are invisible here,
 * while Cursor expands them and may skip the skill. An unknown tag parses here
 * and throws there. An opening `---` with trailing text is a language name for
 * gray-matter and a comment here. A CR-only file, or a bare CR before the next
 * LF, is frontmatter here and an engine-name error there. Any of those shapes
 * is untrusted.
 */
function readCursorSkillFrontmatter(skillFilePath: string): Record<string, unknown> | undefined {
	let content: string;
	try {
		content = readFileSync(skillFilePath, "utf8");
	} catch {
		return undefined;
	}
	if (cursorFrontmatterIsUntrusted(content)) return undefined;
	try {
		return parseFrontmatter(content).frontmatter;
	} catch {
		return undefined;
	}
}

/**
 * The first `---` block. Body text can mention merge keys without changing the parse.
 * A leading BOM and trailing whitespace on a delimiter line still open a block.
 */
function frontmatterBody(content: string): string | undefined {
	const normalized = content.replace(/^\uFEFF/, "");
	return /^---[^\n]*\r?\n([\s\S]*?)\r?\n---[^\n]*(?:\r?\n|$)/.exec(normalized)?.[1];
}

function cursorFrontmatterIsUntrusted(content: string): boolean {
	const withoutBom = content.replace(/^\uFEFF/, "");
	// `ua` turns CRLF into LF and leaves a bare CR. gray-matter then reads the
	// rest of that line, up to the next LF, as an engine name and throws.
	const crlfNormalized = withoutBom.replace(/\r\n/g, "\n");
	const closing = crlfNormalized.indexOf("\n---");
	const frontmatter = closing === -1 ? crlfNormalized : crlfNormalized.slice(0, closing);
	if (frontmatter.includes("\r")) return true;
	const opening = /^---([^\n]*)/.exec(crlfNormalized);
	// gray-matter reads a non-whitespace opening suffix as an engine name and throws.
	if (opening && (opening[1] ?? "").trim() !== "") return true;
	const body = frontmatterBody(crlfNormalized);
	if (body === undefined) return false;
	if (/<<\s*:/.test(body)) return true;
	return /(^|[\s[{,])!(!|[\w<])/.test(body);
}

function resolveEffectiveRuntimeForSkillLifecycle(
	cursorModel: boolean,
	ctx: Pick<ExtensionContext, "cwd"> & Partial<Pick<ExtensionContext, "isProjectTrusted">>,
): CursorRuntime {
	return cursorModel ? resolveEffectiveCursorConfigForContext(ctx).runtime.value : "local";
}

/**
 * Each catalog entry costs a name and a description, plus an absolute SKILL.md
 * path as the file-read fallback.
 */
export function formatCursorSkillsForPrompt(
	skills: readonly Skill[],
	plan: CursorSkillScanPlan = { scanRoots: [], allowedRoots: [], excludedRoots: [] },
): string {
	const visibleSkills = selectCursorCatalogSkills(skills, plan);
	if (visibleSkills.length === 0) return "";

	const lines = [
		"\n\nThe following skills provide specialized instructions for specific tasks.",
		`When a task matches a skill's description, call ${CURSOR_ACTIVATE_SKILL_MCP_NAME} with the skill name to load its full SKILL.md instructions before proceeding.`,
		"If the pi bridge is disabled and the activation tool is unavailable, use Cursor's file-read capability on the listed SKILL.md location instead.",
		"When a skill references relative paths, resolve them against the skill directory (the parent of SKILL.md / dirname of the path) and use absolute paths in tool calls.",
		"",
		"<available_skills>",
	];
	for (const skill of visibleSkills) {
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(`    <description>${escapeXml(skill.description)}</description>`);
		lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
		lines.push("  </skill>");
	}
	lines.push("</available_skills>");
	return lines.join("\n");
}

export function resolveCursorSkillSystemPrompt(
	systemPrompt: string,
	model: ExtensionContext["model"],
	systemPromptOptions?: BuildSystemPromptOptions,
	runtime: CursorRuntime = "local",
	catalogContext?: CursorSkillCatalogContext,
): string {
	if (!isCursorModel(model)) return systemPrompt;
	if (runtime === "cloud") return systemPrompt.replace(AVAILABLE_SKILLS_SECTION_PATTERN, "");
	const replacement = formatCursorSkillsForPrompt(
		systemPromptOptions?.skills ?? [],
		cursorSkillScanPlan(systemPromptOptions, catalogContext),
	);
	if (replacement === "") return systemPrompt.replace(AVAILABLE_SKILLS_SECTION_PATTERN, "");
	if (AVAILABLE_SKILLS_SECTION_PATTERN.test(systemPrompt)) {
		return systemPrompt.replace(AVAILABLE_SKILLS_SECTION_PATTERN, replacement);
	}
	return `${systemPrompt}${replacement}`;
}

async function collectResourcePaths(root: string, absoluteDir: string, output: string[]): Promise<void> {
	if (output.length >= MAX_SKILL_RESOURCES) return;
	let entries: Dirent[];
	try {
		entries = await readdir(absoluteDir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (output.length >= MAX_SKILL_RESOURCES) return;
		const absolutePath = join(absoluteDir, entry.name);
		if (entry.isSymbolicLink()) continue;
		if (entry.isDirectory()) {
			await collectResourcePaths(root, absolutePath, output);
			continue;
		}
		if (!entry.isFile()) continue;
		output.push(relative(root, absolutePath).replace(/\\/g, "/"));
	}
}

async function listSkillResourcePaths(baseDir: string): Promise<string[]> {
	const resources: string[] = [];
	for (const resourceDirName of RESOURCE_DIR_NAMES) {
		await collectResourcePaths(baseDir, join(baseDir, resourceDirName), resources);
		if (resources.length >= MAX_SKILL_RESOURCES) break;
	}
	return resources;
}

function formatSkillResources(resources: readonly string[]): string {
	if (resources.length === 0) return "<skill_resources />";
	return [
		"<skill_resources>",
		...resources.map((resource) => `  <file>${escapeXml(resource)}</file>`),
		"</skill_resources>",
	].join("\n");
}

function wrapSkillContent(skill: Skill, content: string, resources: readonly string[]): string {
	const baseDir = dirname(skill.filePath);
	return [
		`<skill_content name=\"${escapeXml(skill.name)}\">`,
		content.trim(),
		"",
		`Skill directory: ${baseDir}`,
		"Relative paths in this skill are relative to the skill directory.",
		formatSkillResources(resources),
		"</skill_content>",
	].join("\n");
}

export function registerCursorSkillTool(pi: CursorSkillToolExtensionApi): void {
	let currentSkillsByName = new Map<string, Skill>();

	function setCurrentSkills(skills: readonly Skill[] | undefined): void {
		currentSkillsByName = new Map(getVisibleSkills(skills).map((skill) => [skill.name, skill]));
	}

	function getAvailableSkillNames(): string[] {
		return [...currentSkillsByName.keys()].sort();
	}

	function syncCursorSkillToolForModel(model: ExtensionContext["model"], runtime: CursorRuntime): void {
		const activeToolNames = new Set(pi.getActiveTools());
		const shouldBeActive = !arePiToolsDisabled(pi) && runtime === "local" && isCursorModel(model)
			&& resolveCursorPiToolBridgeEnabled() && currentSkillsByName.size > 0;
		const alreadyActive = activeToolNames.has(CURSOR_ACTIVATE_SKILL_TOOL_NAME);
		if (shouldBeActive === alreadyActive) return;
		if (shouldBeActive) {
			activeToolNames.add(CURSOR_ACTIVATE_SKILL_TOOL_NAME);
		} else {
			activeToolNames.delete(CURSOR_ACTIVATE_SKILL_TOOL_NAME);
		}
		pi.setActiveTools([...activeToolNames]);
	}

	pi.registerTool({
		name: CURSOR_ACTIVATE_SKILL_TOOL_NAME,
		label: "Cursor skill",
		description: "Load full pi Agent Skill instructions for Cursor. Use with a skill name from the current <available_skills> catalog before applying that skill.",
		parameters: Type.Object({
			name: Type.String({ description: "Skill name from the current <available_skills> catalog" }),
		}),
		async execute(_toolCallId, params) {
			const requestedName = (params as CursorActivateSkillParams).name?.trim();
			if (!requestedName) {
				throw new Error("No skill name was provided.");
			}
			const skill = currentSkillsByName.get(requestedName);
			if (!skill) {
				throw new Error(
					`Skill not available: ${requestedName}. Available skills: ${getAvailableSkillNames().join(", ") || "none"}.`,
				);
			}

			try {
				const [content, resources] = await Promise.all([
					readFile(skill.filePath, "utf8"),
					listSkillResourcePaths(dirname(skill.filePath)),
				]);
				return {
					content: [{ type: "text" as const, text: wrapSkillContent(skill, content, resources) }],
					details: {
						name: skill.name,
						filePath: skill.filePath,
						baseDir: dirname(skill.filePath),
						resources,
						availableSkillNames: getAvailableSkillNames(),
					} satisfies CursorSkillActivationDetails,
				};
			} catch (error) {
				throw new Error(
					`Failed to load skill ${requestedName} from ${skill.filePath}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		},
	});

	const clearSkillsAndSync = (model: ExtensionContext["model"], runtime: CursorRuntime = "local"): void => {
		setCurrentSkills([]);
		syncCursorSkillToolForModel(model, runtime);
	};

	registerCursorModelLifecycle(pi, {
		sessionStart: (_event, ctx) => {
			clearSkillsAndSync(ctx.model);
		},
		modelSelect: (event) => {
			clearSkillsAndSync(event.model);
		},
		turnStart: (_event, ctx) => {
			const cursorModel = isCursorModel(ctx.model);
			const runtime = resolveEffectiveRuntimeForSkillLifecycle(cursorModel, ctx);
			if (!cursorModel || runtime === "cloud") setCurrentSkills([]);
			syncCursorSkillToolForModel(ctx.model, runtime);
		},
		beforeAgentStart: (event, ctx) => {
			const cursorModel = isCursorModel(ctx.model);
			const runtime = resolveEffectiveRuntimeForSkillLifecycle(cursorModel, ctx);
			if (cursorModel && runtime === "local") {
				setCurrentSkills(selectCursorCatalogSkills(
					event.systemPromptOptions?.skills,
					cursorSkillScanPlan(event.systemPromptOptions),
				));
			} else {
				setCurrentSkills([]);
			}
			syncCursorSkillToolForModel(ctx.model, runtime);
			const resolved = resolveCursorSkillSystemPrompt(event.systemPrompt, ctx.model, event.systemPromptOptions, runtime);
			if (resolved === event.systemPrompt) return undefined;
			return { systemPrompt: resolved };
		},
	});
}
