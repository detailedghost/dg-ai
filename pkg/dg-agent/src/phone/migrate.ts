import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { DgCliError, describeError } from "@dg/common";
import { type DgPaths, ensurePrivateDir, isAlive, realSubdirectories, selfCommand } from "@dg/common/node";
import { generateSecretKey, nip19 } from "nostr-tools";
import { SECRET_BYTES } from "./card";
import { type Direction, PhoneDb } from "./db";
import {
	adoptListenerPid,
	isZombie,
	listenerCommandArgs,
	listenerGeneration,
	listenerLogPath,
	spawnDetachedListener,
	type ListenerGeneration,
} from "./listener";
import {
	addContact,
	addInvite,
	DEFAULT_RELAYS,
	FALLBACK_SELF_NAME,
	nextFreeHandle,
	subscriptionRelays,
	writeCursor,
	writeNumber,
	writeNumberKeyId,
} from "./store";

export type JobCliResult = { code: number; stdout: string; stderr: string };
export type JobCli = (args: string[]) => Promise<JobCliResult>;

export type MigrationResult =
	| { migrated: false }
	| {
			migrated: true;
			lines: number;
			contacts: number;
			messages: number;
			numberKey: string;
			/** `adopted` keeps a listener that is already `phone __run`. `replaced` stopped the old
			 * ones and started exactly one new listener, with its pid recorded. `none` means nothing
			 * was listening. A failed replacement throws: one `phone __run` is started against the
			 * kept `phone.db` and the message says so only when that process stays up. */
			listener: "adopted" | "replaced" | "none";
			/** Resolves once every `dg-daemon job disable` attempt has settled; the one-time stderr
			 * summary is written when this resolves. Production callers ignore it; tests await it. */
			jobsDisabled: Promise<string[]>;
	  };

export type MigrateDeps = {
	now: () => number;
	/** `legacy` or `current` when `pid` is one of our listeners; undefined for a dead or foreign pid. */
	classifyListener: (pid: number) => ListenerGeneration | undefined;
	isAlive: (pid: number) => boolean;
	kill: (pid: number) => void;
	sleepSync: (ms: number) => void;
	/** Start exactly one new listener. Called only after every listener being replaced has exited.
	 * Returns the child pid so the caller can record it before anything else looks. */
	startListener: (paths: DgPaths) => number;
	/** Command line of a live listener, captured before it is stopped so a failed start can bring one back. */
	commandArgs: (pid: number) => string[] | undefined;
	/** Spawn one saved argv. Used only when `startListener` throws. */
	restoreListener: (paths: DgPaths, argv: string[]) => number;
	jobCli: JobCli;
	renameLegacyRoot: (oldPath: string, newPath: string) => void;
	writeErr: (text: string) => void;
};

const LINE_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** The line a fresh install's number key comes from when one exists; see `writeMigratedLines`. */
const LEGACY_DEFAULT_LINE = "default";
const STOP_WAIT_MS = 5000;

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

type LegacyLine = { name: string; dir: string; dbPath: string; pidPath: string };
type LegacyConfig = { contact?: string; name?: string; relays: string[] };
type LegacyInvite = { secret: string; expiresAt: number; name?: string; as?: string };
type LegacyMessageRow = {
	id: string;
	direction: Direction;
	ts: number;
	sender: string;
	contact: string;
	text: string;
	call: number;
	read_at: number | null;
};
type LegacyLineData = {
	name: string;
	config: LegacyConfig;
	nsec?: string;
	keyInStore: boolean;
	invite?: LegacyInvite;
	cursor: number;
	messages: LegacyMessageRow[];
};

/** The old per-line database filename, from phone-friend's `line.ts`. */
function legacyDbPath(root: string, line: string): string {
	return join(root, line, "phone-friend.db");
}

function hasLegacyLines(root: string): boolean {
	return realSubdirectories(root)
		.filter((name) => LINE_PATTERN.test(name))
		.some((name) => existsSync(legacyDbPath(root, name)));
}

