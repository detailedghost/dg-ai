export type KeyedListOptions<Item> = {
	key: (item: Item) => string;
	create: (item: Item) => HTMLElement;
	update: (element: HTMLElement, item: Item) => void;
};

/** Reconciles `container`'s children against `items` by key, patching existing rows in place. */
export function patchKeyedList<Item>(
	container: HTMLElement,
	items: Item[],
	options: KeyedListOptions<Item>,
): void {
	const existing = new Map<string, HTMLElement>();
	for (const child of Array.from(container.children)) {
		const key = (child as HTMLElement).dataset.key;
		if (key !== undefined) existing.set(key, child as HTMLElement);
	}

	let cursor = container.firstElementChild;
	for (const item of items) {
		const key = options.key(item);
		let element = existing.get(key);
		if (element) existing.delete(key);
		else {
			element = options.create(item);
			element.dataset.key = key;
		}
		options.update(element, item);
		if (cursor !== element) container.insertBefore(element, cursor);
		cursor = element.nextElementSibling;
	}

	for (const leftover of existing.values()) leftover.remove();
}
