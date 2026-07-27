export function mailboxAbortError(): DOMException {
	return new DOMException("Mailbox operation canceled", "AbortError");
}

export function throwIfMailboxAborted(signal: AbortSignal): void {
	if (signal.aborted) throw mailboxAbortError();
}

export function raceMailboxAbort<T>(
	signal: AbortSignal,
	operation: () => PromiseLike<T> | T,
): Promise<T> {
	throwIfMailboxAborted(signal);
	return new Promise<T>((resolve, reject) => {
		const onAbort = (): void => reject(mailboxAbortError());
		signal.addEventListener("abort", onAbort, { once: true });
		let value: PromiseLike<T> | T;
		try {
			value = operation();
		} catch (error) {
			signal.removeEventListener("abort", onAbort);
			reject(error);
			return;
		}
		Promise.resolve(value).then(
			(result) => {
				signal.removeEventListener("abort", onAbort);
				resolve(result);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

export function invokeMailboxAbort<T>(
	signal: AbortSignal,
	operation: () => T,
): T {
	throwIfMailboxAborted(signal);
	return operation();
}

export function yieldMailboxTask(signal: AbortSignal): Promise<void> {
	return raceMailboxAbort(
		signal,
		() =>
			new Promise<void>((resolve) => {
				setTimeout(resolve, 0);
			}),
	);
}
