import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface SkillAssetOptions {
	skillsRoot?: string;
	configuredSkillsRoot?: string;
	sourceSkillsRoot?: string;
}

function virtual(path: string): boolean {
	return /(?:^|\/)(?:\$bunfs|~BUN)(?:\/|$)/i.test(path.replaceAll("\\", "/"));
}

function inside(child: string, parent: string): boolean {
	const path = relative(parent, child);
	return (
		path === "" ||
		(!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
	);
}

function sourceRoots(): string[] {
	const entry = Bun.main || process.argv[1];
	if (!entry || virtual(entry)) return [];
	const roots: string[] = [];
	if (!existsSync(entry)) return [];
	let directory = dirname(realpathSync(entry));
	while (true) {
		roots.push(
			join(directory, "skills"),
			join(directory, "plugins", "dg", "skills"),
		);
		const parent = dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	return roots;
}

export function resolveSkillAsset(
	skill: string,
	relativePath: string,
	opts: SkillAssetOptions = {},
): string {
	if (!skill || skill === "." || skill === ".." || /[/\\\0]/.test(skill))
		throw new Error(`Invalid skill name: ${skill}`);
	if (
		isAbsolute(relativePath) ||
		relativePath.includes("\0") ||
		relativePath.split(/[/\\]/).includes("..")
	) {
		throw new Error(
			`Skill asset path must stay inside ${skill}: ${relativePath}`,
		);
	}
	const configured =
		opts.configuredSkillsRoot ??
		process.env.DG_SKILLS_DIR ??
		process.env.DG_SKILLS_DEST;
	const selected = opts.skillsRoot ?? configured ?? opts.sourceSkillsRoot;
	const roots = selected
		? [selected]
		: [
				join(
					process.env.DG_HOME ?? join(process.env.HOME ?? homedir(), ".dg"),
					"skills",
				),
				...[
					process.env.CLAUDE_PLUGIN_ROOT,
					process.env.CODEX_PLUGIN_ROOT,
					process.env.DG_PLUGIN_ROOT,
				]
					.filter((p): p is string => !!p)
					.flatMap((p) => [
						join(p, "skills"),
						join(p, "plugins", "dg", "skills"),
					]),
				...sourceRoots(),
			];
	for (const root of roots) {
		if (virtual(root))
			throw new Error(
				`Installed skill assets need a real filesystem path, received ${root}`,
			);
		const directory = resolve(root, skill);
		const candidate = resolve(directory, relativePath);
		if (!inside(candidate, directory))
			throw new Error(`Skill asset escapes ${skill}: ${relativePath}`);
		if (!existsSync(candidate)) continue;
		const realDirectory = realpathSync(directory);
		const realCandidate = realpathSync(candidate);
		if (virtual(realCandidate) || !inside(realCandidate, realDirectory))
			throw new Error(`Skill asset escapes ${skill}: ${relativePath}`);
		return realCandidate;
	}
	throw new Error(
		`Skill asset not found: ${skill}/${relativePath}. Install the dg skills or set DG_SKILLS_DIR to the installed skills directory (searched ${roots.join(", ")}).`,
	);
}
