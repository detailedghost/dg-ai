/**
 * Which files a skills-only install copies.
 *
 * A skill is an immediate child directory of the skills root that contains
 * SKILL.md. Every regular file under that directory is an instruction file,
 * including references. The root README and any directory without SKILL.md
 * stay out. Paths are posix and relative to the skills root.
 */

const SKILL_MANIFEST = "SKILL.md";

function partsOf(path: string): string[] | undefined {
	if (path.startsWith("/") || path.includes("\\")) return undefined;
	const parts = path.split("/");
	if (parts.some((part) => part === "" || part === "." || part === "..")) {
		return undefined;
	}
	return parts;
}

/** Immediate skill directory names, from relative paths of files in the tree. */
export function skillDirectoryNames(relativePaths: readonly string[]): string[] {
	const names = new Set<string>();
	for (const path of relativePaths) {
		const parts = partsOf(path);
		if (parts?.length === 2 && parts[1] === SKILL_MANIFEST) names.add(parts[0]);
	}
	return [...names].sort();
}

/** Relative paths the installer writes. Duplicates collapse. Order is sorted. */
export function filesToInstall(relativePaths: readonly string[]): string[] {
	const skills = new Set(skillDirectoryNames(relativePaths));
	const selected = new Set<string>();
	for (const path of relativePaths) {
		const parts = partsOf(path);
		if (!parts || parts.length < 2) continue;
		if (!skills.has(parts[0])) continue;
		selected.add(path);
	}
	return [...selected].sort();
}
