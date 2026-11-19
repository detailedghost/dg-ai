import type { Subprocess } from "bun";

const GRACE_MS = 3000;
const SETTLE_MS = 5000;
const live = new Set<Subprocess>();

/** Registers a child so the file-end guard and `killTrackedChildren` can find it. */
export function trackChild<T extends Subprocess>(proc: T): T {
	live.add(proc);
	void proc.exited.then(() => live.delete(proc));
	return proc;
}

/** Gives children already told to stop time to exit, then returns how many still run. */
export async function settleChildren(waitMs = SETTLE_MS): Promise<number> {
	const deadline = Date.now() + waitMs;
	while (live.size > 0 && Date.now() < deadline) await Bun.sleep(50);
	return live.size;
}

/** Asks each tracked child to stop, kills the stragglers, and returns how many were still alive. */
export async function killTrackedChildren(graceMs = GRACE_MS): Promise<number> {
	const procs = [...live];
	for (const proc of procs) proc.kill("SIGTERM");
	const timer = setTimeout(() => {
		for (const proc of procs) proc.kill("SIGKILL");
	}, graceMs);
	await Promise.all(procs.map((proc) => proc.exited));
	clearTimeout(timer);
	return procs.length;
}