/** The legacy root, when it still holds a line database and `phone.db` has not been written yet. */
export function legacyRoot(paths: DgPaths): string | undefined {
	if (existsSync(PhoneDb.path(paths))) return undefined;
	return hasLegacyLines(paths.phoneFriendRoot) ? paths.phoneFriendRoot : undefined;
}

/** True once `phone.db` exists but the old root is still sitting next to it unrenamed: the
 * one-way migration ran, but its last step (renaming the old root for rollback) failed. A
 * `status` command surfaces this as `legacy_root_present`. */
export function legacyRootPresent(paths: DgPaths): boolean {
	return existsSync(PhoneDb.path(paths)) && hasLegacyLines(paths.phoneFriendRoot);
}

/** Every line that holds a database, in name order; same filter and ordering as phone-friend's
 * own `listLines`. */
function legacyLines(paths: DgPaths): LegacyLine[] {
	return realSubdirectories(paths.phoneFriendRoot)
		.filter((name) => LINE_PATTERN.test(name))
		.sort()
		.map((name) => {
			const dir = join(paths.phoneFriendRoot, name);
			return { name, dir, dbPath: legacyDbPath(paths.phoneFriendRoot, name), pidPath: join(dir, "listener.pid") };
		})
		.filter((line) => existsSync(line.dbPath));
}

function legacySetting<T>(db: Database, key: string): T | undefined {
	const row = db.query("SELECT value FROM settings WHERE key = $key").get({ key }) as { value: string } | null;
	return row ? (JSON.parse(row.value) as T) : undefined;
}

/** Reads one line's database without writing to it; throws on a corrupt or unreadable file so
 * the caller can abort the whole migration before anything is written. */
function readLegacyLine(line: LegacyLine): LegacyLineData {
	const db = new Database(line.dbPath, { strict: true });
	try {
		const config: LegacyConfig = { relays: DEFAULT_RELAYS, ...legacySetting<LegacyConfig>(db, "config") };
		const messages = db.query("SELECT * FROM messages ORDER BY ts, id").all() as LegacyMessageRow[];
		return {
			name: line.name,
			config,
			nsec: legacySetting<string>(db, "nsec"),
			keyInStore: legacySetting<boolean>(db, "key_in_store") === true,
			invite: legacySetting<LegacyInvite>(db, "invite"),
			cursor: legacySetting<number>(db, "cursor") ?? 0,
			messages,
		};
	} finally {
		db.close();
	}
}

/** The saved self name, shared across every line; same file phone-friend's `readWhoami` read. */
function resolveWhoami(paths: DgPaths): string | undefined {
	const path = join(paths.phoneFriendRoot, ".whoami");
	if (!existsSync(path)) return undefined;
	return readFileSync(path, "utf8").trim() || undefined;
}

