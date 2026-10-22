/** `dg-skills sync grok` — materializes dg-plugin-only skills into a root Grok's native `~/.claude/skills` scan can't see. */

import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pruneStale, readManifest } from "./manifest";
import {
	mergeSkillSources,
	resolveClaudeSkillsRoot,
	resolvePluginSkillsRoot,
} from "./roots";
import type { NamedSource } from "./roots";
import { rewriteScratchPaths } from "./scratch-rewrite";
import { copyTree, rewriteTreeScratchPaths } from "./tree-copy";
import type { SyncContext, SyncTarget } from "./types";
import { SyncReport } from "./types";

export type GrokFlags = Record<string, never>;

const NATIVE_COMPAT_LINE =
	"agents, rules, mcp, and hooks are natively compatible via Grok's [compat.claude] cells (default on) and are not synced by this target; only skills get a sync step.";

function paths(ctx: SyncContext) {
	const userSkillsRoot = ctx.env.GROK_SKILLS_DIR || join(ctx.home, ".grok", "skills");
	return {
		userSkillsRoot,
		projectSkillsRoot: join(ctx.cwd, ".grok", "skills"),
		projectDgDir: join(ctx.cwd, ".grok"),
		grokHomeDir: join(ctx.home, ".grok"),
		configPath: join(ctx.home, ".grok", "config.toml"),
	};
}

function manifestPath(root: string): string {
	return join(root, ".dg-sync-skills");
}

function mergedSkills(ctx: SyncContext) {
	const pluginRoot = resolvePluginSkillsRoot(ctx);
	const localRoot = resolveClaudeSkillsRoot(ctx);
	return mergeSkillSources(pluginRoot, existsSync(localRoot) ? localRoot : null);
}

function parseBool(value: string): boolean {
	return !(value === "false" || value === "0");
}

interface CompatStatus {
	enabled: boolean;
	reason: string;
}

/** `env var > ~/.grok/config.toml [compat.claude] skills cell > default (on)`. */
function resolveClaudeCompatSkills(ctx: SyncContext): CompatStatus {
	const envValue = ctx.env.GROK_CLAUDE_SKILLS_ENABLED;
	if (envValue !== undefined) return { enabled: parseBool(envValue), reason: "GROK_CLAUDE_SKILLS_ENABLED env var" };

	const configPath = paths(ctx).configPath;
	if (!existsSync(configPath)) return { enabled: true, reason: "no ~/.grok/config.toml (default on)" };
	let text: string;
	try {
		text = readFileSync(configPath, "utf8");
	} catch {
		return { enabled: true, reason: "~/.grok/config.toml unreadable (default on)" };
	}

	const lines = text.split("\n");
	const sectionStart = lines.findIndex((line) => /^\s*\[compat\.claude]\s*(#.*)?$/.test(line));
	if (sectionStart === -1) return { enabled: true, reason: "no [compat.claude] section (default on)" };
	for (let i = sectionStart + 1; i < lines.length; i++) {
		const line = lines[i];
		if (/^\s*\[/.test(line)) break;
		if (/^\s*skills\s*=\s*false\b/.test(line)) return { enabled: false, reason: "[compat.claude] skills = false in config.toml" };
	}
	return { enabled: true, reason: "[compat.claude] present without skills = false (default on)" };
}

/** When compat is enabled, Grok already sees local-origin skills natively; only plugin-origin ones need materializing. */
function selectSources(sources: NamedSource[], compatEnabled: boolean): NamedSource[] {
	return compatEnabled ? sources.filter((s) => s.origin === "plugin") : sources;
}

function applyToRoot(root: string, sources: NamedSource[], env: NodeJS.ProcessEnv, report: SyncReport, label: string): void {
	mkdirSync(root, { recursive: true });
	const kept: string[] = [];
	for (const source of sources) {
		const destDir = join(root, source.name);
		copyTree(source.dir, destDir);
		rewriteTreeScratchPaths(destDir, env);
		kept.push(source.name);
	}
	const { pruned } = pruneStale(root, "", manifestPath(root), kept);
	for (const name of pruned) report.info(`pruned stale skill from ${label} root: ${name}`);
	report.info(`copied ${kept.length} skill(s) into ${root} (${label} root, with scratch-path rewrites)`);
}

function isProbablyText(buf: Buffer): boolean {
	return !buf.includes(0);
}

function walkFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walkFiles(full));
		else if (entry.isFile()) out.push(full);
	}
	return out;
}

