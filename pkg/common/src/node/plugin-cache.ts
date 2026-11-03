import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compareSemver } from "./plugin-skills";

const SEMVER = /^\d+\.\d+\.\d+$/;
const MEGABYTE = 1024 * 1024;
const HOUR_MS = 60 * 60 * 1000;

export const READ_WINDOW_MS = 24 * HOUR_MS;

export type PluginCacheVersion = {
	marketplace: string;
	version: string;
	path: string;
	bytes: number;
	orphanedAt?: number;
	lastReadAt?: number;
	livePids: number[];
	inUseUnreadable: boolean;
};

export type PrunePlan = {
	keep: { version: PluginCacheVersion; reason: string }[];
	remove: PluginCacheVersion[];
};

export type CacheFs = {
	dirs(path: string): string[];
	files(path: string): string[] | undefined;
	dirMtime(path: string): number | undefined;
	mtime(path: string): number;
	treeBytes(path: string): number;
	readNumber(path: string): number | undefined;
	readJson<T>(path: string): T | undefined;
	alive(pid: number, procStart?: string): boolean;
};

function lstatOrUndefined(path: string) {
	try {
		return lstatSync(path);
	} catch {
		return undefined;
	}
}

const isRealDir = (path: string): boolean => lstatOrUndefined(path)?.isDirectory() === true;

function missing(path: string): boolean {
	try {
		lstatSync(path);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT";
	}
}

/** [] when the path is absent; undefined when it exists but is not a readable real directory. */
function entries(path: string, want: "dir" | "file"): string[] | undefined {
	if (missing(path)) return [];
	if (!isRealDir(path)) return undefined;
	try {
		return readdirSync(path, { withFileTypes: true })
			.filter((entry) => (want === "dir" ? entry.isDirectory() : entry.isFile()))
			.map((entry) => entry.name);
	} catch {
		return undefined;
	}
}

function readText(path: string): string | undefined {
	if (lstatOrUndefined(path)?.isFile() !== true) return undefined;
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

function treeBytes(path: string): number {
	const stat = lstatOrUndefined(path);
	if (!stat) return 0;
	if (!stat.isDirectory()) return stat.size;
	try {
		return readdirSync(path)
			.map((name) => treeBytes(join(path, name)))
			.reduce((sum, bytes) => sum + bytes, 0);
	} catch {
		return 0;
	}
}

const STAT_START_TIME_INDEX = 19;

function readProcStat(pid: number): string {
	return readFileSync(`/proc/${pid}/stat`, "utf8");
}

/** True when `pid` exists; with `procStart` it must also match field 22 of /proc/<pid>/stat when that is readable. */
export function pidAlive(
	pid: number,
	procStart?: string,
	readStat: (pid: number) => string = readProcStat,
): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
	}
	if (procStart === undefined) return true;
	try {
		const stat = readStat(pid);
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		return fields[STAT_START_TIME_INDEX] === procStart;
	} catch {
		return true;
	}
}

export const realFs: CacheFs = {
	dirs: (path) => entries(path, "dir") ?? [],
	files: (path) => entries(path, "file"),
	dirMtime: (path) => (isRealDir(path) ? lstatOrUndefined(path)?.mtimeMs : undefined),
	mtime: (path) => lstatOrUndefined(path)?.mtimeMs ?? 0,
	treeBytes,
	readNumber(path) {
		const text = readText(path)?.trim();
		const value = Number(text);
		return text && Number.isFinite(value) ? value : undefined;
	},
	readJson<T>(path: string): T | undefined {
		const text = readText(path);
		if (text === undefined) return undefined;
		try {
			return JSON.parse(text) as T;
		} catch {
			return undefined;
		}
	},
	alive: pidAlive,
};

const cacheRoot = (home: string): string => join(home, ".claude", "plugins", "cache");

type UsageState = Pick<PluginCacheVersion, "orphanedAt" | "lastReadAt" | "livePids" | "inUseUnreadable">;

const validPid = (pid: unknown): pid is number => Number.isInteger(pid) && (pid as number) > 0;