function readLegacyPid(line: LegacyLine): number | undefined {
	if (!existsSync(line.pidPath)) return undefined;
	const pid = Number(readFileSync(line.pidPath, "utf8").trim());
	return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

type ListenerPlan =
	| { action: "none" }
	| { action: "adopt"; pid: number }
	| { action: "keep"; pid: number; stop: number[] }
	| { action: "replace"; pids: number[] };

/** A `phone __run` process is kept: it will open `phone.db`. An old `phone-friend __run` is not,
 * because it keeps writing the database it already has open. Every legacy pid is stopped and
 * exactly one new listener is started. A pid `classifyListener` rejects is left alone. */
function planListeners(lines: LegacyLine[], deps: MigrateDeps): ListenerPlan {
	const live: { pid: number; generation: ListenerGeneration }[] = [];
	for (const line of lines) {
		const pid = readLegacyPid(line);
		if (pid === undefined) continue;
		const generation = deps.classifyListener(pid);
		if (!generation) continue;
		live.push({ pid, generation });
	}
	if (live.length === 0) return { action: "none" };
	const current = live.filter((entry) => entry.generation === "current");
	if (current.length === 0) return { action: "replace", pids: live.map((entry) => entry.pid) };
	const keep = current.find((entry) => entry.pid === process.pid) ?? current[0];
	const stop = live.filter((entry) => entry.pid !== keep.pid).map((entry) => entry.pid);
	if (stop.length === 0) return { action: "adopt", pid: keep.pid };
	return { action: "keep", pid: keep.pid, stop };
}

/** Stops exactly the pids in `plan` and returns any that are still alive. Does not start a listener. */
function stopForReplace(lines: LegacyLine[], pids: number[], deps: MigrateDeps): number[] {
	for (const pid of pids) {
		try {
			deps.kill(pid);
		} catch {}
	}
	const stuck: number[] = [];
	for (const pid of pids) {
		for (let waited = 0; deps.isAlive(pid) && waited < STOP_WAIT_MS; waited += 100) deps.sleepSync(100);
		if (deps.isAlive(pid)) stuck.push(pid);
	}
	if (stuck.length === 0) {
		for (const line of lines) {
			const pid = readLegacyPid(line);
			if (pid !== undefined && pids.includes(pid)) rmSync(line.pidPath, { force: true });
		}
	}
	return stuck;
}

function writeMigratedLines(
	db: PhoneDb,
	lines: LegacyLineData[],
	selfName: string,
	now: number,
): { numberKeyId: string; contacts: number; messages: number } {
	const lineNames = lines.map((line) => line.name);
	const numberKeyId = lineNames.includes(LEGACY_DEFAULT_LINE) ? LEGACY_DEFAULT_LINE : lineNames[0];

	for (const line of lines) {
		if (line.keyInStore) {
			db.putKey({ id: line.name, nsec: null, in_store: 1 });
		} else {
			db.putKey({ id: line.name, nsec: line.nsec ?? nip19.nsecEncode(generateSecretKey()), in_store: 0 });
		}
	}

	for (const line of lines) {
		if (!line.config.contact) continue;
		const handle = nextFreeHandle(db, line.config.name ?? line.name);
		addContact(db, {
			npub: line.config.contact,
			handle,
			relays: line.config.relays,
			keyId: line.name,
			addedAt: now,
			via: "migrated",
		});
	}

	for (const line of lines) {
		if (!line.invite || line.invite.expiresAt <= now) continue;
		addInvite(db, {
			secret: line.invite.secret,
			expiresAt: line.invite.expiresAt,
			asName: line.invite.as ?? selfName,
			name: line.invite.name,
			keyId: line.name,
			relays: line.config.relays,
		});
	}

	let messageCount = 0;
	for (const line of lines) {
		const contact = line.config.contact;
		for (const row of line.messages) {
			const inserted = db.insertMigratedMessage({
				id: row.id,
				direction: row.direction,
				ts: row.ts,
				sender: row.sender,
				contact: contact ?? row.sender,
				text: row.text,
				call: row.call,
				read_at: row.read_at,
			});
			if (inserted) messageCount += 1;
		}
	}

	writeCursor(db, Math.min(...lines.map((line) => line.cursor)));

	writeNumber(db, { secret: randomBytes(SECRET_BYTES).toString("hex"), as: selfName });
	writeNumberKeyId(db, numberKeyId);

	return { numberKeyId, contacts: db.listContacts().length, messages: messageCount };
}

/** Tries `dg-daemon job disable phone-friend:<line>` for each line, through the daemon's own CLI
 * against its database file, so no live daemon process is required. Every failure (missing
 * binary, no such job, a locked database) is swallowed; the result lists only what disabling
 * actually confirmed. */
export async function disableLegacyDaemonJobs(lineNames: string[], jobCli: JobCli): Promise<string[]> {
	const disabled: string[] = [];
	for (const name of lineNames) {
		const label = `phone-friend:${name}`;
		try {
			const result = await jobCli(["job", "disable", label]);
			if (result.code === 0) disabled.push(label);
		} catch {}
	}
	return disabled;
}

function defaultMigrateDeps(): MigrateDeps {
	return {
		now: () => Math.floor(Date.now() / 1000),
		classifyListener: listenerGeneration,
		isAlive,
		kill: (pid) => process.kill(pid, "SIGTERM"),
		sleepSync,
		startListener: (paths) => spawnDetachedListener(selfCommand(["phone", "__run"]), listenerLogPath(paths)),
		commandArgs: listenerCommandArgs,
		restoreListener: (paths, argv) => spawnDetachedListener(argv, listenerLogPath(paths)),
		jobCli: runDaemonJobCli,
		renameLegacyRoot: renameSync,
		writeErr: (text) => {
			process.stderr.write(text);
		},
	};
}

/** The migration's own claim file, so two commands invoked moments apart cannot both migrate at once. */
export function migrationLockPath(paths: DgPaths): string {
	return join(paths.phoneRoot, "phone.db.migrating");
}

/** Exclusive create; a lock left by a dead process is reclaimed once, a live holder's throws. */
function acquireMigrationLock(paths: DgPaths, deps: MigrateDeps): void {
	ensurePrivateDir(paths.phoneRoot);
	const lockPath = migrationLockPath(paths);
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const fd = openSync(lockPath, "wx", 0o600);
			writeSync(fd, String(process.pid));
			closeSync(fd);
			return;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		}
		const holderPid = Number(readFileSync(lockPath, "utf8").trim());
		if (Number.isSafeInteger(holderPid) && holderPid > 0 && deps.isAlive(holderPid)) {
			throw new DgCliError(`another phone command is migrating (pid ${holderPid}); try again in a moment`);
		}
		rmSync(lockPath, { force: true });
	}
	throw new DgCliError("could not claim the phone migration lock");
}

