import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DgCliError } from "@dg/common";
import { type DgPaths, ensurePrivateDir, isAlive, selfCommand, writeFileAtomic } from "@dg/common/node";
import { fetchNew, type Message, type NewContact, type PhonePool, type Reaccept, type Seen, subscribe, UNKNOWN_CALLER_HANDLE } from "./chat";
import { createHookRunner, type Cancel, type HookRunner, type Schedule } from "./hook";
import { type KeyDeps, ensureNumberKey, loadAllKeys } from "./keys";
import type { PhoneDb } from "./db";
import type { CommandPushTarget } from "./push";
import {
	addContact,
	consumeInvite,
	findContactByNpub,
	gateFor,
	isHandle,
	nextFreeHandle,
	readCursor,
	readListener,
	readRelays,
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
};

export type ListenerGeneration = "current" | "legacy";

/** How often a message stuck at the attempt cap gets one fresh try, outside the listener's start-up retry. */
export const STUCK_RETRY_INTERVAL_MS = 30 * 60 * 1000;

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

export function listenerCommandArgs(pid: number): string[] | undefined {
	if (!isAlive(pid)) return undefined;
	const cmdline = `/proc/${pid}/cmdline`;
	if (existsSync(cmdline)) return readFileSync(cmdline, "utf8").split("\0");
	if (process.platform === "win32") {
		const query = `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`;
		const ps = spawnSync("powershell", ["-NoProfile", "-Command", query], { encoding: "utf8" });
		return ps.status === 0 ? ps.stdout.trim().split(/\s+/) : undefined;
	}
	const ps = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
	return ps.status === 0 ? ps.stdout.trim().split(/\s+/) : undefined;
}

/** Whether `pid` is alive and its command line is one of our listeners, not just a reused pid. */
export function isOurListener(pid: number): boolean {
	const args = listenerCommandArgs(pid);
	return args !== undefined && isListenerArgs(args);
}

/** `current` is already `phone __run`. `legacy` is the old `phone-friend __run` process. */
export function listenerGeneration(pid: number): ListenerGeneration | undefined {
	const args = listenerCommandArgs(pid);
	if (!args || !isListenerArgs(args)) return undefined;
	return args.includes("phone-friend") ? "legacy" : "current";
}

/** Undefined for no file, a parse failure, a pid that is not a safe positive integer, or a pid that is no longer alive. */
export function readListenerPid(paths: DgPaths): ListenerPid | undefined {
	const path = listenerPidPath(paths);
	if (!existsSync(path)) return undefined;
	try {
		const record = JSON.parse(readFileSync(path, "utf8")) as ListenerPid;
		if (!Number.isSafeInteger(record.pid) || record.pid <= 0) return undefined;
		if (!isAlive(record.pid)) return undefined;
		return {
			pid: record.pid,
			since: record.since,
			hook: record.hook,
			...(record.relays ? { relays: record.relays } : {}),
			...(record.adopted === "legacy" ? { adopted: "legacy" as const } : {}),
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

type ClaimView = { kind: "mine" | "held" | "stale"; holder: string };

function logClaim(message: string): void {
	process.stderr.write(`phone: ${message}\n`);
}

function readClaimRaw(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

/** `held` is a phone listener for this line, or a lock too new to judge. Anything else is stale. */
function inspectClaim(path: string, pid: number, ours: (pid: number) => boolean, now: number): ClaimView {
	let raw: string | undefined;
	let ageMs: number | undefined;
	try {
		raw = readFileSync(path, "utf8");
		ageMs = now - statSync(path).mtimeMs;
	} catch {
		try {
			ageMs = now - statSync(path).mtimeMs;
		} catch {
			return { kind: "stale", holder: "" };
		}
		if (ageMs < CLAIM_GRACE_MS) return { kind: "held", holder: "" };
		return { kind: "stale", holder: "" };
	}
	const holder = raw.trim();
	const parsed = Number(holder);
	if (parsed === pid) return { kind: "mine", holder };
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		if ((ageMs ?? CLAIM_GRACE_MS) < CLAIM_GRACE_MS) return { kind: "held", holder };
		return { kind: "stale", holder };
	}
	if (ours(parsed)) return { kind: "held", holder };
	return { kind: "stale", holder };
}

/**
 * Exclusive claim so a second `phone __run` exits instead of subscribing beside the first.
 * The lock file is linked into place already containing the pid, so a contender never sees an
 * empty file and deletes the winner. Only a pid whose command line is a phone listener keeps
 * the slot. A dead pid, or a live pid reused by something else after an unclean exit, is taken
 * over. Losing the claim is logged: a clean exit would otherwise leave systemd and launchd
 * with nothing to restart.
 */
export function claimListener(paths: DgPaths, pid: number, ours: (holder: number) => boolean = isOurListener): boolean {
	ensurePrivateDir(paths.phoneRoot);
	const path = listenerClaimPath(paths);
	const tmp = `${path}.${pid}.claim`;
	writeFileSync(tmp, String(pid), { mode: 0o600 });
	let announcedTakeover = false;
	try {
		for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
			try {
				linkSync(tmp, path);
				return true;
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			}
			const seen = inspectClaim(path, pid, ours, Date.now());
			if (seen.kind === "mine") return true;
			if (seen.kind === "held") {
				logClaim(`listener claim lost to ${seen.holder || "an unreadable lock"}; pid ${pid} is exiting`);
				return false;
			}
			const before = readClaimRaw(path);
			const again = inspectClaim(path, pid, ours, Date.now());
			if (again.kind === "mine") return true;
			if (again.kind === "held") {
				logClaim(`listener claim lost to ${again.holder || "an unreadable lock"}; pid ${pid} is exiting`);
				return false;
			}
			if (readClaimRaw(path) !== before) continue;
			if (!announcedTakeover) {
				logClaim(`listener lock held by ${again.holder || "an empty file"} is not a live phone listener; taking over`);
				announcedTakeover = true;
			}
			rmSync(path, { force: true });
		}
	} finally {
		rmSync(tmp, { force: true });
	}
	logClaim(`listener claim lost; pid ${pid} is exiting`);
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
	writeFileAtomic(listenerPidPath(paths), JSON.stringify(record));
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
		addContact(db, { npub: newContact.npub, handle, relays, keyId: newContact.keyId, addedAt: now(), via: newContact.via });
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

async function runClaimedListener(deps: ListenerDeps): Promise<void> {
	await ensureNumberKey(deps);
	const keys = await loadAllKeys(deps);
	const contactRelays = readRelays(deps.db);
	const relays = subscriptionRelays(deps.db);
	const pool = deps.createPool();

	writeListenerPid(deps.paths, {
		pid: deps.pid,
		since: deps.now(),
		hook: deps.hook ? { argv: deps.hook.argv, timeoutS: Math.round(deps.hook.timeoutMs / 1000) } : null,
		relays,
	});

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

	const sub = subscribe(
		pool,
		relays,
		keys,
		() => gateFor(deps.db),
		caught.seen,
		(message, seenNow, _gate, extra) => {
			admitMessage(deps.db, deps.now, contactRelays, message, extra.newContact, extra.reaccept);
			writeCursor(deps.db, seenNow.cursor);
			void hookRunner.notify();
		},
		deps.now,
	);

	return new Promise<void>((resolve) => {
		const shutdown = () => {
			sub.close();
			pool.close(relays);
			cancelStuckRetry();
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
