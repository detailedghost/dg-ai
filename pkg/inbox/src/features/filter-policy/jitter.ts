export type Rng = () => number;

export type Clock = {
	now(): number;
	sleep(ms: number): Promise<void>;
};

export type PaceClass = "rate-limit" | "transient" | "stop";

const rateLimitRetries = 2;
const transientRetries = 1;

export function nextGapMs(rng: Rng, previous: number[] = []): number {
	const roll = rng();
	const span = rng();
	const gap =
		roll > 0.9
			? 3200 + Math.round(span * span * 5000)
			: roll > 0.62
				? 1100 + Math.round(span * 1900)
				: 320 + Math.round(span * span * span * 1500);
	return adjustGap(gap, previous, rng);
}

export function nextWriteGapMs(rng: Rng, previous: number[] = []): number {
	return nextGapMs(rng, previous);
}

export function nextIdleBreakMs(rng: Rng, previous: number[] = []): number {
	const roll = rng();
	const span = rng();
	const gap =
		roll > 0.78
			? 14000 + Math.round(span * span * 18000)
			: 4500 + Math.round(span * span * span * 6000);
	return adjustGap(gap, previous, rng);
}

export function nextBackoffMs(
	rng: Rng,
	attempt: number,
	kind: Exclude<PaceClass, "stop">,
	previous: number[] = [],
): number {
	const roll = rng();
	const span = rng();
	const heavy = roll > 0.7 ? span : span * span * span;
	const floor = kind === "rate-limit" ? 2000 + attempt * 1500 : 800 + attempt * 600;
	const width = kind === "rate-limit" ? 7000 + attempt * 2000 : 2500 + attempt * 900;
	return adjustGap(Math.round(floor + heavy * width), previous, rng);
}

export function nextBurstBudget(rng: Rng): number {
	const roll = rng();
	if (roll < 0.2) return 2;
	if (roll < 0.55) return 3;
	if (roll < 0.85) return 4;
	return 5;
}

export function adjustGap(gap: number, previous: number[], rng: Rng): number {
	const last = previous.at(-1);
	const prior = previous.at(-2);
	if (last === undefined) return gap;
	if (Math.abs(gap - last) < 70) return gap + 70 + Math.round(rng() * 310);
	if (prior !== undefined && gap - last === last - prior) {
		return gap + 113 + Math.round(rng() * 180);
	}
	return gap;
}

export function protonPaceClass(error: unknown): PaceClass {
	const message = error instanceof Error ? error.message : String(error);
	const status = Number(/HTTP (\d{3})/.exec(message)?.[1] ?? "");
	if (status === 429) return "rate-limit";
	if (status >= 500 && status <= 599) return "transient";
	if (status >= 400 && status <= 499) return "stop";
	if (/\((?:timeout|network|stale-page)\)/.test(message)) return "transient";
	if (/timed out|could not complete the operation/i.test(message)) return "transient";
	return "stop";
}

export class ProtonGate {
	private tail: Promise<void> = Promise.resolve();
	private readonly gaps: number[] = [];
	private sinceBreak = 0;
	private burstBudget: number;
	private active = 0;

	constructor(
		private readonly clock: Clock,
		private readonly rng: Rng,
		burstBudget?: number,
	) {
		this.burstBudget = burstBudget ?? nextBurstBudget(rng);
	}

	async run<T>(op: () => Promise<T>, options?: { retry?: boolean }): Promise<T> {
		if (this.active > 0) return op();
		const ticket = this.tail.then(() => this.execute(op, options?.retry === true));
		this.tail = ticket.then(
			() => undefined,
			() => undefined,
		);
		return ticket;
	}

	private async execute<T>(op: () => Promise<T>, retry: boolean): Promise<T> {
		await this.pauseBeforeCall();
		this.active += 1;
		try {
			return await this.attempt(op, retry);
		} finally {
			this.active -= 1;
			this.sinceBreak += 1;
		}
	}

	private async attempt<T>(op: () => Promise<T>, retry: boolean): Promise<T> {
		let rateAttempts = 0;
		let transientAttempts = 0;
		for (;;) {
			try {
				return await op();
			} catch (error) {
				if (!retry) throw error;
				const kind = protonPaceClass(error);
				if (kind === "stop") throw error;
				if (kind === "rate-limit") {
					if (rateAttempts >= rateLimitRetries) throw error;
					rateAttempts += 1;
					await this.sleepBackoff(rateAttempts, kind);
					continue;
				}
				if (transientAttempts >= transientRetries) throw error;
				transientAttempts += 1;
				await this.sleepBackoff(transientAttempts, kind);
			}
		}
	}

	private async sleepBackoff(
		attempt: number,
		kind: Exclude<PaceClass, "stop">,
	): Promise<void> {
		const gap = nextBackoffMs(this.rng, attempt, kind, this.gaps);
		this.gaps.push(gap);
		await this.clock.sleep(gap);
	}

	private async pauseBeforeCall(): Promise<void> {
		if (this.sinceBreak === 0 && this.gaps.length === 0) return;
		const idle = this.sinceBreak >= this.burstBudget;
		const gap = idle
			? nextIdleBreakMs(this.rng, this.gaps)
			: nextGapMs(this.rng, this.gaps);
		this.gaps.push(gap);
		if (idle) {
			this.sinceBreak = 0;
			this.burstBudget = nextBurstBudget(this.rng);
		}
		await this.clock.sleep(gap);
	}
}

export function immediateProtonGate(): ProtonGate {
	return new ProtonGate({ now: () => 0, sleep: async () => undefined }, () => 0.5, 5);
}

export function liveProtonGate(): ProtonGate {
	return new ProtonGate(
		{ now: () => Date.now(), sleep: (ms) => Bun.sleep(ms) },
		Math.random,
	);
}

export async function runPaced<T>(
	steps: Array<() => Promise<T>>,
	clock: Clock,
	rng: Rng,
): Promise<T[]> {
	const gate = new ProtonGate(clock, rng);
	const results: T[] = [];
	for (const step of steps) {
		if (!step) continue;
		results.push(await gate.run(step));
	}
	return results;
}