function releaseMigrationLock(paths: DgPaths): void {
	rmSync(migrationLockPath(paths), { force: true });
}

/**
 * A writing `phone` command calls this first. Runs once: reads every legacy line, then moves its
 * key, contact, invite, and message into one `phone.db`. A listener that is already `phone __run`
 * is kept. An old `phone-friend __run` is stopped and exactly one new listener is started against
 * `phone.db`, with its pid recorded. If that start throws, one `phone __run` is started against
 * the kept `phone.db` and reported only if it stays up. This binary rejects `phone-friend --line`.
 * Read-only commands do not call this.
 */
export function migrateIfNeeded(paths: DgPaths, deps: MigrateDeps = defaultMigrateDeps()): MigrationResult {
	if (!legacyRoot(paths)) return { migrated: false };

	acquireMigrationLock(paths, deps);
	try {
		return runMigration(paths, deps);
	} finally {
		releaseMigrationLock(paths);
	}
}

type SavedListener = { pid: number; argv: string[] | undefined };

/** Long enough for a process that exits immediately (the new binary rejects `--line`) to be observed dead. */
const RESTORE_SETTLE_MS = 500;

/**
 * An argv this binary will keep running. `phone-friend --line` exits 2, so a captured legacy
 * command is not re-executed. A captured `phone __run` (no `--line`) is. Otherwise the current
 * binary's own `phone __run` is used, which writes `phone.db`.
 */
function argvThisBinaryAccepts(saved: SavedListener[]): string[] {
	for (const entry of saved) {
		const argv = entry.argv?.filter((part) => part.length > 0);
		if (!argv || argv.length === 0) continue;
		if (argv.includes("--line") || argv.includes("phone-friend")) continue;
		if (argv.includes("phone") && argv.includes("__run")) return argv;
	}
	return selfCommand(["phone", "__run"]);
}

/**
 * Starts one listener the current binary accepts, against the `phone.db` already written.
 * Returns it only after it has stayed alive through `RESTORE_SETTLE_MS`. A legacy per-line
 * command is not started: this binary rejects it, and those processes would exit at once.
 */
function restorePrevious(paths: DgPaths, deps: MigrateDeps, saved: SavedListener[]): { stayedUp: boolean; pid?: number } {
	if (!existsSync(PhoneDb.path(paths))) return { stayedUp: false };
	let pid: number;
	try {
		pid = deps.restoreListener(paths, argvThisBinaryAccepts(saved));
	} catch {
		return { stayedUp: false };
	}
	for (let waited = 0; waited < RESTORE_SETTLE_MS; waited += 50) {
		if (!deps.isAlive(pid) || isZombie(pid)) return { stayedUp: false };
		deps.sleepSync(50);
	}
	if (!deps.isAlive(pid) || isZombie(pid)) return { stayedUp: false };
	adoptListenerPid(paths, { pid, since: deps.now(), hook: null });
	return { stayedUp: true, pid };
}

