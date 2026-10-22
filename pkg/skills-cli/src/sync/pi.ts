/** `dg-skills sync pi` — mirrors Claude-authored skills, verbatim, into Pi's native skill roots. */

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

export type PiFlags = Record<string, never>;

const UNSUPPORTED_LINE = "unsupported: agents, hooks, mcp, statusline (skills only)";

function paths(ctx: SyncContext) {
	const userSkillsRoot = ctx.env.PI_SKILLS_DIR || join(ctx.home, ".pi", "agent", "skills");
	return {
		userSkillsRoot,
		projectSkillsRoot: join(ctx.cwd, ".pi", "skills"),
		projectDgDir: join(ctx.cwd, ".pi"),
		piAgentDir: join(ctx.home, ".pi", "agent"),
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
	const projectApplies = existsSync(p.projectDgDir);
	const agentDirFound = existsSync(p.piAgentDir);

	report.info("== dg-skills sync pi probe ==");
	report.info(
		agentDirFound
			? "Pi agent directory found; using pinned skill root"
			: "Pi agent directory not found; using pinned default root and proceeding anyway",
	);
	report.info(`skills: ${sources.length} source(s) (${shadowed.length} shadowed by the plugin)`);
	for (const name of shadowed) {
		report.warn(`plugin skill '${name}' shadows a local copy under the Claude skills directory; local copy left untouched`);
	}
	report.info(`user skills root: ${p.userSkillsRoot}`);
	report.info(
		projectApplies
			? `project skills root: ${p.projectSkillsRoot} (.pi exists at cwd; will be synced)`
			: `project skills root: ${p.projectSkillsRoot} (.pi not found at cwd; not written by sync)`,
	);
	report.info(UNSUPPORTED_LINE);

	if (dry) {
		report.info("");
		report.info("Planned operations (dry-run):");
		report.info(`  - Copy ${sources.length} skill(s) into ${p.userSkillsRoot} (with scratch-path rewrites)`);
		if (projectApplies) report.info(`  - Copy ${sources.length} skill(s) into ${p.projectSkillsRoot} (with scratch-path rewrites)`);
		report.info("  - Prune any previously-synced skill no longer present in the merged source set, per root");
	}
	return report;
}

async function apply(ctx: SyncContext): Promise<SyncReport> {
	const report = new SyncReport();
	const p = paths(ctx);
	const projectApplies = existsSync(p.projectDgDir);
	const { sources, shadowed } = mergedSkills(ctx);

	for (const name of shadowed) {
		report.warn(`plugin skill '${name}' shadows a local copy under the Claude skills directory; local copy left untouched`);
	}

	applyToRoot(p.userSkillsRoot, sources, ctx.env, report, "user");
	if (projectApplies) {
		applyToRoot(p.projectSkillsRoot, sources, ctx.env, report, "project");
	} else {
		report.info(`project skills root ${p.projectSkillsRoot} skipped: no .pi directory at ${ctx.cwd}`);
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

export const piTarget: SyncTarget<PiFlags> = {
	id: "pi",
	usage: "sync pi <probe|dry-run|apply|verify>",
	parseFlags(argv) {
		if (argv.length > 0) return { error: `unknown option: ${argv[0]}` };
		return { flags: {} };
	},
	probe: (ctx) => probeOrDryRun(ctx, false),
	dryRun: (ctx) => probeOrDryRun(ctx, true),
	apply: (ctx) => apply(ctx),
	verify: (ctx) => verify(ctx),
};
