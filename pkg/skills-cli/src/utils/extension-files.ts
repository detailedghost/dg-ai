import {
	copyFileSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
} from "node:fs";
import { join } from "node:path";

export const LEGACY_EXTENSION_NAME = "dg-ai-browser-batch";
const LEGACY_DIR_NAMES = [
	"browser-batch-extension",
	"dg-ai-browser-batch-chrome",
	"dg-ai-browser-batch-firefox",
] as const;

interface SyncDeps {
	rename(from: string, to: string): void;
}

function isDirectory(path: string): boolean {
	try {
		return lstatSync(path).isDirectory();
	} catch {
		return false;
	}
}

function entryKind(path: string): "dir" | "file" | undefined {
	try {
		return lstatSync(path).isDirectory() ? "dir" : "file";
	} catch {
		return undefined;
	}
}

/** Chrome unloads an unpacked extension whose folder disappears, so the folder is kept and only its files change. */
export function syncDirInPlace(
	src: string,
	dest: string,
	deps: SyncDeps = { rename: renameSync },
): void {
	mkdirSync(dest, { recursive: true });
	for (const name of readdirSync(src)) {
		const from = join(src, name);
		const to = join(dest, name);
		const kind = entryKind(from);
		const existing = entryKind(to);
		if (kind === "dir") {
			if (existing === "file") rmSync(to, { force: true });
			syncDirInPlace(from, to, deps);
			continue;
		}
		if (existing === "dir") rmSync(to, { recursive: true, force: true });
		const temporary = join(dest, `.${name}.${process.pid}.tmp`);
		try {
			copyFileSync(from, temporary);
			deps.rename(temporary, to);
		} catch (error) {
			rmSync(temporary, { force: true });
			throw error;
		}
	}
	const wanted = new Set(readdirSync(src));
	for (const name of readdirSync(dest)) {
		if (!wanted.has(name)) rmSync(join(dest, name), { recursive: true, force: true });
	}
}

function isLegacyExtension(dir: string): boolean {
	if (!isDirectory(dir)) return false;
	try {
		const manifest: unknown = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
		return (manifest as { name?: unknown } | null)?.name === LEGACY_EXTENSION_NAME;
	} catch {
		return false;
	}
}

/** Legacy folders under each `.dg` directory whose manifest names the retired batch extension. */
export function legacyExtensionDirs(dgDirs: readonly string[]): string[] {
	return dgDirs.flatMap((dgDir) =>
		LEGACY_DIR_NAMES.map((name) => join(dgDir, name)).filter(isLegacyExtension),
	);
}

export function removeLegacyExtensions(dgDirs: readonly string[]): string[] {
	const found = legacyExtensionDirs(dgDirs);
	for (const dir of found) rmSync(dir, { recursive: true, force: true });
	return found;
}
