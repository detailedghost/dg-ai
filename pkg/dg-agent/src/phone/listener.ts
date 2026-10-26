import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, linkSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { DgCliError } from "@dg/common";
import { type DgPaths, ensurePrivateDir, isAlive, selfCommand, writeFileAtomic } from "@dg/common/node";
import { DG_AGENT_PACKAGE_VERSION } from "../version";
import {
	fetchNew,
	type Message,
	type NewContact,
	type PhonePool,
	type Reaccept,
	type Seen,
	type SubscribeExtra,
	subscribe,
	UNKNOWN_CALLER_HANDLE,
} from "./chat";
import { createHookRunner, type Cancel, type HookRunner, type Schedule } from "./hook";
import { type KeyDeps, ensureNumberKey, loadAllKeys } from "./keys";
import type { PhoneDb } from "./db";
import type { CommandPushTarget } from "./push";
import {
	addContact,
	addPhoneNotice,
	consumeInvite,
	findContactByNpub,
	gateFor,
	isHandle,
	nextFreeHandle,
	readCursor,
	readListener,
	readRelays,
	notePhoneDrift,
	setContactKeyId,
	subscriptionRelays,
	writeCursor,
} from "./store";
import { managedRestartCommands, type AutostartKind } from "./autostart";

export type ListenerDeps = KeyDeps & {
	createPool: () => PhonePool & { close(relays: string[]): void };
	now: () => number;
	pid: number;
	hook?: CommandPushTarget;
	schedule: Schedule;
	onSignal: (signal: "SIGTERM" | "SIGINT", handler: () => void) => void;
};

export type ListenerPid = {
	pid: number;
	since: number;
	hook: { argv: string[]; timeoutS: number } | null;
	/** Relays this process subscribed to. Missing means the file was written before that was recorded. */
	relays?: string[];
	/** Set when migration kept an old `phone-friend __run` process instead of starting a second one. */
	adopted?: "legacy";
	/** `DG_AGENT_PACKAGE_VERSION` of the binary that wrote this file. Missing means an older binary. */
	version?: string;
	/** `keyFingerprint` of the keys this process subscribed to. Missing is not a mismatch. */
	keys?: string;
};

