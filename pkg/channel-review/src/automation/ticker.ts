import { describeError } from "@dg/common";
import type { Log } from "../engine";
import { abortableSleep, type Sleep } from "../providers/teams-relay/sleep";

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 30 * 60_000;

export type TickerOptions = {
	name: string;
	intervalMs: number;
	tick(signal: AbortSignal): Promise<void>;
	signal: AbortSignal;
	log: Log;
	sleep?: Sleep;
};

export function backoffMs(failures: number): number {
	return Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_CAP_MS);
}

export async function runTicker({
	name,
	intervalMs,
	tick,
	signal,
	log,
	sleep = abortableSleep,
}: TickerOptions): Promise<void> {
	let failures = 0;
	while (!signal.aborted) {
		try {
			await tick(signal);
			failures = 0;
		} catch (error) {
			if (signal.aborted) return;
			failures += 1;
			const delay = backoffMs(failures);
			log.warn(
				`${name} tick failed (${failures}): ${describeError(error)}; retrying in ${delay} ms`,
			);
			await sleep(delay, signal);
			continue;
		}
		await sleep(intervalMs, signal);
	}
}
