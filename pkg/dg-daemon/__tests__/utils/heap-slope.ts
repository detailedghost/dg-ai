import { heapStats } from "bun:jsc";

export const LEAK_BYTES_PER_ITERATION = 1500;
export const LEAK_WINDOW = 3;

export type HeapReading = { heap: number; objects: number };

export function settledHeap(): HeapReading {
	Bun.gc(true);
	Bun.gc(true);
	const { heapSize, objectCount } = heapStats();
	return { heap: heapSize, objects: objectCount };
}

function median(values: number[]): number {
	return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] as number;
}

export type SlopeRun = { slopes: number[]; leaking: boolean };

/** Bytes of heap growth per iteration for each batch; a leak needs the median of the last batches over the limit. */
export async function measureSlope(
	step: () => Promise<void>,
	read: () => Promise<HeapReading> | HeapReading,
	{
		warmup,
		batches,
		iterations,
		limit = LEAK_BYTES_PER_ITERATION,
	}: { warmup: number; batches: number; iterations: number; limit?: number },
): Promise<SlopeRun> {
	for (let i = 0; i < warmup; i++) await step();
	let previous = await read();
	const slopes: number[] = [];
	for (let batch = 0; batch < batches; batch++) {
		for (let i = 0; i < iterations; i++) await step();
		const current = await read();
		slopes.push(Math.round((current.heap - previous.heap) / iterations));
		previous = current;
	}
	return { slopes, leaking: median(slopes.slice(-LEAK_WINDOW)) > limit };
}
