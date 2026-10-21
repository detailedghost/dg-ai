import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** Names of real subdirectories; symlinks are skipped. */
export function realSubdirectories(path: string): string[] {
	try {
		return readdirSync(path, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return [];
	}
}

function compareSemver(a: string, b: string): number {
	const left = SEMVER.exec(a)?.slice(1).map(Number) ?? [];
	const right = SEMVER.exec(b)?.slice(1).map(Number) ?? [];
	return left.reduce((diff, part, i) => diff || part - right[i], 0);
}

/** Skills directory of the highest installed dg plugin version, one per marketplace. */
export function claudePluginSkillsDirs(
	homeDir: string,
	readdir: (path: string) => string[] = realSubdirectories,
	exists: (path: string) => boolean = existsSync,
): string[] {
	const cache = join(homeDir, ".claude", "plugins", "cache");
	return readdir(cache).flatMap((marketplace) => {
		const plugin = join(cache, marketplace, "dg");
		const newest = readdir(plugin)
			.filter((version) => SEMVER.test(version))
			.sort(compareSemver)
			.at(-1);
		if (!newest) return [];
		const skills = join(plugin, newest, "plugins", "dg", "skills");
		return exists(skills) ? [skills] : [];
	});
}