/** sha256 prefix of sorted `id:pub` lines. Empty when there are no keys. Never includes a secret. */
export function keyFingerprint(keys: { id: string; pub: string }[]): string {
	const body = keys.map((key) => `${key.id}:${key.pub}`).sort().join("\n");
	return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

export type ListenerDrift = {
	restart: boolean;
	reason?: string;
	token?: string;
	notice?: string;
	/** A store read failed. Not a key change, and not a reason to restart. */
	keysUnreadable?: boolean;
};

/** Whether `record` was written by another binary or subscribed to a different key set than `deps.db` holds. */
export async function listenerDrift(deps: KeyDeps, record: ListenerPid): Promise<ListenerDrift> {
	if (record.version !== DG_AGENT_PACKAGE_VERSION) {
		return {
			restart: true,
			reason: "listener binary version differs",
			token: `binary:${record.version ?? ""}`,
			notice: "listener binary changed",
		};
	}
	let loaded: Awaited<ReturnType<typeof loadAllKeys>>;
	try {
		loaded = await loadAllKeys(deps);
	} catch {
		return { restart: false, keysUnreadable: true };
	}
	if (loaded.unreadable.length > 0) return { restart: false, keysUnreadable: true };
	const fingerprint = keyFingerprint(loaded.keys);
	if (record.keys !== undefined && record.keys !== fingerprint) {
		return {
			restart: true,
			reason: "listener keys differ from the database",
			token: `keys:${fingerprint}`,
			notice: "key changed",
		};
	}
	return { restart: false };
}

export type ListenerGeneration = "current" | "legacy";

/** How often a message stuck at the attempt cap gets one fresh try, outside the listener's start-up retry. */
export const STUCK_RETRY_INTERVAL_MS = 30 * 60 * 1000;

/** How often the running listener re-reads keys and resubscribes when they changed. */
export const KEY_WATCH_INTERVAL_MS = 5_000;

export function listenerPidPath(paths: DgPaths): string {
	return join(paths.phoneRoot, "listener.pid");
}

export function listenerLogPath(paths: DgPaths): string {
	return join(paths.phoneRoot, "listener.log");
}

/** True for the argv of either the current `phone __run` listener or the old `phone-friend __run` one. */
export function isListenerArgs(args: string[]): boolean {
	return (args.includes("phone") || args.includes("phone-friend")) && args.includes("__run");
}

export type ProcessArgs = { kind: "dead" } | { kind: "unknown" } | { kind: "args"; args: string[] };

/** `ours` keeps the lock. `foreign` is a command line that is positively not a listener. `unknown` means the lookup failed or came back empty. */
export type HolderVerdict = "ours" | "foreign" | "unknown";

/** A `ps` or PowerShell command-line lookup. A failed or empty result is unknown, not a foreign process. */
export function commandLookupFromText(status: number | null, stdout: string | undefined): ProcessArgs {
	if (status !== 0 || stdout === undefined) return { kind: "unknown" };
	const args = stdout
		.trim()
		.split(/\s+/)
		.filter((part) => part.length > 0);
	if (args.length === 0) return { kind: "unknown" };
	return { kind: "args", args };
}

/** True when a `/proc/<pid>/stat` line reports zombie state. */
export function isZombieStat(stat: string): boolean {
	const afterComm = stat.slice(stat.lastIndexOf(")") + 2);
	return afterComm.charAt(0) === "Z";
}

function readProcStat(pid: number): string | undefined {
	try {
		return readFileSync(`/proc/${pid}/stat`, "utf8");
	} catch {
		return undefined;
	}
}

/** True when `/proc/<pid>/stat` reports zombie state; anything unreadable is not a zombie. */
export function isZombie(pid: number, readStat: (pid: number) => string | undefined = readProcStat): boolean {
	try {
		const stat = readStat(pid);
		if (stat === undefined) return false;
		return isZombieStat(stat);
	} catch {
		return false;
	}
}

/** Alive and not state Z. `kill -0` succeeds on a zombie, so a zombie is not a running listener. */
export function listenerProcessAlive(
	pid: number,
	readStat?: (pid: number) => string | undefined,
	alive: (pid: number) => boolean = isAlive,
): boolean {
	if (!alive(pid)) return false;
	return !isZombie(pid, readStat);
}

function readProcessArgs(pid: number): ProcessArgs {
	if (!Number.isSafeInteger(pid) || pid <= 0) return { kind: "unknown" };
	if (!isAlive(pid)) return { kind: "dead" };
	const cmdline = `/proc/${pid}/cmdline`;
	if (existsSync("/proc")) {
		if (isZombie(pid)) return { kind: "dead" };
		try {
			if (!existsSync(cmdline)) return isAlive(pid) ? { kind: "unknown" } : { kind: "dead" };
			const args = readFileSync(cmdline, "utf8")
				.split("\0")
				.filter((part) => part.length > 0);
			if (args.length === 0) return { kind: "unknown" };
			return { kind: "args", args };
		} catch {
			return isAlive(pid) ? { kind: "unknown" } : { kind: "dead" };
		}
	}
	if (process.platform === "win32") {
		const query = `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`;
		const ps = spawnSync("powershell", ["-NoProfile", "-Command", query], { encoding: "utf8" });
		if (ps.error) return { kind: "unknown" };
		return commandLookupFromText(ps.status, ps.stdout);
	}
	const ps = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
	if (ps.error) return { kind: "unknown" };
	return commandLookupFromText(ps.status, ps.stdout);
}

export function listenerCommandArgs(pid: number): string[] | undefined {
	const found = readProcessArgs(pid);
	return found.kind === "args" ? found.args : undefined;
}

/** Whether `pid` is alive and its command line is positively one of our listeners. */
export function isOurListener(pid: number): boolean {
	return holderVerdict(pid) === "ours";
}

/** Dead and a positively non-listener command line are foreign. A lookup that cannot answer is unknown. */
export function holderVerdict(pid: number): HolderVerdict {
	const found = readProcessArgs(pid);
	if (found.kind === "dead") return "foreign";
	if (found.kind === "unknown") return "unknown";
	return isListenerArgs(found.args) ? "ours" : "foreign";
}

/** `current` is already `phone __run`. `legacy` is the old `phone-friend __run` process. */
export function listenerGeneration(pid: number): ListenerGeneration | undefined {
	const args = listenerCommandArgs(pid);
	if (!args || !isListenerArgs(args)) return undefined;
	return args.includes("phone-friend") ? "legacy" : "current";
}

/** Undefined for no file, a parse failure, a pid that is not a safe positive integer, or a pid that is dead or a zombie. */
export function readListenerPid(
	paths: DgPaths,
	alive: (pid: number) => boolean = (pid) => listenerProcessAlive(pid),
): ListenerPid | undefined {
	const path = listenerPidPath(paths);
	if (!existsSync(path)) return undefined;
	try {
		const record = JSON.parse(readFileSync(path, "utf8")) as ListenerPid;
		if (!Number.isSafeInteger(record.pid) || record.pid <= 0) return undefined;
		if (!alive(record.pid)) return undefined;
		return {
			pid: record.pid,
			since: record.since,
			hook: record.hook,
			...(record.relays ? { relays: record.relays } : {}),
			...(record.adopted === "legacy" ? { adopted: "legacy" as const } : {}),
			...(typeof record.version === "string" ? { version: record.version } : {}),
			...(typeof record.keys === "string" ? { keys: record.keys } : {}),
		};
	} catch {
		return undefined;
	}
}

export function listenerClaimPath(paths: DgPaths): string {
	return join(paths.phoneRoot, "listener.lock");
}

/** How long an empty or unreadable lock is treated as held, so a winner's file is not deleted mid-write. */
const CLAIM_GRACE_MS = 1000;
const CLAIM_ATTEMPTS = 5;

const CLAIM_UNKNOWN_WAIT_MS = 20;

type ClaimView = { kind: "mine" | "held" | "unknown" | "stale"; holder: string; reason?: string };

function logClaim(message: string): void {
	process.stderr.write(`phone: ${message}\n`);
}

function sleepClaim(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readClaimRaw(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

/**
 * Moves a stale lock aside and deletes it only when the moved bytes are still `expected`.
 * A rename is atomic, so a contender that already replaced the lock does not have its file removed.
 * If the moved bytes differ, `link` puts them back, falling back to a rename on anything but `EEXIST`.
 */
export function displaceStaleLock(
	path: string,
	expected: string,
	aside: string,
	link: (src: string, dest: string) => void = linkSync,
): "displaced" | "restored" | "missed" {
	try {
		renameSync(path, aside);
	} catch {
		return "missed";
	}
	const moved = readClaimRaw(aside);
	if (moved !== expected) {
		try {
			link(aside, path);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
				try {
					renameSync(aside, path);
				} catch {}
			}
		}
		rmSync(aside, { force: true });
		return "restored";
	}
	rmSync(aside, { force: true });
	return "displaced";
}

/** `held` is a phone listener, or a lock too new to judge. `unknown` is a lookup that cannot answer. */
function inspectClaim(path: string, pid: number, verdict: (holder: number) => HolderVerdict, now: number): ClaimView {
	let raw: string | undefined;
	let ageMs: number | undefined;
	try {
		raw = readFileSync(path, "utf8");
		ageMs = now - statSync(path).mtimeMs;
	} catch (err) {
		const reason = (err as NodeJS.ErrnoException).code;
		try {
			ageMs = now - statSync(path).mtimeMs;
		} catch {
			return { kind: "stale", holder: "" };
		}
		if (ageMs < CLAIM_GRACE_MS) return { kind: "held", holder: "" };
		return { kind: "unknown", holder: "", reason };
	}
	const holder = raw.trim();
	const parsed = Number(holder);
	if (parsed === pid) return { kind: "mine", holder };
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		if ((ageMs ?? CLAIM_GRACE_MS) < CLAIM_GRACE_MS) return { kind: "held", holder };
		return { kind: "stale", holder };
	}
	const who = verdict(parsed);
	if (who === "ours") return { kind: "held", holder };
	if (who === "unknown") return { kind: "unknown", holder };
	return { kind: "stale", holder };
}

function claimExclusive(tmp: string, path: string, pid: number, link: (src: string, dest: string) => void): "created" | "exists" {
	try {
		link(tmp, path);
		return "created";
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EEXIST") return "exists";
		try {
			const fd = openSync(path, "wx", 0o600);
			try {
				writeSync(fd, String(pid));
			} finally {
				closeSync(fd);
			}
			return "created";
		} catch (wxErr) {
			if ((wxErr as NodeJS.ErrnoException).code !== "EEXIST") throw wxErr;
			return "exists";
		}
	}
}

/**
 * Exclusive claim so a second `phone __run` exits instead of subscribing beside the first.
 * The lock file is linked into place already containing the pid. A filesystem that cannot hard
 * link falls back to an exclusive create that writes the pid before anyone else reads it.
 * Only a command line that is positively not a listener is taken over. A lookup that cannot
 * answer keeps the lock. Losing the claim is logged, including the winner's pid.
 */
export function claimListener(
	paths: DgPaths,
	pid: number,
	verdict: (holder: number) => HolderVerdict = holderVerdict,
	link: (src: string, dest: string) => void = linkSync,
): boolean {
	ensurePrivateDir(paths.phoneRoot);
	const path = listenerClaimPath(paths);
	const tmp = `${path}.${pid}.claim`;
	writeFileSync(tmp, String(pid), { mode: 0o600 });
	let announcedTakeover = false;
	let sawUnknown = false;
	let unknownReason: string | undefined;
	try {
		for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
			if (claimExclusive(tmp, path, pid, link) === "created") return true;
			const seen = inspectClaim(path, pid, verdict, Date.now());
			if (seen.kind === "mine") return true;
			if (seen.kind === "held") {
				logClaim(`listener claim lost to ${seen.holder || "an unreadable lock"}; pid ${pid} is exiting`);
				return false;
			}
			if (seen.kind === "unknown") {
				sawUnknown = true;
				unknownReason = seen.reason ?? unknownReason;
				sleepClaim(CLAIM_UNKNOWN_WAIT_MS);
				continue;
			}
			const before = readClaimRaw(path);
			const again = inspectClaim(path, pid, verdict, Date.now());
			if (again.kind === "mine") return true;
			if (again.kind === "held") {
				logClaim(`listener claim lost to ${again.holder || "an unreadable lock"}; pid ${pid} is exiting`);
				return false;
			}
			if (again.kind === "unknown") {
				sawUnknown = true;
				unknownReason = again.reason ?? unknownReason;
				sleepClaim(CLAIM_UNKNOWN_WAIT_MS);
				continue;
			}
			if (before === undefined || readClaimRaw(path) !== before) continue;
			const aside = `${path}.${pid}.${attempt}.stale`;
			if (displaceStaleLock(path, before, aside, link) !== "displaced") continue;
			if (!announcedTakeover) {
				logClaim(`listener lock held by ${again.holder || "an empty file"} is not a live phone listener; taking over`);
				announcedTakeover = true;
			}
		}
	} finally {
		rmSync(tmp, { force: true });
	}
	if (unknownReason) {
		logClaim(`listener claim lost; could not read the lock file (${unknownReason}); leaving its lock; pid ${pid} is exiting`);
	} else if (sawUnknown) {
		logClaim(`listener claim lost; could not read the holder's command line; leaving its lock; pid ${pid} is exiting`);
	} else {
		logClaim(`listener claim lost; pid ${pid} is exiting`);
	}
	return false;
}

