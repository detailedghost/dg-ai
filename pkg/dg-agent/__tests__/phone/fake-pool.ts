import type { Filter, NostrEvent } from "nostr-tools";
import type { SubscribeManyParams } from "nostr-tools/pool";
import type { PhonePool } from "../../src/phone/chat";

export type FakePool = PhonePool & {
	events: NostrEvent[];
	filters: Filter[];
	listeners: ((event: NostrEvent) => void)[];
};

export function createFakePool(accepting: string[] | "all" = "all"): FakePool {
	const pool: FakePool = {
		events: [],
		filters: [],
		listeners: [],
		publish(relays, event) {
			return relays.map((relay) => {
				if (accepting !== "all" && !accepting.includes(relay)) {
					return Promise.reject(new Error(`${relay} refused`));
				}
				pool.events.push(event);
				for (const listener of pool.listeners) listener(event);
				return Promise.resolve("");
			});
		},
		async querySync(_relays, filter) {
			pool.filters.push(filter);
			return pool.events.filter(
				(event) =>
					event.created_at >= (filter.since ?? 0) &&
					(!filter.kinds || filter.kinds.includes(event.kind)) &&
					(!filter["#p"] || event.tags.some((tag) => tag[0] === "p" && filter["#p"]?.includes(tag[1] as string))),
			);
		},
		subscribe(_relays, filter, params: SubscribeManyParams) {
			pool.filters.push(filter);
			const listener = (event: NostrEvent) => params.onevent?.(event);
			pool.listeners.push(listener);
			return {
				close: () => {
					pool.listeners = pool.listeners.filter((l) => l !== listener);
				},
			};
		},
	};
	return pool;
}
