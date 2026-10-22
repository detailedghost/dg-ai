import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { resolveSkillsRoot } from "../utils/skill-assets";
import type { SyncContext } from "./types";

/** `~/.claude/skills`, overridable by `SKILLS_SRC` (legacy env name, kept for parity). */
export function resolveClaudeSkillsRoot(ctx: SyncContext): string {
	return ctx.env.SKILLS_SRC || join(ctx.home, ".claude", "skills");
}

/** `~/.claude/agents`, overridable by `AGENTS_SRC` (legacy env name, kept for parity). */
export function resolveClaudeAgentsRoot(ctx: SyncContext): string {
	return ctx.env.AGENTS_SRC || join(ctx.home, ".claude", "agents");
}

/** The dg plugin's skills directory: an explicit `DG_SKILLS_DIR` override, else installed/dev discovery. */
export function resolvePluginSkillsRoot(ctx: SyncContext): string | null {
	if (ctx.env.DG_SKILLS_DIR) return ctx.env.DG_SKILLS_DIR;
	return resolveSkillsRoot();
}

/** The dg plugin's agents directory, sibling to its skills directory. */
export function resolvePluginAgentsRoot(ctx: SyncContext): string | null {
	const skills = resolvePluginSkillsRoot(ctx);
	if (!skills) return null;
	const agents = join(skills, "..", "agents");
	return existsSync(agents) ? agents : null;
}

export interface NamedSource {
	name: string;
	dir: string;
	origin: "plugin" | "local";
}

/** Immediate child directory names that contain the given manifest file. */
function namedEntries(root: string | null, manifest: string): string[] {
	if (!root || !existsSync(root)) return [];
	try {
		return readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, manifest)))
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
}

/**
 * Merge plugin and local skill directories by name. A name present in both wins from the
 * plugin side; the local copy is reported as shadowed but never deleted (plan.md: "plugin
 * wins duplicate names with an explicit warning; do not delete local source skills").
 */
export function mergeSkillSources(pluginRoot: string | null, localRoot: string | null): {
	sources: NamedSource[];
	shadowed: string[];
} {
	const pluginNames = new Set(namedEntries(pluginRoot, "SKILL.md"));
	const localNames = namedEntries(localRoot, "SKILL.md");
	const shadowed: string[] = [];
	const sources: NamedSource[] = [...pluginNames].map((name) => ({
		name,
		dir: join(pluginRoot as string, name),
		origin: "plugin" as const,
	}));
	for (const name of localNames) {
		if (pluginNames.has(name)) {
			shadowed.push(name);
			continue;
		}
		sources.push({ name, dir: join(localRoot as string, name), origin: "local" });
	}
	sources.sort((a, b) => a.name.localeCompare(b.name));
	return { sources, shadowed };
}

/** Same merge rule for agent markdown files, keyed by filename stem. */
export function mergeAgentSources(pluginRoot: string | null, localRoot: string | null): {
	sources: NamedSource[];
	shadowed: string[];
} {
	const listMd = (root: string | null): string[] => {
		if (!root || !existsSync(root)) return [];
		try {
			return readdirSync(root, { withFileTypes: true })
				.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
				.map((entry) => entry.name.slice(0, -3))
				.sort();
		} catch {
			return [];
		}
	};
	const pluginNames = new Set(listMd(pluginRoot));
	const localNames = listMd(localRoot);
	const shadowed: string[] = [];
	const sources: NamedSource[] = [...pluginNames].map((name) => ({
		name,
		dir: join(pluginRoot as string, `${name}.md`),
		origin: "plugin" as const,
	}));
	for (const name of localNames) {
		if (pluginNames.has(name)) {
			shadowed.push(name);
			continue;
		}
		sources.push({ name, dir: join(localRoot as string, `${name}.md`), origin: "local" });
	}
	sources.sort((a, b) => a.name.localeCompare(b.name));
	return { sources, shadowed };
}
