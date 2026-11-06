import { lstatSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { escapeRegExp, isMissingPath } from "@dg/common";
import { withInstallLock } from "@dg/common/node";
import { type DgPaths, resolveDgPaths } from "@dg/common/node/dg-paths";
import {
	blockedText,
	ensureLayout,
	type LayoutResult,
	type MoveEntry,
	moveEntries,
	withCliLockError,
} from "@dg/common/node/layout";
import { folderUnused } from "@dg/common/node/sqlite-unused";
import { isCompatLauncher } from "./compat-launchers";
import { PROGRAMS } from "./shims";

type Table = readonly MoveEntry[];

export type CleanSeams = {
	readdir: (path: string) => string[];
	lstat: (path: string) => { isDirectory: () => boolean };
	removeTree: (path: string) => void;
	rmdir: (path: string) => void;
	log: (line: string) => void;
	unused: (path: string, dbName?: string) => boolean;
	ensure: (paths: DgPaths, hooks: { log: (line: string) => void }) => Promise<LayoutResult>;
	lock: <T>(root: string, fn: () => Promise<T>) => Promise<T>;
	platform: NodeJS.Platform;
};

export type CleanSnapshot = {
	readonly asides: Readonly<Record<string, { readonly live: string; readonly names: readonly string[] }>>;
	readonly unused: Readonly<Record<string, boolean>>;
	readonly bin: { readonly path: string; readonly names: readonly string[]; readonly others: readonly string[] } | undefined;
	readonly home: { readonly path: string; readonly kind: "directory" | "other"; readonly names: readonly string[] } | undefined;
	readonly platform: NodeJS.Platform;
};

export type CleanAction =
	| { kind: "removeAside"; path: string; name: string; dbName: string | undefined }
	| { kind: "keepAside"; path: string }
	| { kind: "removeBin"; path: string; launchers: readonly string[] }
	| { kind: "keepBin"; path: string; others: readonly string[] }
	| { kind: "removeLegacyHome"; path: string };

const defaultSeams: CleanSeams = {
	readdir: readdirSync,
	lstat: lstatSync,
	removeTree: (path) => rmSync(path, { recursive: true, force: true }),
	rmdir: rmdirSync,
	log: (line) => void process.stderr.write(`${line}\n`),
	unused: folderUnused,
	ensure: ensureLayout,
	lock: withCliLockError((root, fn) => withInstallLock(root, fn)),
	platform: process.platform,
};

const SET_ASIDE_SUFFIX = String.raw`\.empty-\d+$`;
const launcherFiles = (platform: NodeJS.Platform): string[] =>
	PROGRAMS.map((name) => (platform === "win32" ? `${name}.cmd` : name));
const joinNames = (items: readonly string[]): string =>
	items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
const asideEntries = (table: Table): MoveEntry[] => table.filter((entry) => entry.unused !== undefined);
const dbNameOf = ({ unused }: MoveEntry): string | undefined => (typeof unused === "object" ? unused.sqlite : undefined);

function orAbsent<T>(read: () => T): T | undefined {
	try {
		return read();
	} catch (error) {
		if (isMissingPath(error)) return undefined;
		throw error;
	}
}

function binAction(bin: CleanSnapshot["bin"], platform: NodeJS.Platform): CleanAction[] {
	if (!bin) return [];
	if (bin.others.length > 0) return [{ kind: "keepBin", path: bin.path, others: bin.others }];
	return [{ kind: "removeBin", path: bin.path, launchers: launcherFiles(platform).filter((file) => bin.names.includes(file)) }];
}

export function planClean(table: Table, snapshot: CleanSnapshot): CleanAction[] {
	const asides = asideEntries(table).flatMap((entry) =>
		(snapshot.asides[entry.name]?.names ?? []).map((name): CleanAction => {
			const path = join(dirname(snapshot.asides[entry.name]?.live ?? ""), name);
			return snapshot.unused[path] ? { kind: "removeAside", path, name: entry.name, dbName: dbNameOf(entry) } : { kind: "keepAside", path };
		}),
	);
	const bin = binAction(snapshot.bin, snapshot.platform);
	const binRemoved = bin.some((action) => action.kind === "removeBin");
	const remaining = snapshot.home?.names.filter((name) => !(binRemoved && name === "bin")) ?? [];
	const home: CleanAction[] =
		snapshot.home?.kind === "directory" && remaining.length === 0
			? [{ kind: "removeLegacyHome", path: snapshot.home.path }]
			: [];
	return [...asides, ...bin, ...home];
}

function refusalLines(result: LayoutResult): string[] {
	return Object.values(result).flatMap((outcome) => {
		if (outcome.kind === "blocked") return [blockedText(outcome)];
		if (outcome.kind === "kept" && outcome.reason === "copy-incomplete")
			return [`dg: kept ${outcome.from}; its copy at ${outcome.to} no longer holds every file`];
		return [];
	});
}

function takeSnapshot(table: Table, paths: DgPaths, seams: CleanSeams): CleanSnapshot {
	const entries = asideEntries(table);
	const lives = entries.map((entry) => ({ entry, live: entry.to(paths, { "ssms.configDir": () => "" }) }));
	const asides = Object.fromEntries(
		lives.map(({ entry, live }) => {
			const pattern = new RegExp(`^${escapeRegExp(basename(live))}${SET_ASIDE_SUFFIX}`);
			const names = (orAbsent(() => seams.readdir(dirname(live))) ?? []).filter((name) => pattern.test(name)).sort();
			return [entry.name, { live, names }];
		}),
	);
	const unused = Object.fromEntries(
		lives.flatMap(({ entry, live }) =>
			(asides[entry.name]?.names ?? []).map((name) => {
				const path = join(dirname(live), name);
				return [path, seams.unused(path, dbNameOf(entry))];
			}),
		),
	);
	const binPath = join(paths.legacyHome, "bin");
	const binNames = binPath === paths.binDir ? undefined : orAbsent(() => seams.readdir(binPath));
	const homeStat = orAbsent(() => seams.lstat(paths.legacyHome));
	const homeNames = homeStat ? (orAbsent(() => seams.readdir(paths.legacyHome)) ?? []) : [];
	return {
		asides,
		unused,
		bin: binNames && { path: binPath, names: binNames, others: keptBinNames(binNames, paths, seams) },
		home: homeStat && { path: paths.legacyHome, kind: homeStat.isDirectory() ? "directory" : "other", names: homeNames },
		platform: seams.platform,
	};
}

type Tally = { removed: number; failed: number; binKept: boolean };

function removeWith(path: string, remove: (path: string) => void, log: CleanSeams["log"]): boolean {
	try {
		remove(path);
		log(`dg: removed ${path}`);
		return true;
	} catch (error) {
		log(`dg: kept ${path}; removing it failed: ${error instanceof Error ? error.message : String(error)}`);
		return false;
	}
}

type ApplyArgs = { action: CleanAction; tally: Tally; paths: DgPaths; seams: CleanSeams };

function keptBinNames(names: readonly string[], paths: DgPaths, seams: CleanSeams): string[] {
	const launchers = new Set(launcherFiles(seams.platform));
	return names.filter((name) => !launchers.has(name) || !isCompatLauncher(paths, name, seams.platform));
}

async function applyAction({ action, tally, paths, seams }: ApplyArgs): Promise<Tally> {
	const { log } = seams;
	const done = (ok: boolean, binKept = tally.binKept): Tally => ({
		removed: tally.removed + (ok ? 1 : 0),
		failed: tally.failed + (ok ? 0 : 1),
		binKept,
	});
	switch (action.kind) {
		case "removeAside":
			if (!seams.unused(action.path, action.dbName)) {
				return applyAction({ action: { kind: "keepAside", path: action.path }, tally, paths, seams });
			}
			return done(removeWith(action.path, seams.removeTree, log));
		case "keepAside":
			log(`dg: kept ${action.path}; it holds data`);
			return tally;
		case "keepBin":
			log(`dg: kept ${action.path}; it holds files that are not dg launchers with a replacement: ${action.others.join(", ")}`);
			return { ...tally, binKept: true };
		case "removeBin": {
			const others = keptBinNames(orAbsent(() => seams.readdir(action.path)) ?? [], paths, seams);
			if (others.length > 0) {
				return applyAction({ action: { kind: "keepBin", path: action.path, others }, tally, paths, seams });
			}
			const ok = removeWith(action.path, seams.removeTree, log);
			if (ok && action.launchers.length > 0) {
				const stopped = joinNames(action.launchers.map((file) => `~/.dg/bin/${file}`));
				log(`dg: ${stopped} stop${action.launchers.length === 1 ? "s" : ""} working; the launchers are in ${paths.binDir}`);
			}
			return done(ok, !ok);
		}
		case "removeLegacyHome":
			return tally.binKept ? tally : done(removeWith(action.path, seams.rmdir, log));
	}
}

function applyAll(plan: readonly CleanAction[], paths: DgPaths, seams: CleanSeams): Promise<Tally> {
	const initial: Tally = { removed: 0, failed: 0, binKept: false };
	return plan.reduce(
		async (acc, action) => applyAction({ action, tally: await acc, paths, seams }),
		Promise.resolve(initial),
	);
}

/** Paths that `dg-skills clean` would remove now; reads only. */
export function pendingCleanPaths(paths: DgPaths = resolveDgPaths(), overrides: Partial<CleanSeams> = {}): string[] {
	const seams: CleanSeams = { ...defaultSeams, ...overrides };
	return planClean(moveEntries, takeSnapshot(moveEntries, paths, seams)).flatMap((action) =>
		action.kind.startsWith("remove") ? [action.path] : [],
	);
}

export async function runClean(paths: DgPaths = resolveDgPaths(), overrides: Partial<CleanSeams> = {}): Promise<number> {
	const seams: CleanSeams = { ...defaultSeams, ...overrides };
	const refusals = refusalLines(await seams.ensure(paths, { log: seams.log }));
	if (refusals.length > 0) {
		for (const line of refusals) seams.log(line);
		seams.log("dg: cleaned nothing; fix the lines above, then run dg-skills clean again");
		return 1;
	}
	const { plan, tally } = await seams.lock(paths.dataDir, async () => {
		const plan = planClean(moveEntries, takeSnapshot(moveEntries, paths, seams));
		return { plan, tally: await applyAll(plan, paths, seams) };
	});
	seams.log(plan.some((action) => action.kind.startsWith("remove")) ? `dg: removed ${tally.removed} path(s)` : "dg: nothing to clean");
	return tally.failed === 0 ? 0 : 1;
}
