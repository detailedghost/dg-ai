import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { copyTree, type DgPaths, treeContained, treeMatches } from "@dg/common/node";

export type MigrateResult = {
	moved: string[];
	failed: string[];
	kept: string[];
	scheduled: string[];
};

export type MigrateSeams = {
	log?: (line: string) => void;
	afterCopy?: (from: string, to: string) => void;
	rename?: (from: string, to: string) => void;
	removeTree?: (path: string) => void;
	ssmsConfigDir?: string;
};

const PENDING_FILE = ".pending-removal.json";

type Move = { from: string; to: string };

const ROLE_FOLDERS = new Set([
	"bin",
	"config",
	"data",
	"state",
	"cache",
	"log",
]);
const LEFT_FOR_OTHER_STEPS = new Set(["bin", "phone"]);
const WRITER_FOLDERS = ["daemon", "channel-review", "phone-friend", "ssms"];

function pidAlive(file: string): boolean {
	try {
		const text = readFileSync(file, "utf8").trim();
		const pid = Number(text.startsWith("{") ? (JSON.parse(text) as { pid?: unknown }).pid : text);
		if (!Number.isInteger(pid) || pid <= 0) return false;
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

export function liveWriterFolders(legacy: string): string[] {
	const live = WRITER_FOLDERS.map((name) => join(legacy, name)).filter((dir) => {
		try {
			return readdirSync(dir).some((name) => name.endsWith(".pid") && pidAlive(join(dir, name)));
		} catch {
			return false;
		}
	});
	const agents = join(legacy, "agents");
	return live.includes(join(legacy, "daemon")) && present(agents) ? [...live, agents] : live;
}

const within = (path: string, dir: string): boolean => path === dir || path.startsWith(`${dir}${sep}`);

function legacyMoves(paths: DgPaths, ssmsConfigDir: string): Move[] {
	const legacy = paths.legacyHome;
	const at = (...parts: string[]) => join(legacy, ...parts);
	const agentState = [
		"sessions",
		"assets",
		"memory.db",
		"memory.db-wal",
		"memory.db-shm",
	].map((name) => ({
		from: at("agents", name),
		to: join(paths.agentsDir, name),
	}));
	return [
		{ from: at("runtime"), to: paths.runtimeDir },
		{ from: at("lib"), to: paths.libDir },
		{ from: at("skills"), to: paths.skillsDir },
		{ from: at("browsers"), to: paths.browsersDir },
		{ from: at("demo-narration"), to: join(paths.dataDir, "demo-narration") },
		...agentState,
		{ from: at("agents"), to: paths.personasDir },
		{ from: at("daemon", "logs"), to: paths.logDir },
		{ from: at("daemon"), to: paths.daemonDir },
		{ from: at("grants"), to: paths.grantsDir },
		{ from: at("pairing.json"), to: paths.pairingPath },
		{ from: at("phone-friend"), to: paths.phoneFriendRoot },
		{ from: at("inbox"), to: join(paths.stateDir, "inbox") },
		{
			from: at("browser-profiles"),
			to: join(paths.stateDir, "browser-profiles"),
		},
		{ from: at("demo-profile"), to: join(paths.stateDir, "demo-profile") },
		{
			from: at("channel-review", "config.json"),
			to: join(paths.configDir, "channel-review", "config.json"),
		},
		{ from: at("channel-review"), to: join(paths.stateDir, "channel-review") },
		{ from: at("ssms", "config.yaml"), to: join(ssmsConfigDir, "ssms", "config.yaml") },
		{ from: at("ssms"), to: join(paths.stateDir, "ssms") },
		{ from: at("proto"), to: join(paths.cacheDir, "proto") },
		{ from: at("demos"), to: join(paths.cacheDir, "demos") },
		{ from: at("config.json"), to: paths.configPath },
		{ from: at("cli-only"), to: paths.cliOnlyMarker },
	];
}

function present(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

type Pending = { from: string; to: string };

function readPending(legacy: string): Pending[] {
	try {
		const value: unknown = JSON.parse(readFileSync(join(legacy, PENDING_FILE), "utf8"));
		if (!Array.isArray(value)) return [];
		return value.filter(
			(entry): entry is Pending =>
				typeof entry?.from === "string" && typeof entry?.to === "string",
		);
	} catch {
		return [];
	}
}

function writePending(legacy: string, pending: Pending[]): void {
	const file = join(legacy, PENDING_FILE);
	if (pending.length === 0) {
		rmSync(file, { force: true });
		return;
	}
	const staged = `${file}.${process.pid}.tmp`;
	writeFileSync(staged, JSON.stringify(pending), { mode: 0o600 });
	renameSync(staged, file);
}

const DETACHED = ".removing-";

function removeTree(path: string, seams: MigrateSeams): void {
	try {
		(seams.removeTree ?? ((p: string) => rmSync(p, { recursive: true, force: true })))(path);
	} catch {}
}

/** Detaches the source with one rename first, so a folder a running program holds open is never half deleted. */
export function removeSource(from: string, seams: MigrateSeams = {}): boolean {
	const detached = join(dirname(from), `${DETACHED}${basename(from)}-${process.pid}`);
	try {
		(seams.rename ?? renameSync)(from, detached);
	} catch {
		return false;
	}
	removeTree(detached, seams);
	return true;
}

/** Copies `from` to `to`, checks the copy, then removes `from`; never writes over an existing `to`. */
export function moveVerified(
	from: string,
	to: string,
	seams: MigrateSeams = {},
): "moved" | "failed" | "kept" | "scheduled" {
	const log = seams.log ?? (() => {});
	if (present(to)) {
		log(`dg: kept ${from}; ${to} already exists`);
		return "kept";
	}
	try {
		mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
		copyTree(from, to);
		seams.afterCopy?.(from, to);
		if (!treeMatches(from, to)) throw new Error("the copy does not match the source");
	} catch (err) {
		rmSync(to, { recursive: true, force: true });
		log(`dg: kept ${from}; moving it to ${to} failed: ${err instanceof Error ? err.message : err}`);
		return "failed";
	}
	if (removeSource(from, seams)) return "moved";
	log(`dg: copied ${from} to ${to}; it is in use, so the next dg-skills install removes it`);
	return "scheduled";
}

function retryPending(entry: Pending, seams: MigrateSeams, result: MigrateResult, scheduled: Pending[]): void {
	if (!present(entry.from)) return;
	if (!present(entry.to) || !treeContained(entry.from, entry.to)) {
		result.kept.push(entry.from);
		seams.log?.(`dg: kept ${entry.from}; its copy at ${entry.to} no longer holds every file`);
		return;
	}
	if (removeSource(entry.from, seams)) {
		result.moved.push(entry.from);
		return;
	}
	result.scheduled.push(entry.from);
	scheduled.push(entry);
}

function moveOne(move: Move, seams: MigrateSeams, result: MigrateResult, scheduled: Pending[]): void {
	const outcome = moveVerified(move.from, move.to, seams);
	if (outcome === "moved") result.moved.push(move.from);
	else if (outcome === "failed") result.failed.push(move.from);
	else if (outcome === "kept") result.kept.push(move.from);
	else {
		result.scheduled.push(move.from);
		scheduled.push(move);
	}
}

/** Moves the old flat `~/.dg` (or flat `DG_HOME`) into the per-OS roots: copy, verify, then remove. */
export function migrateLegacyHome(
	paths: DgPaths,
	seams: MigrateSeams = {},
): MigrateResult {
	const result: MigrateResult = { moved: [], failed: [], kept: [], scheduled: [] };
	if (!existsSync(paths.legacyHome)) return result;
	for (const name of readdirSync(paths.legacyHome))
		if (name.startsWith(DETACHED)) removeTree(join(paths.legacyHome, name), seams);
	const flatDgHome = paths.binDir === join(paths.legacyHome, "bin");
	const live = liveWriterFolders(paths.legacyHome);
	for (const dir of live) {
		result.kept.push(dir);
		seams.log?.(`dg: kept ${dir}; a process that writes it is running. Stop it, then run dg-skills install again`);
	}
	const scheduled: Pending[] = [];
	for (const entry of readPending(paths.legacyHome)) {
		if (live.some((dir) => within(entry.from, dir))) scheduled.push(entry);
		else retryPending(entry, seams, result, scheduled);
	}
	for (const move of legacyMoves(paths, seams.ssmsConfigDir ?? paths.configDir)) {
		const top = relative(paths.legacyHome, move.from).split(sep)[0] ?? "";
		if (flatDgHome && ROLE_FOLDERS.has(top)) continue;
		if (live.some((dir) => within(move.from, dir))) continue;
		if ([...result.scheduled, ...scheduled.map((entry) => entry.from)].some((dir) => within(move.from, dir))) continue;
		if (result.kept.includes(move.from)) continue;
		if (!present(move.from)) continue;
		const blocked = [...result.failed, ...result.kept].some((path) => path !== move.from && within(path, move.from));
		if (blocked) {
			result.kept.push(move.from);
			seams.log?.(`dg: kept ${move.from}; part of it did not move`);
			continue;
		}
		moveOne(move, seams, result, scheduled);
	}
	writePending(paths.legacyHome, scheduled);
	const quiet = result.moved.length === 0 && result.failed.length === 0;
	for (const name of readdirSync(paths.legacyHome)) {
		if (LEFT_FOR_OTHER_STEPS.has(name) || name.startsWith("dg-ai-") || name.startsWith(".")) continue;
		if (flatDgHome && ROLE_FOLDERS.has(name)) continue;
		const path = join(paths.legacyHome, name);
		if (result.kept.includes(path) || result.failed.includes(path) || result.scheduled.includes(path)) continue;
		result.kept.push(path);
		if (!quiet)
			seams.log?.(`dg: left ${path} in place; dg does not know where it belongs`);
	}
	return result;
}
