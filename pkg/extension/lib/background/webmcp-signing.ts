const DB_NAME = "dg-webmcp";
const STORE = "keys";
const KEY_ID = "script-signing";

export type WebMcpSigner = {
	sign(bytes: Uint8Array): Promise<string>;
	verify(bytes: Uint8Array, mac: string): Promise<boolean>;
};

const toHex = (buffer: ArrayBuffer) =>
	[...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

function fromHex(text: string): Uint8Array | null {
	if (text.length === 0 || text.length % 2 !== 0 || !/^[0-9a-f]+$/.test(text)) return null;
	return Uint8Array.from(text.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

function settled<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

/** The HMAC key for script approvals; it lives only in this extension origin's IndexedDB and is never exportable. */
export async function loadSigningKey(factory: IDBFactory = indexedDB): Promise<CryptoKey> {
	const opening = factory.open(DB_NAME, 1);
	opening.onupgradeneeded = () => void opening.result.createObjectStore(STORE);
	const db = await settled(opening);
	try {
		const candidate = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
		const tx = db.transaction(STORE, "readwrite");
		const committed = new Promise<void>((resolve, reject) => {
			tx.oncomplete = () => resolve();
			tx.onabort = () => reject(tx.error ?? new Error("The signing key was not saved"));
			tx.onerror = () => reject(tx.error ?? new Error("The signing key was not saved"));
		});
		committed.catch(() => undefined);
		const store = tx.objectStore(STORE);
		const existing = await settled(store.get(KEY_ID));
		if (!existing) await settled(store.put(candidate, KEY_ID));
		await committed;
		return (existing as CryptoKey | undefined) ?? candidate;
	} finally {
		db.close();
	}
}

/** Signs and verifies approval records; the key loads on first use and stays cached for the worker's life. */
export function createWebMcpSigner({
	loadKey = () => loadSigningKey(),
}: { loadKey?: () => Promise<CryptoKey> } = {}): WebMcpSigner {
	let key: Promise<CryptoKey> | undefined;
	const keyOnce = () =>
		(key ??= loadKey().catch((error: unknown) => {
			key = undefined;
			throw error;
		}));

	return {
		async sign(bytes) {
			return toHex(await crypto.subtle.sign("HMAC", await keyOnce(), bytes as BufferSource));
		},
		async verify(bytes, mac) {
			const expected = fromHex(mac);
			const loaded = await keyOnce();
			return expected !== null && crypto.subtle.verify("HMAC", loaded, expected as BufferSource, bytes as BufferSource);
		},
	};
}
