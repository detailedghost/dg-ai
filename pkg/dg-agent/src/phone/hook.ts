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
	let runAgain = false;
	let stopped = false;
	let cancelRetry: Cancel | undefined;
	let current: Promise<void> = Promise.resolve();

	function start(run: () => Promise<void>): Promise<void> {
		current = run();
		return current;
	}

	function resumeIfAskedAgain(): void {
		inFlight = false;
		const again = runAgain;
		runAgain = false;
		if (again && !stopped) start(pass);
	}

	async function pass(): Promise<void> {
		if (stopped) return;
		if (inFlight) {
			runAgain = true;
			return;
		}
		inFlight = true;
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
				cancelRetry = schedule(nextOnMessageRetryDelayMs(attempts - 1), () => {
					cancelRetry = undefined;
					start(pass);
				});
				return;
			}
		} finally {
			resumeIfAskedAgain();
		}
	}

	async function stuckPass(): Promise<void> {
		if (stopped) return;
		if (inFlight) {
			runAgain = true;
			return;
		}
		inFlight = true;
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
		notify: () => start(pass),
		retryStuck: () => start(stuckPass),
		stop: () => {
			stopped = true;
			cancelRetry?.();
			cancelRetry = undefined;
		},
		settle: () => current,
	};
}
