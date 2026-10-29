/** A promise that resolves after `ms` milliseconds — shared by every bounded retry/backoff. */
export const wait = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/** A promise that never settles; a command that leaves a server running returns it so `main` never returns. */
export const forever = (): Promise<never> => new Promise(() => {});

const DRAIN_TIMEOUT_MS = 5_000;

const endStream = (stream: NodeJS.WriteStream): Promise<void> => {
	let onError: () => void = () => {};
	return new Promise<void>((resolve) => {
		onError = () => resolve();
		stream.write = (() => true) as typeof stream.write;
		stream.once("error", onError);
		stream.end(() => resolve());
	}).finally(() => {
		stream.off("error", onError);
	});
};

/** Flushes stdout and stderr for up to 5 s, then exits with `code`; later writes are dropped, so call it at most once per process. */
export async function exitAfterDrain(code: number): Promise<never> {
	await withTimeout(
		Promise.all([endStream(process.stdout), endStream(process.stderr)]),
		DRAIN_TIMEOUT_MS,
	);
	process.exit(code);
}

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
