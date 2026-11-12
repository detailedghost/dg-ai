import { lstatSync, readdirSync, readFileSync, type Stats } from "node:fs";
import { basename, join } from "node:path";
import { DgCliError, isMissingPath } from "../errors";
import { type DgPaths } from "./dg-paths";
import { withInstallLock } from "./install-lock";

export const PENDING_FILE = ".pending-removal.json";
export const DETACHED_PREFIX = ".removing-";

/** Written into the daemon folder when it moved over a set-aside target, until the keychain step runs. */
export const DAEMON_ASIDE_MARK = ".moved-over-set-aside";

export type StopResult = "stopped" | "still-running" | "refused";

type OwnerHooks = {
	"daemon.stop": (legacyDir: string) => Promise<StopResult>;
	"phone.stop": (legacyDir: string) => Promise<StopResult>;
	"phone.verify": (copy: string) => string[];
	"ssms.configDir": () => string;
};

export type HookKey = keyof OwnerHooks;

export type StopKey = "daemon.stop" | "phone.stop";

type LayoutWork = typeof import("./layout-work");

export type LayoutSeams = {
	readdir: (path: string) => string[];
	lstat: (path: string) => Stats;
	load: () => Promise<LayoutWork>;
	log: (line: string) => void;
	now: () => number;
	entryFile: () => string | undefined;
	execPath: () => string;
	lock: <T>(root: string, fn: () => Promise<T>) => Promise<T>;
};

export type LayoutHooks = Partial<Omit<LayoutSeams, "load">> &
	Partial<OwnerHooks> & { load?: () => Promise<LayoutWork | void>; launchers?: true };

export type MoveEntry = {
	name: string;
	from: string | readonly string[];
	to: (paths: DgPaths, hooks: Pick<OwnerHooks, "ssms.configDir">) => string;
	unused?: "folder" | { sqlite: string };
	live?: string;
	stop?: StopKey;
	verify?: "phone.verify";
	needsKey?: "ssms.configDir";
	launcherBound?: true;
	asideMark?: string;
};

type MarkerEntry = { name: string; from: string; marker: true };

export type LayoutEntry = MoveEntry | MarkerEntry;

const DAEMON = { live: "daemon/*.pid", stop: "daemon.stop" } as const;
const LAUNCHED = { launcherBound: true } as const;
const SSMS = { live: "ssms/*.pid" } as const;

export const LAYOUT_TABLE = [
	{ name: "runtime", from: "runtime", to: (paths) => paths.runtimeDir, ...LAUNCHED },
	{ name: "lib", from: "lib", to: (paths) => paths.libDir, ...LAUNCHED },
	{ name: "skills", from: "skills", to: (paths) => paths.skillsDir },
	{ name: "browsers", from: "browsers", to: (paths) => paths.browsersDir },
	{ name: "demo-narration", from: "demo-narration", to: (paths) => join(paths.dataDir, "demo-narration") },
	{ name: "sessions", from: "agents/sessions", to: (paths) => paths.sessionsDir, ...DAEMON },
	{ name: "assets", from: "agents/assets", to: (paths) => paths.assetsDir, ...DAEMON },
	{
		name: "memory",
		from: ["agents/memory.db", "agents/memory.db-wal", "agents/memory.db-shm"],
		to: (paths) => paths.agentsDir,
	},
	{ name: "personas", from: "agents", to: (paths) => paths.personasDir },
	{ name: "daemon-logs", from: "daemon/logs", to: (paths) => paths.logDir, ...DAEMON },
	{
		name: "daemon",
		from: "daemon",
		to: (paths) => paths.daemonDir,
		unused: "folder",
		asideMark: DAEMON_ASIDE_MARK,
		...DAEMON,
	},
	{ name: "grants", from: "grants", to: (paths) => paths.grantsDir },
	{
		name: "phone",
		from: "phone",
		to: (paths) => paths.phoneRoot,
		unused: { sqlite: "phone.db" },
		live: "phone/listener.pid",
		verify: "phone.verify",
		stop: "phone.stop",
	},
	{ name: "phone-friend", from: "phone-friend", to: (paths) => paths.phoneFriendRoot, live: "phone-friend/*/listener.pid" },
	{ name: "inbox", from: "inbox", to: (paths) => join(paths.stateDir, "inbox") },
	{ name: "browser-profiles", from: "browser-profiles", to: (paths) => join(paths.stateDir, "browser-profiles") },
	{ name: "demo-profile", from: "demo-profile", to: (paths) => join(paths.stateDir, "demo-profile") },
	{
		name: "channel-review-config",
		from: "channel-review/config.json",
		to: (paths) => join(paths.configDir, "channel-review", "config.json"),
		live: "channel-review/*.pid",
	},
	{
		name: "channel-review",
		from: "channel-review",
		to: (paths) => join(paths.stateDir, "channel-review"),
		unused: "folder",
		live: "channel-review/*.pid",
	},
	{
		name: "ssms-config",
		from: "ssms/config.yaml",
		to: (_paths, hooks) => join(hooks["ssms.configDir"](), "ssms", "config.yaml"),
		needsKey: "ssms.configDir",
		...SSMS,
	},
	{ name: "ssms", from: "ssms", to: (paths) => join(paths.stateDir, "ssms"), ...SSMS },
	{ name: "proto", from: "proto", to: (paths) => join(paths.cacheDir, "proto") },
	{ name: "demos", from: "demos", to: (paths) => join(paths.cacheDir, "demos") },
	{ name: "config", from: "config.json", to: (paths) => paths.configPath },
	{ name: "cli-only", from: "cli-only", to: (paths) => paths.cliOnlyMarker },
	{ name: "bin", from: "bin", marker: true },
] as const satisfies readonly LayoutEntry[];

