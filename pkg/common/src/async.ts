/** A promise that resolves after `ms` milliseconds — shared by every bounded retry/backoff. */
export const wait = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));