function runMigration(paths: DgPaths, deps: MigrateDeps): MigrationResult {
	if (!legacyRoot(paths)) return { migrated: false };

	const lines = legacyLines(paths);
	// A bad database must fail before any listener is signaled.
	let staged = lines.map((line) => readLegacyLine(line));
	const plan = planListeners(lines, deps);
	const stopping = plan.action === "replace" ? plan.pids : plan.action === "keep" ? plan.stop : [];
	const saved: SavedListener[] = stopping.map((pid) => ({ pid, argv: deps.commandArgs(pid) }));
	if (stopping.length > 0) {
		const stuck = stopForReplace(lines, stopping, deps);
		if (stuck.length > 0) {
			throw new DgCliError(
				`a phone listener (pid ${stuck.join(", ")}) did not stop; left it running and did not start another. Any listener that already exited stays stopped`,
			);
		}
		try {
			staged = lines.map((line) => readLegacyLine(line));
		} catch (err) {
			throw new DgCliError(
				`${describeError(err)} Stopped listeners were not restarted: this binary rejects phone-friend --line, and phone.db was not written.`,
			);
		}
	}

	const selfName = resolveWhoami(paths) ?? FALLBACK_SELF_NAME;
	const tmpPath = join(paths.phoneRoot, "phone.db.tmp");
	rmSync(tmpPath, { force: true });
	const db = PhoneDb.openAt(tmpPath, paths.phoneRoot, deps.now);
	let written: { numberKeyId: string; contacts: number; messages: number };
	let relays: string[] = [];
	try {
		written = writeMigratedLines(db, staged, selfName, deps.now());
		relays = subscriptionRelays(db);
	} finally {
		db.close();
	}
	renameSync(tmpPath, PhoneDb.path(paths));

	let listener: "adopted" | "replaced" | "none" = "none";
	if (plan.action === "adopt" || plan.action === "keep") {
		adoptListenerPid(paths, { pid: plan.pid, since: deps.now(), hook: null, relays });
		listener = "adopted";
	} else if (plan.action === "replace") {
		try {
			const pid = deps.startListener(paths);
			adoptListenerPid(paths, { pid, since: deps.now(), hook: null, relays });
			listener = "replaced";
		} catch (err) {
			const restored = restorePrevious(paths, deps, saved);
			const detail = describeError(err);
			if (restored.stayedUp) {
				throw new DgCliError(
					`the replacement phone listener failed to start (${detail}). A phone __run listener (pid ${restored.pid}) stayed up against phone.db. The old per-line listeners were not restarted.`,
				);
			}
			throw new DgCliError(
				`the replacement phone listener failed to start (${detail}). No listener stayed up. phone.db was kept. Run phone open.`,
			);
		}
	}

	try {
		deps.renameLegacyRoot(paths.phoneFriendRoot, `${paths.phoneFriendRoot}.migrated`);
	} catch {}

	const jobsDisabled = disableLegacyDaemonJobs(lines.map((line) => line.name), deps.jobCli);
	jobsDisabled
		.then((disabled) => {
			const summary: Record<string, unknown> = {
				migrated: true,
				lines: lines.length,
				contacts: written.contacts,
				messages: written.messages,
				number_key: written.numberKeyId,
				jobs_disabled: disabled,
				listener,
			};
			deps.writeErr(`${JSON.stringify(summary)}\n`);
		})
		.catch(() => {});

	return {
		migrated: true,
		lines: lines.length,
		contacts: written.contacts,
		messages: written.messages,
		numberKey: written.numberKeyId,
		listener,
		jobsDisabled,
	};
}

export type LegacyViewContact = { handle: string; npub: string; relays: string[]; key: string };
export type LegacyViewMessage = {
	id: string;
	ts: number;
	direction: Direction;
	handle: string | null;
	from: string;
	text: string;
	read: boolean;
	call: boolean;
};

