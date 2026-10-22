import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

function inside(child: string, parent: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/** Walk up from `startDir` looking for a source checkout's `plugins/dg` (the one holding
 * `.claude-plugin/plugin.json`); returns its absolute path, or undefined outside a checkout. */
export function findSourceCheckoutPluginRoot(startDir: string = process.cwd()): string | undefined {
	let dir = resolve(startDir);
	while (true) {
		const candidate = join(dir, "plugins", "dg");
		if (existsSync(join(candidate, ".claude-plugin", "plugin.json"))) return candidate;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/** Refuses any path inside the installed plugin cache (`~/.claude/plugins/cache`) — canonical
 * plugin maintenance only ever writes into a source checkout, never a runtime install. */
export function assertNotInstalledCache(path: string, home: string = homedir()): void {
	const cache = join(home, ".claude", "plugins", "cache");
	if (inside(resolve(path), resolve(cache))) {
		throw new Error(`refusing to write inside the installed plugin cache: ${path}`);
	}
}

/** Refuses a destination that is the same directory as (or nested inside/around) its own source —
 * a plain copy there would read and write the same files. */
export function assertNotSelfMove(sourceDir: string, destDir: string): void {
	const src = resolve(sourceDir);
	const dest = resolve(destDir);
	if (src === dest || inside(dest, src) || inside(src, dest)) {
		throw new Error(`refusing to copy "${sourceDir}" onto itself at "${destDir}"`);
	}
}