function readUsage(path: string, fs: CacheFs): UsageState {
	const inUseDir = join(path, ".in_use");
	const markers = fs.files(inUseDir);
	const names = markers ?? [];
	const bodies = names.map((name) => fs.readJson<{ pid?: unknown; procStart?: unknown }>(join(inUseDir, name)));
	const readTimes = [fs.dirMtime(inUseDir), ...names.map((name) => fs.mtime(join(inUseDir, name)))].filter(
		(time): time is number => time !== undefined,
	);
	const livePids = bodies.flatMap((body) => {
		if (!validPid(body?.pid)) return [];
		const procStart = typeof body.procStart === "string" ? body.procStart : undefined;
		return fs.alive(body.pid, procStart) ? [body.pid] : [];
	});
	return {
		orphanedAt: fs.readNumber(join(path, ".orphaned_at")),
		lastReadAt: readTimes.length ? Math.max(...readTimes) : undefined,
		livePids,
		inUseUnreadable: markers === undefined || bodies.some((body) => !validPid(body?.pid)),
	};
}

/** Real version directories at <home>/.claude/plugins/cache/<marketplace>/dg/<semver>; symlinks are never followed. */
export function listDgPluginVersions(home: string, fs: CacheFs = realFs): PluginCacheVersion[] {
	const cache = cacheRoot(home);
	return fs.dirs(cache).flatMap((marketplace) =>
		fs
			.dirs(join(cache, marketplace, "dg"))
			.filter((version) => SEMVER.test(version))
			.sort(compareSemver)
			.map((version) => {
				const path = join(cache, marketplace, "dg", version);
				return { marketplace, version, path, bytes: fs.treeBytes(path), ...readUsage(path, fs) };
			}),
	);
}

/** Re-reads one version's usage state without re-measuring its size. */
export function reinspectPluginVersion(version: PluginCacheVersion, fs: CacheFs = realFs): PluginCacheVersion {
	return { ...version, ...readUsage(version.path, fs) };
}

/** installed_plugins.json: "dg@<marketplace>" -> every installed version. A missing, malformed or uninterpretable file -> undefined, and the caller removes nothing. */
export function activeVersions(home: string, fs: CacheFs = realFs): Map<string, string[]> | undefined {
	const parsed = fs.readJson<{ plugins?: unknown }>(
		join(home, ".claude", "plugins", "installed_plugins.json"),
	);
	const plugins = parsed?.plugins;
	if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) return undefined;
	const active = new Map<string, string[]>();
	for (const [key, installs] of Object.entries(plugins)) {
		const [plugin, marketplace] = key.split("@");
		if (plugin !== "dg" || !marketplace) continue;
		if (!Array.isArray(installs)) return undefined;
		const versions = installs.map((install: { version?: unknown } | null) => install?.version);
		if (!versions.every((version): version is string => typeof version === "string")) return undefined;
		active.set(marketplace, versions);
	}
	return active;
}

const hoursAgo = (now: number, at: number): number => Math.floor((now - at) / HOUR_MS);

/** Removes only orphaned versions that are neither active, read inside the window, nor held by a live pid. */
export function planPluginCachePrune(
	versions: PluginCacheVersion[],
	active: Map<string, string[]>,
	now: number,
	readWindowMs = READ_WINDOW_MS,
): PrunePlan {
	const plan: PrunePlan = { keep: [], remove: [] };
	for (const v of versions) {
		if (active.get(v.marketplace)?.includes(v.version)) {
			plan.keep.push({ version: v, reason: "active" });
		} else if (v.livePids.length > 0) {
			plan.keep.push({ version: v, reason: `in use by pid ${v.livePids[0]}` });
		} else if (v.lastReadAt !== undefined && now - v.lastReadAt < readWindowMs) {
			plan.keep.push({ version: v, reason: `read ${hoursAgo(now, v.lastReadAt)}h ago` });
		} else if (v.inUseUnreadable) {
			plan.keep.push({ version: v, reason: "in-use state unreadable" });
		} else if (v.orphanedAt === undefined) {
			plan.keep.push({ version: v, reason: "unknown state" });
		} else {
			plan.remove.push(v);
		}
	}
	return plan;
}

export const formatMegabytes = (bytes: number): string => `${Math.round(bytes / MEGABYTE)} MB`;