/** Removes the claim only when this pid still holds it, so a losing process cannot drop the winner's lock. */
export function releaseListenerClaim(paths: DgPaths, pid: number): void {
	const path = listenerClaimPath(paths);
	if (!existsSync(path)) return;
	try {
		const holder = Number(readFileSync(path, "utf8").trim());
		if (holder === pid) rmSync(path, { force: true });
	} catch {}
}

/** Points `listener.pid` at a process that is already running, so nothing else starts a second one. */
export function adoptListenerPid(paths: DgPaths, record: ListenerPid): void {
	writeListenerPid(paths, record);
}

/** Detached listener process. The child writes `listener.pid` once `phone __run` is up. */
export function spawnDetachedListener(argv: string[], logPath: string): number {
	ensurePrivateDir(dirname(logPath));
	const log = openSync(logPath, "a", 0o600);
	chmodSync(logPath, 0o600);
	const [command, ...args] = argv;
	const child = spawn(command, args, { detached: true, stdio: ["ignore", log, log], windowsHide: true, env: process.env });
	child.unref();
	if (child.pid === undefined) throw new DgCliError("could not spawn the phone listener");
	return child.pid;
}

function writeListenerPid(paths: DgPaths, record: ListenerPid): void {
	ensurePrivateDir(paths.phoneRoot);
	const stamped: ListenerPid = { ...record, version: record.version ?? DG_AGENT_PACKAGE_VERSION };
	writeFileAtomic(listenerPidPath(paths), JSON.stringify(stamped));
}

