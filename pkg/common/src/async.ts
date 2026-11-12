/** A promise that resolves after `ms` milliseconds — shared by every bounded retry/backoff. */
export const wait = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/** A promise that never settles; a command that leaves a server running returns it so `main` never returns. */
export const forever = (): Promise<never> => new Promise(() => {});

export { exitAfterDrain } from "./exit";

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
