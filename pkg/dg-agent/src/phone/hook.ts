import { runCaptureBytes } from "@dg/common/node";
import type { MessageRow, PhoneDb } from "./db";
import { ON_MESSAGE_MAX_ATTEMPTS, type CommandPushTarget, nextOnMessageRetryDelayMs, onMessagePayload } from "./push";
import { findContactByNpub } from "./store";

export type Cancel = () => void;
export type Schedule = (delayMs: number, run: () => void) => Cancel;

export type HookRunner = {
	/** A message just arrived or is due a retry; runs a delivery pass unless one is already in flight.
	 * The caller is never required to await this: it is safe to call from a synchronous event handler. */
	notify: () => Promise<void>;
	/** One fresh attempt at every row stuck at the attempt cap; call on listener start and every 30 minutes. */
	retryStuck: () => Promise<void>;
	/** Cancels any pending backoff timer; does not touch an attempt already in flight. */
	stop: () => void;
	/** The most recently started pass, whether still running or already settled. A fake `Schedule` in
	 * tests fires a backoff timer synchronously; await this afterward to know that retry has finished. */
	settle: () => Promise<void>;
};

function payloadFor(db: PhoneDb, row: MessageRow): string {
	const contact = findContactByNpub(db, row.contact);
	return onMessagePayload(
		{ id: row.id, ts: row.ts, from: row.sender, text: row.text, ...(row.call ? { call: true as const } : {}) },
		contact?.handle ?? "",
	);
}

/** Runs the `--on-message` command once; any non-zero exit, signal, or spawn error counts as a failure. */
async function deliverOnce(target: CommandPushTarget, db: PhoneDb, row: MessageRow): Promise<boolean> {
	try {
		const result = await runCaptureBytes(target.argv[0], target.argv.slice(1), {
			stdin: payloadFor(db, row),
			timeoutMs: target.timeoutMs,
		});
		return result.status === 0;
	} catch {
		return false;
	}
}

/**
 * One stateful delivery queue per listener run. A pass walks unread rows under the attempt cap,
 * oldest first; a failure schedules a backoff retry of that same row and stops the pass, so one bad
 * message blocks only the rows behind it, never the ones ahead of it that already delivered. A row
 * that reaches the cap is skipped for the rest of this run and left for `retryStuck`.
 */
export function createHookRunner(db: PhoneDb, target: CommandPushTarget, schedule: Schedule): HookRunner {
	let inFlight = false;
	let passAgain = false;
	let stuckAgain = false;
	let stopped = false;
	let cancelRetry: Cancel | undefined;
	let current: Promise<void> = Promise.resolve();

	/** The only place `current` is reassigned, and only once this call actually takes the lock: a
	 * coalesced or post-stop call must never overwrite it with an already-settled stand-in, or
	 * `settle()` would resolve while the pass that is really running is still in flight. */
	function start(run: () => Promise<void>, kind: "pass" | "stuck"): Promise<void> {
		if (stopped) return Promise.resolve();
		if (kind === "pass" && cancelRetry) {
			passAgain = true;
			return current;
		}
		if (inFlight) {
			if (kind === "pass") passAgain = true;
			else stuckAgain = true;
			return current;
		}
		inFlight = true;
		current = run();
		return current;
	}

	/** A coalesced `retryStuck()` is folded in right after a coalesced `notify()`, never dropped.
	 * A pass stays paused while a backoff timer is pending, so a new message cannot skip that wait. */
	function resumeIfAskedAgain(): void {
		inFlight = false;
		if (cancelRetry) return;
		const again = passAgain;
		passAgain = false;
		if (again) {
			start(pass, "pass");
			return;
		}
		const retryAgain = stuckAgain;
		stuckAgain = false;
		if (retryAgain) start(stuckPass, "stuck");
	}

	function armRetry(delayMs: number): void {
		cancelRetry?.();
		cancelRetry = schedule(delayMs, () => {
			cancelRetry = undefined;
			passAgain = false;
			start(pass, "pass");
		});
	}

	async function pass(): Promise<void> {
		try {
			for (;;) {
				const row = db.nextDeliverable(ON_MESSAGE_MAX_ATTEMPTS);
				if (!row) return;
				if (await deliverOnce(target, db, row)) {
					db.markRead([row.id]);
					continue;
				}
				const attempts = db.bumpAttempts(row.id);
				if (attempts >= ON_MESSAGE_MAX_ATTEMPTS) continue;
				if (stopped) return;
				armRetry(nextOnMessageRetryDelayMs(attempts - 1));
				return;
			}
		} finally {
			resumeIfAskedAgain();
		}
	}

	async function stuckPass(): Promise<void> {
		try {
			for (const row of db.stuckMessages(ON_MESSAGE_MAX_ATTEMPTS)) {
				if (await deliverOnce(target, db, row)) db.markRead([row.id]);
				else db.bumpAttempts(row.id);
			}
		} finally {
			resumeIfAskedAgain();
		}
	}

	return {
		notify: () => start(pass, "pass"),
		retryStuck: () => start(stuckPass, "stuck"),
		stop: () => {
			stopped = true;
			cancelRetry?.();
			cancelRetry = undefined;
		},
		settle: () => current,
	};
}