export function removeListenerPid(paths: DgPaths): void {
	rmSync(listenerPidPath(paths), { force: true });
}

export function defaultSchedule(delayMs: number, run: () => void): Cancel {
	const timer = setTimeout(run, delayMs);
	return () => clearTimeout(timer);
}

export function defaultOnSignal(signal: "SIGTERM" | "SIGINT", handler: () => void): void {
	process.once(signal, handler);
}

function noopHookRunner(): HookRunner {
	return { notify: () => Promise.resolve(), retryStuck: () => Promise.resolve(), stop: () => {}, settle: () => Promise.resolve() };
}

/** Re-arms itself after every firing; the returned `Cancel` stops the chain, not just the pending timer. */
function repeat(schedule: Schedule, intervalMs: number, run: () => void): Cancel {
	let cancel: Cancel;
	const tick = () => {
		run();
		cancel = schedule(intervalMs, tick);
	};
	cancel = schedule(intervalMs, tick);
	return () => cancel();
}

/** Applies one admitted message's side effects: a fresh handle and contact row for a new caller, the
 * key move for a re-accept, then the message itself, `contact` keyed by the sender (as `fetchNew`'s
 * wiring contract requires). Guarded by `findContactByNpub` so a caught-up follow-up from the same
 * new caller, or a redelivered live event, never renames the contact it already created. */
