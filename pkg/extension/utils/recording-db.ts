/**
 * IndexedDB store for pending demo recordings.
 *
 * Written by the offscreen document, read by the background service worker and
 * the review page — all three run under the extension origin and therefore share
 * this IndexedDB namespace. The video lives here as a `Blob`, so the bytes never
 * cross chrome.runtime.sendMessage; having to ship them as one base64 data URL is
 * what capped capture quality before.
 *
 * Entries are keyed by tabId and carry a `createdAt` timestamp so stale
 * recordings (older than 8 hours) can be pruned opportunistically.
 */

const DB_NAME = "dg-recordings";
const STORE = "recordings";
const DB_VERSION = 2;
const STALE_MS = 8 * 60 * 60 * 1000; // 8 hours

export type RecordingEntry = {
	tabId: number;
	blob: Blob;
	slug: string;
	planMarkdown: string;
	createdAt: number;
};

function openDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = (e) => {
			const db = (e.target as IDBOpenDBRequest).result;
			/**
			 * Recreate rather than migrate. v1 rows carried the video as a base64
			 * `dataUrl` string that no longer has a field to land in, and every row is
			 * an un-downloaded recording already discarded after 8 hours — so dropping
			 * them costs a user at most one pending review, not stored work.
			 */
			if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
			const store = db.createObjectStore(STORE, { keyPath: "tabId" });
			store.createIndex("createdAt", "createdAt");
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
		tx.oncomplete = () => {
			db.close();
			resolve();
		};
		tx.onerror = () => {
			db.close();
			reject(tx.error);
		};
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
		tx.oncomplete = () => db.close();
		tx.onerror = () => db.close();
	});
}

/**
 * Whether a recording is stored for `tabId`, without reading the video.
 *
 * `count()` on the key answers from the index alone, so a presence check never
 * materializes the Blob — which matters because callers ask this on paths that
 * only need to know whether the user still has something to act on.
 */
export async function hasRecording(tabId: number): Promise<boolean> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE, "readonly");
		const req = tx.objectStore(STORE).count(tabId);
		req.onsuccess = () => resolve(req.result > 0);
		req.onerror = () => reject(req.error);
		tx.oncomplete = () => db.close();
		tx.onerror = () => db.close();
	});
}

export async function removeRecording(tabId: number): Promise<void> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE, "readwrite");
		tx.objectStore(STORE).delete(tabId);
		tx.oncomplete = () => {
			db.close();
			resolve();
		};
		tx.onerror = () => {
			db.close();
			reject(tx.error);
		};
	});
}

/** Delete all entries older than `maxAgeMs` (default 8 hours). */
export async function pruneStaleRecordings(maxAgeMs = STALE_MS): Promise<void> {
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
		tx.oncomplete = () => {
			db.close();
			resolve();
		};
		tx.onerror = () => {
			db.close();
			reject(tx.error);
		};
	});
}
