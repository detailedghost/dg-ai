/** A promise that resolves after `ms` milliseconds — shared by every bounded retry/backoff. */
export const wait = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves with `work`, or with `onTimeout()` after `ms`; a throwing `onTimeout` rejects. */
export function withTimeout<T, U = undefined>(
	work: Promise<T>,
	ms: number,
	onTimeout: () => U = () => undefined as U,
): Promise<T | U> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<U>((resolve, reject) => {
		timer = setTimeout(() => {
			try {
				resolve(onTimeout());
			} catch (error) {
				reject(error);
			}
		}, ms);
	});
	return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}