function admitMessage(
	db: PhoneDb,
	now: () => number,
	relays: string[],
	message: Message,
	newContact?: NewContact,
	reaccept?: Reaccept,
): void {
	if (newContact && !findContactByNpub(db, newContact.npub)) {
		const base = isHandle(newContact.suggestedHandle) ? newContact.suggestedHandle : UNKNOWN_CALLER_HANDLE;
		const handle = nextFreeHandle(db, base);
		const contactRelays = newContact.relays?.length ? newContact.relays : relays;
		addContact(db, { npub: newContact.npub, handle, relays: contactRelays, keyId: newContact.keyId, addedAt: now(), via: newContact.via });
		addPhoneNotice(db, `new contact +${handle}`, now());
		if (newContact.inviteSecret) consumeInvite(db, newContact.inviteSecret);
	}
	if (reaccept) setContactKeyId(db, reaccept.npub, reaccept.keyId);
	db.addMessage({
		id: message.id,
		direction: "in",
		ts: message.ts,
		sender: message.from,
		contact: message.from,
		text: message.text,
		call: message.call ? 1 : 0,
	});
}

/**
 * The one always-on listener: loads every key, catches up on anything missed since the last cursor,
 * then holds one live subscription for the rest of the run. Every admitted message is stored and
 * handed to the `--on-message` hook queue (oldest unread first); a stranger's wrap never reaches it.
 * Resolves once SIGTERM or SIGINT fires, after the subscription, pool, and pid file are torn down.
 */
export async function runListener(deps: ListenerDeps): Promise<void> {
	if (!claimListener(deps.paths, deps.pid)) return;
	try {
		await runClaimedListener(deps);
	} catch (err) {
		releaseListenerClaim(deps.paths, deps.pid);
		throw err;
	}
}

