/**
 * Unit tests for extension-src/utils/recording-db.ts
 *
 * Uses fake-indexeddb to shim the IDB globals so the module runs in Bun. A fresh
 * IDBFactory is installed on globalThis before each test so tests never share
 * database state.
 *
 * The video is stored as a `Blob`, and fake-indexeddb round-trips one through its
 * structured clone — so these tests exercise the real storage path rather than a
 * string stand-in. A retrieved Blob is always a *fresh instance*, so it is never
 * compared with `toEqual`; `expectEntry` checks type, size, and bytes instead.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { IDBKeyRange as FakeIDBKeyRange, IDBFactory } from "fake-indexeddb";
import {
	getRecording,
	hasRecording,
	pruneStaleRecordings,
	type RecordingEntry,
	removeRecording,
	saveRecording,
} from "@/utils/recording-db";

// ── builders + Blob-aware assertions ────────────────────────────────────────

/** A stand-in webm whose bytes identify it, so a mix-up between rows is visible. */
function makeBlob(marker = "AAAA"): Blob {
	return new Blob([marker], { type: "video/webm" });
}

/** Build a RecordingEntry with sensible defaults; override only what the test cares about. */
function makeEntry(overrides?: Partial<RecordingEntry>): RecordingEntry {
	return {
		tabId: 1,
		blob: makeBlob(),
		slug: "test-slug",
		planMarkdown: "# Plan\n\nContent",
		createdAt: Date.now(),
		...overrides,
	};
}

async function bytesOf(blob: Blob): Promise<number[]> {
	return [...new Uint8Array(await blob.arrayBuffer())];
}

/** Compare a retrieved entry field-by-field, the Blob by content rather than identity. */
async function expectEntry(
	actual: RecordingEntry | undefined,
	expected: RecordingEntry,
): Promise<void> {
	expect(actual).toBeDefined();
	if (!actual) return;
	const { blob: actualBlob, ...actualRest } = actual;
	const { blob: expectedBlob, ...expectedRest } = expected;
	expect(actualRest).toEqual(expectedRest);
	expect(actualBlob).toBeInstanceOf(Blob);
	expect(actualBlob.type).toBe(expectedBlob.type);
	expect(actualBlob.size).toBe(expectedBlob.size);
	expect(await bytesOf(actualBlob)).toEqual(await bytesOf(expectedBlob));
}

// ── suite ───────────────────────────────────────────────────────────────────

