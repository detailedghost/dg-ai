export type Channel<T> = AsyncIterable<T> & {
	send(value: T): Promise<void>;
	receive(): Promise<IteratorResult<T, undefined>>;
	close(): void;
};

/** A Go-style FIFO channel. `capacity` bounds buffered items; a full channel makes `send` wait. */
export function createChannel<T>(capacity = Number.POSITIVE_INFINITY): Channel<T> {
	const buffer: T[] = [];
	const receivers: ((result: IteratorResult<T, undefined>) => void)[] = [];
	const senders: { value: T; resolve: () => void; reject: (error: Error) => void }[] = [];
	let closed = false;

	const done = (): IteratorResult<T, undefined> => ({ done: true, value: undefined });

	function refill(): void {
		while (buffer.length < capacity) {
			const sender = senders.shift();
			if (!sender) return;
			buffer.push(sender.value);
			sender.resolve();
		}
	}

	const channel: Channel<T> = {
		send(value) {
			if (closed) return Promise.reject(new Error("send on a closed channel"));
			const receiver = receivers.shift();
			if (receiver) {
				receiver({ done: false, value });
				return Promise.resolve();
			}
			if (buffer.length < capacity) {
				buffer.push(value);
				return Promise.resolve();
			}
			return new Promise((resolve, reject) => senders.push({ value, resolve, reject }));
		},
		receive() {
			if (buffer.length > 0) {
				const value = buffer.shift() as T;
				refill();
				return Promise.resolve({ done: false, value });
			}
			if (closed) return Promise.resolve(done());
			return new Promise((resolve) => receivers.push(resolve));
		},
		close() {
			if (closed) return;
			closed = true;
			for (const receiver of receivers.splice(0)) receiver(done());
			for (const sender of senders.splice(0)) {
				sender.reject(new Error("send on a closed channel"));
			}
		},
		[Symbol.asyncIterator]() {
			return {
				next: () => channel.receive(),
				return: () => Promise.resolve(done()),
			};
		},
	};
	return channel;
}
