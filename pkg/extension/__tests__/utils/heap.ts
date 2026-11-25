export function heapAfterGc(): number {
	Bun.gc(true);
	Bun.gc(true);
	return process.memoryUsage().heapUsed;
}