/** Sanity-check only the names this sync manages (per the root's manifest), never a hand-placed directory. */
function verifyRoot(root: string, label: string, report: SyncReport, env: NodeJS.ProcessEnv): void {
	if (!existsSync(root)) return;
	for (const name of readManifest(manifestPath(root))) {
		const skillDir = join(root, name);
		const skillMd = join(skillDir, "SKILL.md");
		if (!existsSync(skillDir)) {
			report.fail(`manifest lists '${name}' in the ${label} root but its skill directory is missing: ${skillDir}`);
			continue;
		}
		if (!existsSync(skillMd)) {
			report.fail(`skill '${name}' in the ${label} root is missing SKILL.md: ${skillMd}`);
			continue;
		}
		const raw = readFileSync(skillMd, "utf8");
		if (!/^---\n[\s\S]*?\n---/.test(raw)) {
			report.fail(`skill '${name}' in the ${label} root has no '---'-delimited frontmatter: ${skillMd}`);
		}
		for (const file of walkFiles(skillDir)) {
			const buf = readFileSync(file);
			if (!isProbablyText(buf)) continue;
			const text = buf.toString("utf8");
			if (rewriteScratchPaths(text, env) !== text) {
				report.fail(`skill '${name}' in the ${label} root still contains a stale scratch/state literal: ${file}`);
			}
		}
	}
}

async function probeOrDryRun(ctx: SyncContext, dry: boolean): Promise<SyncReport> {
	const report = new SyncReport();
	const p = paths(ctx);
	const { sources, shadowed } = mergedSkills(ctx);
	const compat = resolveClaudeCompatSkills(ctx);
	const selected = selectSources(sources, compat.enabled);
	const projectApplies = existsSync(p.projectDgDir);
	const grokInstalled = existsSync(p.grokHomeDir);

	report.info("== dg-skills sync grok probe ==");
	report.info(
		grokInstalled
			? "Grok home directory found; using pinned skill root"
			: "Grok home directory not found; using pinned default root and proceeding anyway",
	);
	report.info(`claudeCompatSkillsEnabled: ${compat.enabled} (${compat.reason})`);
	report.info(NATIVE_COMPAT_LINE);
	report.info(`skills: ${sources.length} merged source(s) (${shadowed.length} shadowed by the plugin)`);
	for (const name of shadowed) {
		report.warn(`plugin skill '${name}' shadows a local copy under the Claude skills directory; local copy left untouched`);
	}
	report.info(
		compat.enabled
			? `compat enabled: materializing only the ${selected.length} plugin-origin skill(s) Grok's native ~/.claude/skills scan cannot see`
			: `compat disabled: materializing all ${selected.length} merged skill(s), since Grok cannot see any ~/.claude/skills natively`,
	);
	report.info(`user skills root: ${p.userSkillsRoot}`);
	report.info(
		projectApplies
			? `project skills root: ${p.projectSkillsRoot} (.grok exists at cwd; will be synced)`
			: `project skills root: ${p.projectSkillsRoot} (.grok not found at cwd; not written by sync)`,
	);

	if (dry) {
		report.info("");
		report.info("Planned operations (dry-run):");
		report.info(`  - Copy ${selected.length} skill(s) into ${p.userSkillsRoot} (with scratch-path rewrites)`);
		if (projectApplies) report.info(`  - Copy ${selected.length} skill(s) into ${p.projectSkillsRoot} (with scratch-path rewrites)`);
		report.info("  - Prune any previously-synced skill no longer selected, per root");
	}
	return report;
}

async function apply(ctx: SyncContext): Promise<SyncReport> {
	const report = new SyncReport();
	const p = paths(ctx);
	const projectApplies = existsSync(p.projectDgDir);
	const { sources, shadowed } = mergedSkills(ctx);
	const compat = resolveClaudeCompatSkills(ctx);
	const selected = selectSources(sources, compat.enabled);

	for (const name of shadowed) {
		report.warn(`plugin skill '${name}' shadows a local copy under the Claude skills directory; local copy left untouched`);
	}
	report.info(`claudeCompatSkillsEnabled: ${compat.enabled} (${compat.reason})`);
	report.info(
		compat.enabled
			? `compat enabled: copying only the ${selected.length} plugin-origin skill(s)`
			: `compat disabled: copying all ${selected.length} merged skill(s)`,
	);

	applyToRoot(p.userSkillsRoot, selected, ctx.env, report, "user");
	if (projectApplies) {
		applyToRoot(p.projectSkillsRoot, selected, ctx.env, report, "project");
	} else {
		report.info(`project skills root ${p.projectSkillsRoot} skipped: no .grok directory at ${ctx.cwd}`);
	}

	const verifyReport = await verify(ctx);
	report.merge(verifyReport);
	return report;
}

async function verify(ctx: SyncContext): Promise<SyncReport> {
	const report = new SyncReport();
	const p = paths(ctx);
	verifyRoot(p.userSkillsRoot, "user", report, ctx.env);
	if (existsSync(p.projectSkillsRoot)) verifyRoot(p.projectSkillsRoot, "project", report, ctx.env);
	if (report.ok) report.info("Verification OK");
	else report.info(`Verification failed with ${report.warnings.length} issue(s)`);
	return report;
}

export const grokTarget: SyncTarget<GrokFlags> = {
	id: "grok",
	usage: "sync grok <probe|dry-run|apply|verify>",
	parseFlags(argv) {
		if (argv.length > 0) return { error: `unknown option: ${argv[0]}` };
		return { flags: {} };
	},
	probe: (ctx) => probeOrDryRun(ctx, false),
	dryRun: (ctx) => probeOrDryRun(ctx, true),
	apply: (ctx) => apply(ctx),
	verify: (ctx) => verify(ctx),
};