export type EntryName = Extract<(typeof LAYOUT_TABLE)[number], { to: unknown }>["name"];

type Ends = { from: string; to: string };

type BlockReason = "live-writer" | "no-hook";

export type Outcome = Ends &
	(
		| { kind: "moved"; stopped: boolean }
		| { kind: "kept"; reason: "target-used" | "verify-failed" | "child-kept" | "copy-incomplete" }
		| { kind: "failed"; error: string }
		| { kind: "scheduled" }
		| { kind: "setAside"; asideTo: string; stopped: boolean }
		| { kind: "blocked"; reason: BlockReason; fix: string; refused?: true }
		| { kind: "absent" }
	);

export type LayoutResult = Record<EntryName, Outcome>;

const results = new WeakMap<DgPaths, LayoutResult>();

export const isMoveEntry = <T extends LayoutEntry>(entry: T): entry is Extract<T, MoveEntry> => !("marker" in entry);

export const moveEntries: readonly MoveEntry[] = LAYOUT_TABLE.filter(isMoveEntry);

export const sourcesOf = (entry: MoveEntry, legacyHome: string): string[] =>
	[entry.from].flat().map((relative) => join(legacyHome, relative));

const WORK_NAMES: ReadonlySet<string> = new Set(
	moveEntries.map((entry) => [entry.from].flat()[0]?.split("/")[0] ?? ""),
);

/** Turns a lock that gave up into a `DgCliError` with the same message; errors from the guarded body pass through. */
export const withCliLockError =
	(lock: LayoutSeams["lock"]): LayoutSeams["lock"] =>
	async (root, fn) => {
		let entered = false;
		try {
			return await lock(root, () => {
				entered = true;
				return fn();
			});
		} catch (error) {
			if (!entered && error instanceof Error && !(error instanceof DgCliError)) throw new DgCliError(error.message);
			throw error;
		}
	};

export function resolveSeams(hooks: LayoutHooks): LayoutSeams {
	return {
		readdir: hooks.readdir ?? ((path) => readdirSync(path)),
		lstat: hooks.lstat ?? ((path) => lstatSync(path)),
		load: async () => (await hooks.load?.()) ?? (await import("./layout-work")),
		log: hooks.log ?? ((line) => void process.stderr.write(`${line}\n`)),
		now: hooks.now ?? Date.now,
		entryFile: hooks.entryFile ?? (() => process.argv[1]),
		execPath: hooks.execPath ?? (() => process.execPath),
		lock: hooks.lock ?? withCliLockError((root, fn) => withInstallLock(root, fn)),
	};
}

/** The target folder or file of an entry; a missing `ssms.configDir` hook falls back to the config root. */
export function destOf(entry: MoveEntry, paths: DgPaths, hooks: LayoutHooks): string {
	return entry.to(paths, { "ssms.configDir": hooks["ssms.configDir"] ?? (() => paths.configDir) });
}

/** The path that holds the entry once moved: the folder `to` for a file list keeps the first file's name. */
export function placeOf(entry: MoveEntry, dest: string): string {
	return typeof entry.from === "string" ? dest : join(dest, basename(entry.from[0] ?? ""));
}

