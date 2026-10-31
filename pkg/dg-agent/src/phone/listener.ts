import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, linkSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { DgCliError } from "@dg/common";
import { type DgPaths, ensurePrivateDir, isAlive, writeFileAtomic } from "@dg/common/node";
import { nip19 } from "nostr-tools";
import { DG_AGENT_PACKAGE_VERSION } from "../version";
import {
	addBounded,
	type DroppedRing,
	fetchNew,
	type Gate,
	type KeyEntry,
	type HeldThread,
	type Message,
	type NewContact,
	type PhonePool,
	type Reaccept,
	type Seen,
	capIds,
	STRANGER_ID_LIMIT,
	type SubscribeExtra,
	type SubscribeHooks,
	publish,
	subscribe,
	UNKNOWN_CALLER_HANDLE,
	wrapProbe,
} from "./chat";
import { resolvePublishConfirmMs, PUBLISH_CONFIRM_ENV } from "./delivery";
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
	numberKeyId,
	readAdmissionEpoch,
	readNumber,
	readCursor,
	readPublishConfirmSetting,
	readRelays,
	notePhoneDrift,
	setContactKeyId,
	subscriptionRelays,
	writeCursor,
} from "./store";
import { dedupeHandle, pendingNotice, threadDirection, threadHandleBody } from "./thread";

export type ListenerDeps = KeyDeps & {
	createPool: () => PhonePool & { close(relays: string[]): void };
	now: () => number;
	pid: number;
	hook?: CommandPushTarget;
	schedule: Schedule;
	onSignal: (signal: "SIGTERM" | "SIGINT", handler: () => void) => void;
	/** Overrides the jittered probe. Tests pass a short confirm and wait so the check stays fast. */
	liveness?: LivenessConfig;
};

/** Rumor content of the self-addressed liveness probe. Logged nowhere. Not a user message. */
export { PROBE_TOPIC as LISTENER_PROBE_TEXT } from "./chat";

/** Lower bound of the jittered liveness gap. */
export const LIVENESS_MIN_MS = 2 * 60 * 1000;
/** Upper bound of the jittered liveness gap. `livenessDelayMs(1)` lands here. */
export const LIVENESS_MAX_MS = 5 * 60 * 1000;
/** How long a healthy subscription is given to deliver the probe after publish returns. */
export const LIVENESS_PROBE_WAIT_MS = 3_000;

export type LivenessConfig = {
	minMs: number;
	maxMs: number;
	confirmMs: number;
	waitMs: number;
	/** Returns a unit interval. `0` schedules the minimum gap and `1` the maximum. */
	random: () => number;
};

/** Gap until the next liveness check. `random` is clamped to 0..1 so a bad source cannot schedule a negative delay. */
export function livenessDelayMs(random: number, min = LIVENESS_MIN_MS, max = LIVENESS_MAX_MS): number {
	const unit = Math.min(1, Math.max(0, random));
	return min + Math.round(unit * (max - min));
}

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
	/** `id` and `pub` of those keys. Missing on a pid file written before this was recorded. */
	keyPubs?: ListenerKeyPub[];
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
	/** A store read failed. On its own this is not a reason to restart. */
	keysUnreadable?: boolean;
};

/** Public keys this process subscribed to. Lets a later check see which key changed when another cannot be read. */
export type ListenerKeyPub = { id: string; pub: string };

