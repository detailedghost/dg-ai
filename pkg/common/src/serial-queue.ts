/**
 * A lock that runs async tasks strictly one-at-a-time, in the order they were
 * enqueued. Each `enqueue`d task is chained onto the tail of the previous one, so
 * task N+1 does not start until task N's returned promise has fully settled — the
 * chain's tail *is* the mutex. A task that throws is logged (via `onError`) and the
 * rejection is swallowed so the lock always releases and later tasks still run.
 *
 * Holds no buffer between tasks: once idle the internal tail is just a resolved
 * promise, so there is nothing to lose if the caller's environment is torn down
 * between enqueues (e.g. an MV3 service worker suspending between events).
 */
export function createSerialQueue(
	onError: (err: unknown) => void = () => {},
): (task: () => Promise<void>) => Promise<void> {
	let tail: Promise<void> = Promise.resolve();
	return (task) => {
		tail = tail.then(task).catch(onError);
		return tail;
	};
}