function listenerPidRecord(deps: ListenerDeps, relays: string[], keys: { id: string; pub: string }[], since: number): ListenerPid {
	return {
		pid: deps.pid,
		since,
		hook: deps.hook ? { argv: deps.hook.argv, timeoutS: Math.round(deps.hook.timeoutMs / 1000) } : null,
		relays,
		keys: keyFingerprint(keys),
	};
}

async function runClaimedListener(deps: ListenerDeps): Promise<void> {
	await ensureNumberKey(deps);
	let keys = (await loadAllKeys(deps)).keys;
	const contactRelays = readRelays(deps.db);
	const relays = subscriptionRelays(deps.db);
	const pool = deps.createPool();
	const since = deps.now();

	writeListenerPid(deps.paths, listenerPidRecord(deps, relays, keys, since));

	const hookRunner = deps.hook ? createHookRunner(deps.db, deps.hook, deps.schedule) : noopHookRunner();

	const startingSeen: Seen = { cursor: readCursor(deps.db), ids: [] };
	const caught = await fetchNew(pool, relays, keys, gateFor(deps.db), startingSeen, deps.now);
	const newContactByNpub = new Map(caught.newContacts.map((contact) => [contact.npub, contact]));
	const reacceptByNpub = new Map(caught.reaccepts.map((reaccept) => [reaccept.npub, reaccept]));
	for (const message of caught.messages) {
		admitMessage(
			deps.db,
			deps.now,
			contactRelays,
			message,
			message.call ? newContactByNpub.get(message.from) : undefined,
			reacceptByNpub.get(message.from),
		);
	}
	writeCursor(deps.db, caught.seen.cursor);

	await hookRunner.notify();
	await hookRunner.retryStuck();
	const cancelStuckRetry = repeat(deps.schedule, STUCK_RETRY_INTERVAL_MS, () => void hookRunner.retryStuck());

	let seen = caught.seen;
	const onLive = (message: Message, seenNow: Seen, _gate: unknown, extra: SubscribeExtra) => {
		seen = seenNow;
		admitMessage(deps.db, deps.now, contactRelays, message, extra.newContact, extra.reaccept);
		writeCursor(deps.db, seenNow.cursor);
		void hookRunner.notify();
	};
	let sub = subscribe(pool, relays, keys, () => gateFor(deps.db), seen, onLive, deps.now);
	let stopped = false;
	let watching = false;
	const watchKeys = () => {
		if (stopped || watching) return;
		watching = true;
		void (async () => {
			try {
				const loaded = await loadAllKeys(deps);
				if (stopped || loaded.unreadable.length > 0) return;
				const nextPrint = keyFingerprint(loaded.keys);
				if (nextPrint === keyFingerprint(keys)) return;
				sub.close();
				if (stopped) return;
				keys = loaded.keys;
				sub = subscribe(pool, relays, keys, () => gateFor(deps.db), seen, onLive, deps.now);
				writeListenerPid(deps.paths, listenerPidRecord(deps, relays, keys, since));
				notePhoneDrift(deps.db, `keys:${nextPrint}`, "key changed", deps.now());
			} catch {
			} finally {
				watching = false;
			}
		})();
	};
	const cancelWatch = repeat(deps.schedule, KEY_WATCH_INTERVAL_MS, watchKeys);

	return new Promise<void>((resolve) => {
		const shutdown = () => {
			stopped = true;
			sub.close();
			pool.close(relays);
			cancelStuckRetry();
			cancelWatch();
			hookRunner.stop();
			void hookRunner.settle().finally(() => {
				removeListenerPid(deps.paths);
				releaseListenerClaim(deps.paths, deps.pid);
				resolve();
			});
		};
		deps.onSignal("SIGTERM", shutdown);
		deps.onSignal("SIGINT", shutdown);
	});
}

/** Long enough for an in-flight `--on-message` to finish draining after SIGTERM. */
const REFRESH_WAIT_MS = 60_000;