function listenerKeyPubs(keys: { id: string; pub: string }[]): ListenerKeyPub[] {
	return keys.map((key) => ({ id: key.id, pub: key.pub })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function readKeyPubs(value: unknown): ListenerKeyPub[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const pubs: ListenerKeyPub[] = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object") return undefined;
		const id = (entry as { id?: unknown }).id;
		const pub = (entry as { pub?: unknown }).pub;
		if (typeof id !== "string" || id.length === 0 || typeof pub !== "string" || pub.length === 0) return undefined;
		pubs.push({ id, pub });
	}
	return pubs;
}

/** True when a key this process can read is new, gone, or has a different pub than `recorded`. */
function readableKeysChanged(recorded: ListenerKeyPub[], loaded: { keys: { id: string; pub: string }[]; unreadable: string[] }): boolean {
	const unread = new Set(loaded.unreadable);
	const recordedById = new Map(recorded.map((key) => [key.id, key.pub]));
	for (const key of loaded.keys) {
		if (recordedById.get(key.id) !== key.pub) return true;
	}
	for (const key of recorded) {
		if (unread.has(key.id)) continue;
		if (!loaded.keys.some((loadedKey) => loadedKey.id === key.id)) return true;
	}
	return false;
}

/** Keeps the last subscribed secret for an id whose store read failed, and takes the fresh copy of every id that loaded. */
function mergeHeldKeys(loaded: { keys: KeyEntry[]; unreadable: string[] }, held: KeyEntry[]): KeyEntry[] {
	const heldById = new Map(held.map((key) => [key.id, key]));
	const merged = [...loaded.keys];
	for (const id of loaded.unreadable) {
		const previous = heldById.get(id);
		if (previous) merged.push(previous);
	}
	return merged;
}

/** "a key became readable" only when every added id had failed a store read and no subscribed pub changed. */
function subscriptionNotice(previous: { id: string; pub: string }[], next: { id: string; pub: string }[], previouslyUnreadable: ReadonlySet<string>): string {
	const previousById = new Map(previous.map((key) => [key.id, key.pub]));
	const nextIds = new Set(next.map((key) => key.id));
	const removed = previous.some((key) => !nextIds.has(key.id));
	const pubChanged = next.some((key) => {
		const before = previousById.get(key.id);
		return before !== undefined && before !== key.pub;
	});
	const added = next.filter((key) => !previousById.has(key.id));
	if (!removed && !pubChanged && added.length > 0 && added.every((key) => previouslyUnreadable.has(key.id))) return "a key became readable";
	return "key changed";
}

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
	if (loaded.unreadable.length > 0) {
		const recorded = record.keyPubs;
		if (recorded && readableKeysChanged(recorded, loaded)) {
			const held = recorded.filter((key) => loaded.unreadable.includes(key.id));
			const fingerprint = keyFingerprint([...loaded.keys, ...held]);
			if (record.keys === undefined || record.keys !== fingerprint) {
				return {
					restart: true,
					reason: "listener keys differ from the database",
					token: `keys:${fingerprint}`,
					notice: "key changed",
					keysUnreadable: true,
				};
			}
		}
		return { restart: false, keysUnreadable: true };
	}
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
		const keyPubs = readKeyPubs(record.keyPubs);
		return {
			pid: record.pid,
			since: record.since,
			hook: record.hook,
			...(record.relays ? { relays: record.relays } : {}),
			...(record.adopted === "legacy" ? { adopted: "legacy" as const } : {}),
			...(typeof record.version === "string" ? { version: record.version } : {}),
			...(typeof record.keys === "string" ? { keys: record.keys } : {}),
			...(keyPubs ? { keyPubs } : {}),
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

/** One stderr line for a wrap the listener did not store. The pubkey is a short prefix, never a secret. */
export function formatDroppedRing(drop: DroppedRing): string {
	return `phone: dropped ${drop.pubkeyPrefix ?? "unknown"}: ${drop.reason}\n`;
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

/** Points `listener.pid` at a process that is already running, so nothing else starts a second one. A child that has already exited is not recorded. */
export function adoptListenerPid(paths: DgPaths, record: ListenerPid, alive: (pid: number) => boolean = isAlive): void {
	if (!alive(record.pid)) return;
	writeListenerPid(paths, record);
}

/** Ignores SIGHUP so a listener started in its own session survives the login shell that spawned it. */
export function ignoreHangup(): void {
	process.on("SIGHUP", () => {});
}

/** Detached listener process. `detached` calls setsid, so the child is its own session. It writes `listener.pid` once `phone __run` is up. */
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

/** Like `repeat`, but each gap comes from `delayMs` and the next gap waits until `run` settles. */
function repeatJitter(schedule: Schedule, delayMs: () => number, run: () => Promise<void> | void): Cancel {
	let cancel: Cancel = () => {};
	let off = false;
	const arm = () => {
		if (off) return;
		cancel = schedule(delayMs(), () => {
			void Promise.resolve(run()).finally(arm);
		});
	};
	arm();
	return () => {
		off = true;
		cancel();
	};
}

function logListener(kind: "heartbeat" | "resubscribe" | "probe-failed"): void {
	process.stderr.write(`phone: listener ${kind}\n`);
}

export type WaitClock = { now: () => number; sleep: (ms: number) => Promise<void> };

const wallClock: WaitClock = {
	now: () => Date.now(),
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Resolves true once `id` is in `seen`, or false when `waitMs` elapses. `waitMs <= 0` does not sleep. */
export async function waitForId(seen: Set<string>, id: string, waitMs: number, clock: WaitClock = wallClock): Promise<boolean> {
	if (seen.has(id)) return true;
	if (waitMs <= 0) return false;
	const started = clock.now();
	do {
		await clock.sleep(Math.min(10, waitMs));
		if (seen.has(id)) return true;
	} while (clock.now() - started < waitMs);
	return false;
}

type AdmitStore = "stored" | "duplicate" | "rejected";

/** Applies one admitted message's side effects: a fresh handle and contact row for a new caller, the
 * key move for a re-accept, then the message itself, `contact` keyed by the sender (as `fetchNew`'s
 * wiring contract requires). Guarded by `findContactByNpub` so a caught-up follow-up from the same
 * new caller, or a redelivered live event, never renames the contact it already created. A new caller
 * holding an invite is stored only when this call consumes that invite, so a snapshot that is stale
 * by the time it lands cannot admit a second caller. A row that is already stored is a duplicate:
 * the key is not moved again. `rejected` is the only result that blocks later messages from that sender. */
function ownNpubsOf(keys: readonly { pub: string }[]): string[] {
	return keys.map((key) => nip19.npubEncode(key.pub));
}

/** Stores a held thread once. The notice names the room, never the message body. */
function holdThread(db: PhoneDb, now: () => number, held: HeldThread): void {
	const inserted = db.insertPending({
		rumor_id: held.rumorId,
		room_id: held.roomId,
		sender: held.senderNpub,
		members: JSON.stringify(held.memberNpubs),
		subject: held.subject,
		text: held.text,
		ts: held.ts,
	});
	if (!inserted || db.roomNoticed(held.roomId)) return;
	db.markRoomNoticed(held.roomId);
	const notice = pendingNotice(held.roomId);
	addPhoneNotice(db, notice, now());
	process.stderr.write(`phone: ${notice}\n`);
}

function membersStillKnown(db: PhoneDb, npubs: readonly string[], ownNpubs: readonly string[]): boolean {
	return npubs.every((npub) => ownNpubs.includes(npub) || findContactByNpub(db, npub) !== undefined);
}

function admitMessage(
	db: PhoneDb,
	now: () => number,
	relays: string[],
	message: Message,
	ownNpubs: readonly string[],
	newContact?: NewContact,
	reaccept?: Reaccept,
): AdmitStore {
	return db.transaction(() => {
		if (message.thread) {
			if (!membersStillKnown(db, message.thread.memberNpubs, ownNpubs)) {
				holdThread(db, now, {
					rumorId: message.id,
					roomId: message.thread.roomId,
					senderNpub: message.from,
					memberNpubs: message.thread.memberNpubs,
					subject: message.thread.subject,
					text: message.text,
					ts: message.ts,
				});
				return "duplicate";
			}
			if (!db.getThread(message.thread.roomId)) {
				const handle = dedupeHandle(threadHandleBody(message.thread.subject, message.thread.roomId), (candidate) =>
					db.getThreadByHandle(candidate) !== undefined,
				);
				db.insertThread({
					id: message.thread.roomId,
					handle,
					subject: message.thread.subject ?? "",
					key_id: message.thread.keyId,
					created_at: now(),
					via: "admit",
				});
				for (const npub of message.thread.memberNpubs) db.insertThreadMember(message.thread.roomId, npub);
			}
			const inserted = db.addMessage({
				id: message.id,
				direction: threadDirection(message.from, ownNpubs),
				ts: message.ts,
				sender: message.from,
				contact: message.from,
				text: message.text,
				call: 0,
				thread_id: message.thread.roomId,
			});
			return inserted ? "stored" : "duplicate";
		}
		if (newContact && !findContactByNpub(db, newContact.npub)) {
			if (newContact.numberSecret !== undefined && readNumber(db)?.secret !== newContact.numberSecret) return "rejected";
			if (newContact.inviteSecret && !consumeInvite(db, newContact.inviteSecret)) return "rejected";
			const base = isHandle(newContact.suggestedHandle) ? newContact.suggestedHandle : UNKNOWN_CALLER_HANDLE;
			const handle = nextFreeHandle(db, base);
			const contactRelays = newContact.relays?.length ? newContact.relays : relays;
			addContact(db, { npub: newContact.npub, handle, relays: contactRelays, keyId: newContact.keyId, addedAt: now(), via: newContact.via });
			addPhoneNotice(db, `new contact +${handle}`, now());
		}
		if (!findContactByNpub(db, message.from)) return "rejected";
		const inserted = db.addMessage({
			id: message.id,
			direction: "in",
			ts: message.ts,
			sender: message.from,
			contact: message.from,
			text: message.text,
			call: message.call ? 1 : 0,
		});
		if (!inserted) return "duplicate";
		if (reaccept) setContactKeyId(db, reaccept.npub, reaccept.keyId);
		return "stored";
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
		keyPubs: listenerKeyPubs(keys),
	};
}

async function runClaimedListener(deps: ListenerDeps): Promise<void> {
	await ensureNumberKey(deps);
	const initialKeys = await loadAllKeys(deps);
	let keys = initialKeys.keys;
	let unreadBefore = new Set(initialKeys.unreadable);
	let relays = subscriptionRelays(deps.db);
	const pool = deps.createPool();
	const since = deps.now();
	let epoch = readAdmissionEpoch(deps.db);
	let replayedEpoch = epoch;
	let gateCache: Gate = gateFor(deps.db);
	const loggedDrops = new Set<string>();
	const deliveredIds = new Set<string>();
	const liveness: LivenessConfig = deps.liveness ?? {
		minMs: LIVENESS_MIN_MS,
		maxMs: LIVENESS_MAX_MS,
		confirmMs: resolvePublishConfirmMs(process.env[PUBLISH_CONFIRM_ENV], readPublishConfirmSetting(deps.db)),
		waitMs: LIVENESS_PROBE_WAIT_MS,
		random: Math.random,
	};

	writeListenerPid(deps.paths, listenerPidRecord(deps, relays, keys, since));

	const hookRunner = deps.hook ? createHookRunner(deps.db, deps.hook, deps.schedule) : noopHookRunner();

	const logDrop = (drop: DroppedRing) => {
		if (loggedDrops.has(drop.id)) return;
		addBounded(loggedDrops, drop.id, STRANGER_ID_LIMIT);
		process.stderr.write(formatDroppedRing(drop));
	};

	const rememberAdmission = () => {
		epoch = readAdmissionEpoch(deps.db);
		gateCache = gateFor(deps.db);
	};

	const applyCaught = (caught: Awaited<ReturnType<typeof fetchNew>>) => {
		const newContactByNpub = new Map(caught.newContacts.map((contact) => [contact.npub, contact]));
		const refused = new Set<string>();
		const ownNpubs = ownNpubsOf(keys);
		for (const held of caught.held) holdThread(deps.db, deps.now, held);
		for (const message of caught.messages) {
			if (message.thread) {
				admitMessage(deps.db, deps.now, readRelays(deps.db), message, ownNpubs);
				continue;
			}
			if (refused.has(message.from)) continue;
			const stored = admitMessage(
				deps.db,
				deps.now,
				readRelays(deps.db),
				message,
				ownNpubs,
				message.call ? newContactByNpub.get(message.from) : undefined,
				caught.reacceptByMessageId.get(message.id),
			);
			if (stored === "rejected") refused.add(message.from);
		}
		return caught.seen;
	};

	const startingSeen: Seen = { cursor: readCursor(deps.db), ids: [] };
	let seen = applyCaught(await fetchNew(pool, relays, keys, gateCache, startingSeen, deps.now, logDrop));
	rememberAdmission();
	writeCursor(deps.db, seen.cursor);

	await hookRunner.notify();
	await hookRunner.retryStuck();
	const cancelStuckRetry = repeat(deps.schedule, STUCK_RETRY_INTERVAL_MS, () => void hookRunner.retryStuck());

	const onLive = (message: Message, seenNow: Seen, _gate: unknown, extra: SubscribeExtra) => {
		seen = seenNow;
		admitMessage(deps.db, deps.now, readRelays(deps.db), message, ownNpubsOf(keys), extra.newContact, extra.reaccept);
		rememberAdmission();
		writeCursor(deps.db, seenNow.cursor);
		void hookRunner.notify();
	};
	const cachedGate = (): Gate => {
		const next = readAdmissionEpoch(deps.db);
		if (next !== epoch) rememberAdmission();
		return gateCache;
	};
	const rereadGate = (): Gate => {
		rememberAdmission();
		return gateCache;
	};
	const hooks: SubscribeHooks = {
		onHeld: (held) => holdThread(deps.db, deps.now, held),
		reread: rereadGate,
		onDrop: logDrop,
		onEvent: (id) => addBounded(deliveredIds, id, STRANGER_ID_LIMIT),
	};
	const openSub = () => subscribe(pool, relays, keys, cachedGate, seen, onLive, deps.now, hooks);
	const catchUp = async (target: string[]) => {
		const caught = await fetchNew(pool, target, keys, gateFor(deps.db), seen, deps.now, logDrop);
		if (stopped) return;
		const caughtSeen = applyCaught(caught);
		seen = {
			cursor: Math.max(caughtSeen.cursor, seen.cursor),
			ids: capIds([...new Set([...caughtSeen.ids, ...seen.ids])], STRANGER_ID_LIMIT),
		};
		writeCursor(deps.db, seen.cursor);
		void hookRunner.notify();
		// The live subscription captured `seen` when it opened. Reopen it so a replay cannot
		// apply a caught-up ring again, which would move a contact back to an older key.
		sub.close();
		if (stopped) return;
		sub = openSub();
	};
	let sub = openSub();
	let stopped = false;
	let watching = false;
	const sameList = (left: string[], right: string[]) => left.length === right.length && left.every((item, index) => item === right[index]);
	const watchAdmission = async () => {
		const nextEpoch = readAdmissionEpoch(deps.db);
		const wanted = subscriptionRelays(deps.db);
		if (nextEpoch === replayedEpoch && sameList(wanted, relays)) return;
		const caught = await fetchNew(pool, wanted, keys, gateFor(deps.db), seen, deps.now, logDrop);
		if (stopped) return;
		const caughtSeen = applyCaught(caught);
		seen = { cursor: Math.max(caughtSeen.cursor, seen.cursor), ids: capIds([...new Set([...caughtSeen.ids, ...seen.ids])], STRANGER_ID_LIMIT) };
		replayedEpoch = nextEpoch;
		rememberAdmission();
		writeCursor(deps.db, seen.cursor);
		void hookRunner.notify();
		const dropped = relays.filter((relay) => !wanted.includes(relay));
		relays = wanted;
		sub.close();
		pool.close(dropped);
		if (stopped) return;
		sub = openSub();
		await catchUp(relays);
		if (stopped) return;
		writeListenerPid(deps.paths, listenerPidRecord(deps, relays, keys, since));
	};
	const watchKeys = () => {
		if (stopped || watching) return;
		watching = true;
		void (async () => {
			try {
				const loaded = await loadAllKeys(deps);
				if (stopped) return;
				const merged = mergeHeldKeys(loaded, keys);
				const nextPrint = keyFingerprint(merged);
				if (nextPrint !== keyFingerprint(keys)) {
					const notice = subscriptionNotice(keys, merged, unreadBefore);
					unreadBefore = new Set(loaded.unreadable);
					sub.close();
					if (stopped) return;
					keys = merged;
					sub = openSub();
					writeListenerPid(deps.paths, listenerPidRecord(deps, relays, keys, since));
					notePhoneDrift(deps.db, `keys:${nextPrint}`, notice, deps.now());
					try {
						await catchUp(relays);
					} catch {
						// A fetch error must not skip the notice or the pid rewrite above.
					}
				} else {
					unreadBefore = new Set(loaded.unreadable);
				}
				if (!stopped) await watchAdmission();
			} catch {
			} finally {
				watching = false;
			}
		})();
	};
	const cancelWatch = repeat(deps.schedule, KEY_WATCH_INTERVAL_MS, watchKeys);
	let probeCursor = 0;
	const checkLiveness = async () => {
		if (stopped || watching) return;
		watching = true;
		try {
			const probeKey = keys.find((key) => key.id === numberKeyId(deps.db)) ?? keys[0];
			if (!probeKey || relays.length === 0) {
				logListener("probe-failed");
				return;
			}
			const relay = relays[probeCursor % relays.length]!;
			probeCursor += 1;
			const probe = wrapProbe(probeKey.sk, probeKey.pub);
			const report = await publish(pool, [relay], probe, { confirmMs: liveness.confirmMs, confirmById: false });
			const saw = await waitForId(deliveredIds, probe.id, liveness.waitMs);
			if (stopped) return;
			const owed = report.ok.length > 0 || report.unconfirmed.length > 0;
			if (owed && !saw) {
				logListener("resubscribe");
				sub.close();
				pool.close(relays);
				if (stopped) return;
				sub = openSub();
				await catchUp(relays);
				if (stopped) return;
				writeListenerPid(deps.paths, listenerPidRecord(deps, relays, keys, since));
			} else if (owed) {
				logListener("heartbeat");
			} else {
				logListener("probe-failed");
			}
		} catch {
			if (!stopped) logListener("probe-failed");
		} finally {
			watching = false;
		}
	};
	const cancelLiveness = repeatJitter(deps.schedule, () => livenessDelayMs(liveness.random(), liveness.minMs, liveness.maxMs), checkLiveness);

	return new Promise<void>((resolve) => {
		const shutdown = () => {
			stopped = true;
			sub.close();
			pool.close(relays);
			cancelStuckRetry();
			cancelWatch();
			cancelLiveness();
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
