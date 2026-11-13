const DB_NAME = "dg-webmcp-grants";
const STORE = "nonces";

/** Live nonces of remembered Web MCP grants; a signed record whose nonce is gone grants nothing. */
export type GrantNonces = {
	has(nonce: string): Promise<boolean>;
	add(nonce: string): Promise<void>;
	remove(nonce: string): Promise<void>;
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
	async function withStore<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
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
			const result = await settled(work(tx.objectStore(STORE)));
			await done;
			return result;
		} finally {
			db.close();
		}
	}

	return {
		async has(nonce) {
			return (await withStore("readonly", (store) => store.count(nonce))) > 0;
		},
		async add(nonce) {
			await withStore("readwrite", (store) => store.put(true, nonce));
		},
		async remove(nonce) {
			await withStore("readwrite", (store) => store.delete(nonce));
		},
		async clear() {
			await withStore("readwrite", (store) => store.clear());
		},
	};
}
