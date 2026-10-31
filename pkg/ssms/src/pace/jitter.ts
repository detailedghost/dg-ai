export type Rng = () => number;

export function nextGapMs(rng: Rng, previous: readonly number[] = []): number {
	const roll = rng();
	const span = rng();
	let gap: number;
	if (roll >= 0.9) gap = 3000 + Math.floor(span * 4000);
	else if (roll >= 0.6) gap = 1000 + Math.floor(span * 1500);
	else gap = 200 + Math.floor(span * span * 800);
	const last = previous.at(-1);
	if (last !== undefined && Math.abs(gap - last) < 50) {
		gap += 137 + Math.floor(rng() * 200);
	}
	const prior = previous.at(-2);
	if (prior === undefined || last === undefined) return gap;
	if (gap - last === last - prior) {
		gap += 89 + Math.floor(rng() * 100);
	}
	return gap;
}

export function timeoutSeconds(gapMs: number): number {
	return 1 + Math.floor(gapMs / 1000);
}
