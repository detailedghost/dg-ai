type BrowserCallback<T> = (value: T) => void;

function errorValue(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

/**
 * Bridge WebExtension methods across callback-only Chrome implementations and
 * Promise-only browser implementations. Firefox may reject the extra callback
 * synchronously, so retry without it only when that invocation never started.
 */
export function callBrowserApi<T>(
	withCallback: (callback: BrowserCallback<T>) => PromiseLike<T> | void,
	withoutCallback: () => PromiseLike<T>,
	lastErrorMessage: () => string | undefined,
): Promise<T> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (value: T): void => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		const fail = (error: unknown): void => {
			if (settled) return;
			settled = true;
			reject(errorValue(error));
		};
		const callback = (value: T): void => {
			const message = lastErrorMessage();
			if (message) fail(new Error(message));
			else finish(value);
		};

		let result: PromiseLike<T> | void;
		try {
			result = withCallback(callback);
		} catch {
			if (settled) return;
			try {
				result = withoutCallback();
			} catch (error) {
				fail(error);
				return;
			}
		}
		if (result) void Promise.resolve(result).then(finish, fail);
	});
}