function refreshSleep(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export type ListenerRefreshDeps = {
	isOurListener: (pid: number) => boolean;
	isAlive: (pid: number) => boolean;
	kill: (pid: number) => void;
	sleepSync: (ms: number) => void;
	spawn: (argv: string[], logPath: string) => number;
	now: () => number;
	argvFor: (extraArgs: string[]) => string[];
	/** Command line of the running listener, captured before it is stopped. */
	commandArgs?: (pid: number) => string[] | undefined;
	/** Restarts a systemd, launchd, or Task Scheduler listener instead of detaching a second one. */
	restartManaged?: (kind: AutostartKind) => void;
};

function defaultRefreshDeps(): ListenerRefreshDeps {
	return {
		isOurListener,
		isAlive,
		kill: (pid) => process.kill(pid, "SIGTERM"),
		sleepSync: refreshSleep,
		spawn: spawnDetachedListener,
		now: () => Math.floor(Date.now() / 1000),
		argvFor: (extraArgs) => selfCommand(["phone", "__run", ...extraArgs]),
	};
}

function hookArgs(hook: ListenerPid["hook"]): string[] {
	if (!hook) return [];
	return ["--on-message", ...hook.argv, "--on-message-timeout", String(hook.timeoutS)];
}

function managedKind(kind: string | undefined): AutostartKind | undefined {
	if (kind === "systemd" || kind === "launchd" || kind === "task") return kind;
	return undefined;
}

function restartManagedListener(kind: AutostartKind): void {
	const commands = managedRestartCommands(kind, process.getuid?.() ?? 0);
	for (let index = 0; index < commands.length; index += 1) {
		const [command, ...args] = commands[index] ?? [];
		const result = spawnSync(command ?? "", args, { encoding: "utf8" });
		const last = index === commands.length - 1;
		if (result.status !== 0 && (last || kind !== "task")) {
			const detail = (result.stderr || result.stdout || "").trim().split("\n")[0];
			throw new DgCliError(`could not restart the ${kind} phone listener${detail ? `: ${detail}` : ""}`);
		}
	}
}

function waitForExit(pid: number, deps: ListenerRefreshDeps): boolean {
	for (let waited = 0; deps.isAlive(pid) && waited < REFRESH_WAIT_MS; waited += 100) deps.sleepSync(100);
	return !deps.isAlive(pid);
}

/** When a live listener is not subscribed to every invite relay, stop it and start exactly one
 * replacement. A service-managed listener is restarted through that manager, so it stays supervised.
 * The wait covers a hook that is still draining. If the process never exits, this throws and does
 * not start a second listener. If a detached replacement fails to start, the command line captured
 * before the stop is started again. */
export function ensureListenerSubscribed(paths: DgPaths, db: PhoneDb, deps: ListenerRefreshDeps = defaultRefreshDeps()): void {
	const running = readListenerPid(paths);
	if (!running || !deps.isOurListener(running.pid)) return;
	// A pid file written before relays were recorded is not proof the process missed an invite.
	if (!running.relays) return;
	const wanted = subscriptionRelays(db);
	if (wanted.every((relay) => running.relays?.includes(relay))) return;

	const previous = (deps.commandArgs ?? listenerCommandArgs)(running.pid);
	const managed = managedKind(readListener(db)?.autostart?.kind);
	if (managed) {
		(deps.restartManaged ?? restartManagedListener)(managed);
		if (!waitForExit(running.pid, deps)) {
			throw new DgCliError(
				`the phone listener (pid ${running.pid}) did not exit; left the ${managed} service in place and did not start another`,
			);
		}
		return;
	}

	deps.kill(running.pid);
	if (!waitForExit(running.pid, deps)) {
		throw new DgCliError(`the phone listener (pid ${running.pid}) did not exit; no replacement was started`);
	}

	const nextArgv = deps.argvFor(hookArgs(running.hook));
	try {
		const pid = deps.spawn(nextArgv, listenerLogPath(paths));
		adoptListenerPid(paths, { pid, since: deps.now(), hook: running.hook, relays: wanted });
	} catch (err) {
		if (previous && previous.length > 0) {
			try {
				const pid = deps.spawn(previous, listenerLogPath(paths));
				adoptListenerPid(paths, {
					pid,
					since: deps.now(),
					hook: running.hook,
					relays: running.relays,
					...(running.adopted === "legacy" ? { adopted: "legacy" as const } : {}),
				});
			} catch {}
		}
		throw err instanceof DgCliError ? err : new DgCliError("the phone listener stopped and the replacement failed to start");
	}
}
