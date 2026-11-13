const DB_NAME = "dg-webmcp-grants";
const STORE = "nonces";

type Grant = { site: string; tool: string };

/** Live nonces of remembered Web MCP grants by site and tool; a signed record whose nonce is gone grants nothing. */
export type GrantNonces = {
	has(nonce: string, grant: Grant): Promise<boolean>;
	add(nonce: string, grant: Grant): Promise<void>;
	removeGrant(grant: Grant): Promise<void>;
	clear(): Promise<void>;
};

function settled<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

/** Keeps the nonces in this extension origin's IndexedDB, which content scripts cannot reach. */
export function createIdbGrantNonces(factory?: IDBFactory): GrantNonces {
	async function withStore<T>(
		mode: IDBTransactionMode,
		work: (store: IDBObjectStore) => IDBRequest<T> | Promise<T>,
	): Promise<T> {
		const opening = (factory ?? indexedDB).open(DB_NAME, 1);
		opening.onupgradeneeded = () => void opening.result.createObjectStore(STORE);
		const db = await settled(opening);
		try {
			const tx = db.transaction(STORE, mode);
			const done = new Promise<void>((resolve, reject) => {
				tx.oncomplete = () => resolve();
				tx.onabort = () => reject(tx.error ?? new Error("The grant nonce store failed"));
				tx.onerror = () => reject(tx.error ?? new Error("The grant nonce store failed"));
			});
			done.catch(() => undefined);
			const step = work(tx.objectStore(STORE));
			const result = step instanceof Promise ? await step : await settled(step);
			await done;
			return result;
		} finally {
			db.close();
		}
	}

	return {
		async has(nonce, grant) {
			const held = (await withStore("readonly", (store) => store.get(nonce))) as Grant | undefined;
			return held?.site === grant.site && held.tool === grant.tool;
		},
		async add(nonce, grant) {
			await withStore("readwrite", (store) => store.put({ site: grant.site, tool: grant.tool }, nonce));
		},
		async removeGrant(grant) {
			await withStore(
				"readwrite",
				(store) =>
					new Promise<void>((resolve, reject) => {
						const cursor = store.openCursor();
						cursor.onerror = () => reject(cursor.error);
						cursor.onsuccess = () => {
							const at = cursor.result;
							if (!at) return resolve();
							const held = at.value as Grant;
							if (held.site === grant.site && held.tool === grant.tool) at.delete();
							at.continue();
						};
					}),
			);
		},
		async clear() {
			await withStore("readwrite", (store) => store.clear());
		},
	};
}