export function blockedText({ reason, from, to, refused }: Ends & { reason: BlockReason; refused?: boolean }): string {
	if (reason === "no-hook") return `dg: ${from} has not moved to ${to}; run dg-skills install`;
	return refused
		? `dg: kept ${from}; stop the dg-daemon service, then run dg-skills install again`
		: `dg: kept ${from}; a process that writes it is running. Stop it, then run dg-skills install again`;
}

export const layoutResult = (paths: DgPaths): LayoutResult | undefined => results.get(paths);

const exists = (path: string): boolean => {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
};

/** Throws when a writer holds the entry, its move failed, its pending copy is incomplete, or it stayed with no data at its target. */
export function assertNotBlocked(paths: DgPaths, name: EntryName): void {
	const cached = results.get(paths)?.[name];
	if (cached) {
		if (cached.kind === "blocked") throw new DgCliError(cached.fix);
		if (cached.kind === "failed") throw new DgCliError(cached.error);
		if (cached.kind === "kept" && cached.reason === "copy-incomplete") {
			throw new DgCliError(
				`dg: kept ${cached.from}; its copy at ${cached.to} no longer holds every file. Copy what you need into ${cached.to}, then remove ${cached.from}`,
			);
		}
		if (cached.kind === "kept" && exists(cached.from) && !exists(cached.to)) {
			throw new DgCliError(blockedText({ reason: "no-hook", from: cached.from, to: cached.to }));
		}
		if (cached.kind === "kept" && cached.reason === "child-kept" && exists(cached.from)) {
			throw new DgCliError(`dg: kept ${cached.from}; a folder inside it did not move. dg-skills doctor names it`);
		}
		return;
	}
	const entry = moveEntries.find((candidate) => candidate.name === name);
	if (!entry) return;
	const from = sourcesOf(entry, paths.legacyHome)[0] ?? "";
	const to = placeOf(entry, destOf(entry, paths, {}));
	if (exists(from) && !exists(to)) throw new DgCliError(blockedText({ reason: "no-hook", from, to }));
}

export function legacyNames(legacyHome: string, readdir: LayoutSeams["readdir"]): string[] {
	try {
		return readdir(legacyHome);
	} catch (error) {
		if (isMissingPath(error)) return [];
		throw error;
	}
}

function pendingNonEmpty(legacyHome: string): boolean {
	try {
		const records: unknown = JSON.parse(readFileSync(join(legacyHome, PENDING_FILE), "utf8"));
		return Array.isArray(records) && records.length > 0;
	} catch {
		return false;
	}
}

const hasWork = (legacyHome: string, names: readonly string[]): boolean =>
	names.some(
		(name) =>
			WORK_NAMES.has(name) ||
			name.startsWith(DETACHED_PREFIX) ||
			(name === PENDING_FILE && pendingNonEmpty(legacyHome)),
	);

function idleResult(paths: DgPaths, hooks: LayoutHooks): LayoutResult {
	return Object.fromEntries(
		moveEntries.map((entry) => [
			entry.name,
			{
				kind: "absent",
				from: sourcesOf(entry, paths.legacyHome)[0] ?? "",
				to: placeOf(entry, destOf(entry, paths, hooks)),
			} satisfies Outcome,
		]),
	) as LayoutResult;
}

async function resolveLayout(paths: DgPaths, hooks: LayoutHooks): Promise<LayoutResult> {
	const seams = resolveSeams(hooks);
	if (!hasWork(paths.legacyHome, legacyNames(paths.legacyHome, seams.readdir))) return idleResult(paths, hooks);
	const work = await seams.load();
	const plan = work.planLayout(LAYOUT_TABLE, work.snapshot(paths, hooks), hooks);
	if (!work.mutates(plan)) return work.applyLayout(plan, hooks);
	return seams.lock(paths.dataDir, async () =>
		work.applyLayout(work.planLayout(LAYOUT_TABLE, work.snapshot(paths, hooks), hooks), hooks),
	);
}

/** Moves the legacy flat home into the per-OS roots before any state opens; the result is cached per `DgPaths` object. */
export async function ensureLayout(paths: DgPaths, hooks: LayoutHooks = {}): Promise<LayoutResult> {
	const cached = results.get(paths);
	if (cached) return cached;
	const result = await resolveLayout(paths, hooks);
	results.set(paths, result);
	return result;
}
