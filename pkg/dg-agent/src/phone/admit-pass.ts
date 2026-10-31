export type AdmitDecision<T, Drop> =
	| { ok: true; value: T; grew: boolean }
	| { ok: false; retry: boolean; drop: Drop };

/**
 * Admits `items` in order. An item that should be retried (a plain message
 * from someone this batch has not introduced yet) is tried again only after a
 * later item grows the gate. Anything still unmatched is dropped once.
 */
export function admitInPasses<Item, T, Drop>(
	items: readonly Item[],
	decide: (item: Item) => AdmitDecision<T, Drop>,
): { admitted: T[]; drops: Drop[] } {
	let pending = items.slice();
	const admitted: T[] = [];
	const drops: Drop[] = [];
	for (;;) {
		const deferred: Item[] = [];
		const deferredDrops: Drop[] = [];
		let grew = false;
		for (const item of pending) {
			const decision = decide(item);
			if (decision.ok) {
				admitted.push(decision.value);
				if (decision.grew) grew = true;
				continue;
			}
			if (decision.retry) {
				deferred.push(item);
				deferredDrops.push(decision.drop);
				continue;
			}
			drops.push(decision.drop);
		}
		if (!grew || deferred.length === 0) {
			drops.push(...deferredDrops);
			return { admitted, drops };
		}
		pending = deferred;
	}
}
