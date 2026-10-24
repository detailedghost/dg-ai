import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { DgCliError, describeError } from "@dg/common";
import { type DgPaths, ensurePrivateDir, isAlive, realSubdirectories } from "@dg/common/node";
import { generateSecretKey, nip19 } from "nostr-tools";
import { SECRET_BYTES } from "./card";
import { type Direction, PhoneDb } from "./db";
import { isOurListener } from "./listener";
import {
	addContact,
	addInvite,
	DEFAULT_RELAYS,
	FALLBACK_SELF_NAME,
	nextFreeHandle,
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
			/** Resolves once every `dg-daemon job disable` attempt has settled; the one-time stderr
			 * summary is written when this resolves. Production callers ignore it; tests await it. */
			jobsDisabled: Promise<string[]>;
	  };

export type MigrateDeps = {
	now: () => number;
	isOurListener: (pid: number) => boolean;
	isAlive: (pid: number) => boolean;
	kill: (pid: number) => void;
	jobCli: JobCli;
	renameLegacyRoot: (oldPath: string, newPath: string) => void;
	writeErr: (text: string) => void;
};

const LINE_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** The line a fresh install's number key comes from when one exists; see `writeMigratedLines`. */
const LEGACY_DEFAULT_LINE = "default";

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

/** Best-effort: a listener that will not die leaves a stale pid file behind, which is harmless. */
function stopLegacyListener(line: LegacyLine, deps: MigrateDeps): void {
	if (!existsSync(line.pidPath)) return;
	const pid = Number(readFileSync(line.pidPath, "utf8").trim());
	if (!Number.isSafeInteger(pid) || pid <= 0) return;
	if (!deps.isOurListener(pid)) return;
	try {
		deps.kill(pid);
	} catch {}
	rmSync(line.pidPath, { force: true });
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
		isOurListener,
		isAlive,
		kill: (pid) => process.kill(pid, "SIGTERM"),
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
 * Every `phone`/`phone-friend` command calls this first. Runs once: moves every legacy line's
 * key, contact, invite, and message into one `phone.db`, then renames the old root for rollback.
 * Listeners are stopped and the old root is read before `phone.db.tmp` is written, so a line that
 * fails to read aborts with nothing yet changed; the rename-out-of-the-way step runs last and
 * best-effort, since by then the data has already safely landed in `phone.db`.
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

function runMigration(paths: DgPaths, deps: MigrateDeps): MigrationResult {
	if (!legacyRoot(paths)) return { migrated: false };

	const lines = legacyLines(paths);
	for (const line of lines) stopLegacyListener(line, deps);

	const staged = lines.map((line) => readLegacyLine(line));
	const selfName = resolveWhoami(paths) ?? FALLBACK_SELF_NAME;

	const tmpPath = join(paths.phoneRoot, "phone.db.tmp");
	rmSync(tmpPath, { force: true });
	const db = PhoneDb.openAt(tmpPath, paths.phoneRoot, deps.now);
	let written: { numberKeyId: string; contacts: number; messages: number };
	try {
		written = writeMigratedLines(db, staged, selfName, deps.now());
	} finally {
		db.close();
	}

	renameSync(tmpPath, PhoneDb.path(paths));

	try {
		deps.renameLegacyRoot(paths.phoneFriendRoot, `${paths.phoneFriendRoot}.migrated`);
	} catch {}

	const jobsDisabled = disableLegacyDaemonJobs(lines.map((line) => line.name), deps.jobCli);
	jobsDisabled
		.then((disabled) => {
			deps.writeErr(
				`${JSON.stringify({
					migrated: true,
					lines: lines.length,
					contacts: written.contacts,
					messages: written.messages,
					number_key: written.numberKeyId,
					jobs_disabled: disabled,
				})}\n`,
			);
		})
		.catch(() => {});

	return {
		migrated: true,
		lines: lines.length,
		contacts: written.contacts,
		messages: written.messages,
		numberKey: written.numberKeyId,
		jobsDisabled,
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
