export type Rng = () => number;

export type Clock = {
	now(): number;
	sleep(ms: number): Promise<void>;
};

export function nextWriteGapMs(rng: Rng, previous: number[] = []): number {
	const roll = rng();
	const span = rng();
	const gap =
		roll > 0.82
			? 2200 + Math.round(span * 2400)
			: 280 + Math.round(span * span * 1700);
	return adjustGap(gap, previous, rng);
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

export async function runPaced<T>(
	steps: Array<() => Promise<T>>,
	clock: Clock,
	rng: Rng,
): Promise<T[]> {
	const results: T[] = [];
	const gaps: number[] = [];
	for (let index = 0; index < steps.length; index += 1) {
		if (index > 0) {
			const gap = nextWriteGapMs(rng, gaps);
			gaps.push(gap);
			await clock.sleep(gap);
		}
		const step = steps[index];
		if (!step) continue;
		results.push(await step());
	}
	return results;
}
