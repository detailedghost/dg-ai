/**
 * IndexedDB store for pending demo recordings.
 *
 * Used by the background service worker and offscreen document (both run under
 * the extension origin and therefore share the same IndexedDB namespace).
 * Content scripts run under the page origin and access recordings through the
 * background via chrome.runtime.sendMessage (MSG.requestVideoData).
 *
 * Entries are keyed by tabId and carry a `createdAt` timestamp so stale
 * recordings (older than 8 hours) can be pruned opportunistically.
 */

const DB_NAME = "dg-recordings";
const STORE = "recordings";
const DB_VERSION = 1;
const STALE_MS = 8 * 60 * 60 * 1000; // 8 hours

export type RecordingEntry = {
	tabId: number;
	dataUrl: string;
	slug: string;
	planMarkdown: string;
	createdAt: number;
};

function openDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = (e) => {
			const db = (e.target as IDBOpenDBRequest).result;
			if (!db.objectStoreNames.contains(STORE)) {
				const store = db.createObjectStore(STORE, { keyPath: "tabId" });
				store.createIndex("createdAt", "createdAt");
			}
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

export async function saveRecording(entry: RecordingEntry): Promise<void> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE, "readwrite");
		tx.objectStore(STORE).put(entry);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}

export async function getRecording(
	tabId: number,
): Promise<RecordingEntry | undefined> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE, "readonly");
		const req = tx.objectStore(STORE).get(tabId);
		req.onsuccess = () => resolve(req.result as RecordingEntry | undefined);
		req.onerror = () => reject(req.error);
	});
}

export async function removeRecording(tabId: number): Promise<void> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE, "readwrite");
		tx.objectStore(STORE).delete(tabId);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}

/** Delete all entries older than `maxAgeMs` (default 8 hours). */
export async function pruneStaleRecordings(
	maxAgeMs = STALE_MS,
): Promise<void> {
	const db = await openDb();
	const cutoff = Date.now() - maxAgeMs;
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE, "readwrite");
		const req = tx
			.objectStore(STORE)
			.index("createdAt")
			.openCursor(IDBKeyRange.upperBound(cutoff));
		req.onsuccess = (e) => {
			const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result;
			if (cursor) {
				cursor.delete();
				cursor.continue();
			}
		};
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}