describe("recording-db", () => {
	beforeEach(() => {
		// Fresh IDB namespace per test — no shared state between cases.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(globalThis as any).indexedDB = new IDBFactory();
		// recording-db.ts uses IDBKeyRange.upperBound as a global; shim it.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(globalThis as any).IDBKeyRange = FakeIDBKeyRange;
	});

	// ── saveRecording / getRecording ────────────────────────────────────────

	it("saveRecording → getRecording round-trips the full RecordingEntry without mutation", async () => {
		const entry = makeEntry({
			tabId: 42,
			blob: makeBlob("ROUND_TRIP"),
			slug: "demo-tour",
			planMarkdown: "# Round-trip Plan",
			createdAt: 1_700_000_000_000,
		});

		await saveRecording(entry);

		await expectEntry(await getRecording(42), entry);
	});

	it("returns the video as a Blob with its bytes intact, never a base64 stand-in", async () => {
		// The point of the schema: bytes survive storage without a data-URL detour.
		const entry = makeEntry({ tabId: 43, blob: makeBlob("VP9-BYTES") });
		await saveRecording(entry);

		const blob = (await getRecording(43))?.blob;

		expect(blob).toBeInstanceOf(Blob);
		expect(blob).not.toBe(entry.blob);
		expect(await bytesOf(blob as Blob)).toEqual(await bytesOf(entry.blob));
	});

	it("getRecording on unknown tabId resolves undefined (does not reject)", async () => {
		const result = await getRecording(9999);

		expect(result).toBeUndefined();
	});

	// ── hasRecording ────────────────────────────────────────────────────────

	it("hasRecording is true for a stored entry and false for an unknown tabId", async () => {
		await saveRecording(makeEntry({ tabId: 71 }));

		expect(await hasRecording(71)).toBe(true);
		expect(await hasRecording(72)).toBe(false);
	});

	it("hasRecording is false again once the entry is removed", async () => {
		await saveRecording(makeEntry({ tabId: 73 }));
		await removeRecording(73);

		expect(await hasRecording(73)).toBe(false);
	});

	it("hasRecording answers for tabId 0, which is a real key rather than a falsy miss", async () => {
		await saveRecording(makeEntry({ tabId: 0 }));

		expect(await hasRecording(0)).toBe(true);
	});

	// ── removeRecording ─────────────────────────────────────────────────────

	it("removeRecording on a stored entry: subsequent getRecording returns undefined", async () => {
		const entry = makeEntry({ tabId: 7 });
		await saveRecording(entry);

		await removeRecording(7);

		expect(await getRecording(7)).toBeUndefined();
	});

	it("removeRecording on non-existent tabId resolves without throwing", async () => {
		// No entry saved — must not reject.
		await expect(removeRecording(99999)).resolves.toBeUndefined();
	});

	// ── upsert semantics ────────────────────────────────────────────────────

	it("saveRecording twice with same tabId (different video): getRecording returns second write (upsert)", async () => {
		const first = makeEntry({ tabId: 3, blob: makeBlob("FIRST") });
		const second = makeEntry({ tabId: 3, blob: makeBlob("SECOND") });

		await saveRecording(first);
		await saveRecording(second);

		await expectEntry(await getRecording(3), second);
	});

	// ── pruneStaleRecordings ─────────────────────────────────────────────────

	it("pruneStaleRecordings(0) deletes all entries", async () => {
		const now = Date.now();
		await saveRecording(makeEntry({ tabId: 100, createdAt: now - 1_000 }));
		await saveRecording(makeEntry({ tabId: 101, createdAt: now - 2_000 }));
		await saveRecording(makeEntry({ tabId: 102, createdAt: now - 3_000 }));

		await pruneStaleRecordings(0);

		expect(await getRecording(100)).toBeUndefined();
		expect(await getRecording(101)).toBeUndefined();
		expect(await getRecording(102)).toBeUndefined();
	});

	it("pruneStaleRecordings() default 8 h: 9 h-old entry deleted; 1 h-old entry survives", async () => {
		const now = Date.now();
		const staleEntry = makeEntry({
			tabId: 200,
			createdAt: now - 9 * 3_600_000,
		});
		const freshEntry = makeEntry({
			tabId: 201,
			createdAt: now - 1 * 3_600_000,
		});

		await saveRecording(staleEntry);
		await saveRecording(freshEntry);

		// default maxAgeMs = 8 h → cutoff = now - 8 h
		// stale: (now - 9h) ≤ cutoff  → deleted
		// fresh: (now - 1h) >  cutoff  → kept
		await pruneStaleRecordings();

		expect(await getRecording(200)).toBeUndefined();
		await expectEntry(await getRecording(201), freshEntry);
	});

	it("pruneStaleRecordings: mixed entries — only stale rows deleted, fresh rows intact (≥ 3 entries)", async () => {
		const now = Date.now();
		const stale1 = makeEntry({ tabId: 300, createdAt: now - 10 * 3_600_000 });
		const stale2 = makeEntry({ tabId: 301, createdAt: now - 9 * 3_600_000 });
		const fresh1 = makeEntry({ tabId: 302, createdAt: now - 1 * 3_600_000 });
		const fresh2 = makeEntry({ tabId: 303, createdAt: now - 2 * 3_600_000 });

		await saveRecording(stale1);
		await saveRecording(stale2);
		await saveRecording(fresh1);
		await saveRecording(fresh2);

		await pruneStaleRecordings(); // default 8 h

		// Stale entries (>8 h old) must be gone
		expect(await getRecording(300)).toBeUndefined();
		expect(await getRecording(301)).toBeUndefined();
		// Fresh entries (<8 h old) must be intact
		await expectEntry(await getRecording(302), fresh1);
		await expectEntry(await getRecording(303), fresh2);
	});

	// ── coverage gap: boundary values ───────────────────────────────────────

	it("saveRecording with boundary values (tabId=0, empty blob and strings) round-trips intact", async () => {
		// tabId=0 is a valid key; empty fields are allowed by the schema.
		const entry = makeEntry({
			tabId: 0,
			blob: new Blob([], { type: "video/webm" }),
			slug: "",
			planMarkdown: "",
			createdAt: 0,
		});

		await saveRecording(entry);

		await expectEntry(await getRecording(0), entry);
	});

	// ── coverage gap: pruneStaleRecordings on empty store ───────────────────

	it("pruneStaleRecordings on empty store resolves without throwing", async () => {
		// Store is freshly created (no entries) — should not throw or reject.
		await expect(pruneStaleRecordings(0)).resolves.toBeUndefined();
	});

	// ── coverage gap: multiple tabIds coexist ───────────────────────────────

	it("multiple saveRecording calls with different tabIds coexist independently", async () => {
		const a = makeEntry({ tabId: 10, blob: makeBlob("A") });
		const b = makeEntry({ tabId: 20, blob: makeBlob("B") });
		const c = makeEntry({ tabId: 30, blob: makeBlob("C") });

		await saveRecording(a);
		await saveRecording(b);
		await saveRecording(c);

		await expectEntry(await getRecording(10), a);
		await expectEntry(await getRecording(20), b);
		await expectEntry(await getRecording(30), c);
	});

	it("getRecording returns the correct entry when multiple entries exist", async () => {
		const target = makeEntry({ tabId: 55, blob: makeBlob("TARGET") });
		await saveRecording(makeEntry({ tabId: 50 }));
		await saveRecording(target);
		await saveRecording(makeEntry({ tabId: 60 }));

		// Must be exactly the entry for tabId=55, not its neighbours.
		await expectEntry(await getRecording(55), target);
	});

	// ── coverage gap: removeRecording does not affect siblings ──────────────

	it("removeRecording only removes the targeted tabId, leaving others intact", async () => {
		const keep1 = makeEntry({ tabId: 401, blob: makeBlob("KEEP1") });
		const remove = makeEntry({ tabId: 402, blob: makeBlob("REMOVE") });
		const keep2 = makeEntry({ tabId: 403, blob: makeBlob("KEEP2") });

		await saveRecording(keep1);
		await saveRecording(remove);
		await saveRecording(keep2);

		await removeRecording(402);

		expect(await getRecording(402)).toBeUndefined();
		await expectEntry(await getRecording(401), keep1);
		await expectEntry(await getRecording(403), keep2);
	});

	it("closes its IndexedDB connection after each call, so a later version bump is not blocked", async () => {
		await saveRecording(makeEntry({ tabId: 900 }));
		await getRecording(900);
		await hasRecording(900);
		await removeRecording(900);
		await pruneStaleRecordings(0);

		const currentVersion = await new Promise<number>((resolve, reject) => {
			const req = indexedDB.open("dg-recordings");
			req.onsuccess = () => {
				const version = req.result.version;
				req.result.close();
				resolve(version);
			};
			req.onerror = () => reject(req.error);
		});

		const upgraded = new Promise<void>((resolve, reject) => {
			const req = indexedDB.open("dg-recordings", currentVersion + 1);
			req.onupgradeneeded = () => {};
			req.onsuccess = () => {
				req.result.close();
				resolve();
			};
			req.onerror = () => reject(req.error);
		});

		await Promise.race([
			upgraded,
			new Promise<never>((_, reject) =>
				setTimeout(
					() =>
						reject(
							new Error(
								"version-bump open never completed — a leaked connection is blocking it",
							),
						),
					500,
				),
			),
		]);
	});
});
