import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type DgPaths, ensurePrivateDir, isAlive, writeFileAtomic } from "@dg/common/node";
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
	readRelays,
	setContactKeyId,
	writeCursor,
} from "./store";

export type ListenerDeps = KeyDeps & {
	createPool: () => PhonePool & { close(relays: string[]): void };
	now: () => number;
	pid: number;
	hook?: CommandPushTarget;
	schedule: Schedule;
	onSignal: (signal: "SIGTERM" | "SIGINT", handler: () => void) => void;
};

export type ListenerPid = { pid: number; since: number; hook: { argv: string[]; timeoutS: number } | null };

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

/** Whether `pid` is alive and its command line is one of our listeners, not just a reused pid. */
export function isOurListener(pid: number): boolean {
	if (!isAlive(pid)) return false;
	const cmdline = `/proc/${pid}/cmdline`;
	if (existsSync(cmdline)) return isListenerArgs(readFileSync(cmdline, "utf8").split("\0"));
	if (process.platform === "win32") {
		const query = `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`;
		const ps = spawnSync("powershell", ["-NoProfile", "-Command", query], { encoding: "utf8" });
		return ps.status === 0 && isListenerArgs(ps.stdout.trim().split(/\s+/));
	}
	const ps = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
	return ps.status === 0 && isListenerArgs(ps.stdout.trim().split(/\s+/));
}

/** Undefined for no file, a parse failure, a pid that is not a safe positive integer, or a pid that is no longer alive. */
export function readListenerPid(paths: DgPaths): ListenerPid | undefined {
	const path = listenerPidPath(paths);
	if (!existsSync(path)) return undefined;
	try {
		const record = JSON.parse(readFileSync(path, "utf8")) as ListenerPid;
		if (!Number.isSafeInteger(record.pid) || record.pid <= 0) return undefined;
		return isAlive(record.pid) ? record : undefined;
	} catch {
		return undefined;
	}
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
	await ensureNumberKey(deps);
	const keys = await loadAllKeys(deps);
	const relays = readRelays(deps.db);
	const pool = deps.createPool();

	writeListenerPid(deps.paths, {
		pid: deps.pid,
		since: deps.now(),
		hook: deps.hook ? { argv: deps.hook.argv, timeoutS: Math.round(deps.hook.timeoutMs / 1000) } : null,
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
			relays,
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
			admitMessage(deps.db, deps.now, relays, message, extra.newContact, extra.reaccept);
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
				resolve();
			});
		};
		deps.onSignal("SIGTERM", shutdown);
		deps.onSignal("SIGINT", shutdown);
	});
}
