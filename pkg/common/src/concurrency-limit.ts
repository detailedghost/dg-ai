/** Runs at most `max` async tasks at once, in call order, and passes each result or rejection to its caller. */
export function createConcurrencyLimit(max: number): <T>(task: () => Promise<T>) => Promise<T> {
	if (!Number.isInteger(max) || max < 1) throw new RangeError("The concurrency limit must be a positive integer.");
	let running = 0;
	const waiting: Array<() => void> = [];
	const release = () => {
		const next = waiting.shift();
		if (next) next();
		else running -= 1;
	};
	return async <T>(task: () => Promise<T>): Promise<T> => {
		if (running >= max) await new Promise<void>((resolve) => waiting.push(resolve));
		else running += 1;
		try {
			return await task();
		} finally {
			release();
		}
	};
}