export type LegacyView = {
	as: string;
	contacts: number;
	pendingVoicemail: number;
	listener: { pid: number; since: null } | null;
	migrationPending: boolean;
	contactRows: LegacyViewContact[];
	messages: LegacyViewMessage[];
};

/** Reads a legacy install without creating `phone.db`, stopping a listener, or renaming anything. */
export function readOnlyLegacyView(paths: DgPaths, alive: (pid: number) => boolean = isAlive): LegacyView {
	const as = resolveWhoami(paths) ?? FALLBACK_SELF_NAME;
	const empty: LegacyView = {
		as,
		contacts: 0,
		pendingVoicemail: 0,
		listener: null,
		migrationPending: false,
		contactRows: [],
		messages: [],
	};
	if (!hasLegacyLines(paths.phoneFriendRoot)) return empty;
	let pendingVoicemail = 0;
	let listener: { pid: number; since: null } | null = null;
	const contactRows: LegacyViewContact[] = [];
	const messages: LegacyViewMessage[] = [];
	for (const line of legacyLines(paths)) {
		try {
			const db = new Database(line.dbPath, { readonly: true, strict: true });
			try {
				const config = legacySetting<{ contact?: string; name?: string; relays?: string[] }>(db, "config");
				const handle = config?.name ?? line.name;
				if (config?.contact) {
					contactRows.push({
						handle,
						npub: config.contact,
						relays: config.relays ?? DEFAULT_RELAYS,
						key: line.name,
					});
				}
				const rows = db.query("SELECT * FROM messages ORDER BY ts, id").all() as LegacyMessageRow[];
				for (const row of rows) {
					if (row.direction === "in" && row.read_at === null) pendingVoicemail += 1;
					messages.push({
						id: row.id,
						ts: row.ts,
						direction: row.direction,
						handle: config?.contact ? `+${handle}` : null,
						from: row.sender,
						text: row.text,
						read: row.read_at !== null,
						call: row.call === 1,
					});
				}
			} finally {
				db.close();
			}
		} catch {}
		if (listener) continue;
		const pid = readLegacyPid(line);
		if (pid !== undefined && alive(pid)) listener = { pid, since: null };
	}
	contactRows.sort((a, b) => a.handle.localeCompare(b.handle));
	messages.sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
	return {
		as,
		contacts: contactRows.length,
		pendingVoicemail,
		listener,
		migrationPending: true,
		contactRows,
		messages,
	};
}

export function siblingDaemonPath(execPath: string, platform: NodeJS.Platform): string {
	const name = platform === "win32" ? "dg-daemon.exe" : "dg-daemon";
	return join(dirname(execPath), name);
}

/** The dg-daemon binary beside this dg-agent, or `dg-daemon` on PATH. */
export function resolveDaemonExecutable(
	execPath: string,
	platform: NodeJS.Platform,
	exists: (path: string) => boolean,
	which: (name: string) => string | undefined,
): string {
	const sibling = siblingDaemonPath(execPath, platform);
	if (exists(sibling)) return sibling;
	const found = which("dg-daemon");
	if (found) return found;
	throw new DgCliError("dg-daemon was not found next to dg-agent or on PATH; run `dg-skills install` and try again");
}

function envRecord(env: NodeJS.ProcessEnv): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined) out[key] = value;
	}
	return out;
}

/** Run an argv with inherited env and captured output. No shell. */
export async function runArgv(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<JobCliResult> {
	let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
	try {
		proc = Bun.spawn(argv, {
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
			env: envRecord(env),
		});
	} catch (err) {
		return { code: 1, stdout: "", stderr: describeError(err) };
	}
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code: code ?? 1, stdout, stderr };
}

/** `dg-daemon job …`, using the daemon installed beside dg-agent. Slice 5 uses this to disable each
 * migrated line's old voicemail job. */
export function runDaemonJobCli(args: string[]): Promise<JobCliResult> {
	const bin = resolveDaemonExecutable(
		process.execPath,
		process.platform,
		existsSync,
		(name) => Bun.which(name, { PATH: process.env.PATH ?? "" }) ?? undefined,
	);
	return runArgv([bin, ...args]);
}
