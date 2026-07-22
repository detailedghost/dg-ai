/**
 * Unit tests for extension-src/utils/recording-db.ts
 *
 * Uses fake-indexeddb to shim the IDB globals so the module runs in Bun.
 * A fresh IDBFactory is installed on globalThis before each test so tests
 * never share database state.
 *
 * NOTE: fake-indexeddb must be installed (devDep) for these tests to run.
 *       Yellow installs it; they will fail at import time until then.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { IDBFactory, IDBKeyRange as FakeIDBKeyRange } from "fake-indexeddb";
import {
	saveRecording,
	getRecording,
	removeRecording,
	pruneStaleRecordings,
	type RecordingEntry,
} from "@/utils/recording-db";

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/** Build a RecordingEntry with sensible defaults; override only what the test cares about. */
function makeEntry(overrides?: Partial<RecordingEntry>): RecordingEntry {
	return {
		tabId: 1,
		dataUrl: "data:video/webm;base64,AAAA",
		slug: "test-slug",
		planMarkdown: "# Plan\n\nContent",
		createdAt: Date.now(),
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

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
			dataUrl: "data:video/webm;base64,ROUND_TRIP",
			slug: "demo-tour",
			planMarkdown: "# Round-trip Plan",
			createdAt: 1_700_000_000_000,
		});

		await saveRecording(entry);
		const retrieved = await getRecording(42);

		expect(retrieved).toEqual(entry);
	});

	it("getRecording on unknown tabId resolves undefined (does not reject)", async () => {
		const result = await getRecording(9999);

		expect(result).toBeUndefined();
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

	it("saveRecording twice with same tabId (different dataUrl): getRecording returns second write (upsert)", async () => {
		const first = makeEntry({ tabId: 3, dataUrl: "data:video/webm;base64,FIRST" });
		const second = makeEntry({ tabId: 3, dataUrl: "data:video/webm;base64,SECOND" });

		await saveRecording(first);
		await saveRecording(second);

		const retrieved = await getRecording(3);
		expect(retrieved).toEqual(second);
		expect(retrieved?.dataUrl).toBe("data:video/webm;base64,SECOND");
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
		const staleEntry = makeEntry({ tabId: 200, createdAt: now - 9 * 3_600_000 });
		const freshEntry = makeEntry({ tabId: 201, createdAt: now - 1 * 3_600_000 });

		await saveRecording(staleEntry);
		await saveRecording(freshEntry);

		// default maxAgeMs = 8 h → cutoff = now - 8 h
		// stale: (now - 9h) ≤ cutoff  → deleted
		// fresh: (now - 1h) >  cutoff  → kept
		await pruneStaleRecordings();

		expect(await getRecording(200)).toBeUndefined();
		expect(await getRecording(201)).toEqual(freshEntry);
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
		expect(await getRecording(302)).toEqual(fresh1);
		expect(await getRecording(303)).toEqual(fresh2);
	});

	// ── coverage gap: boundary values ───────────────────────────────────────

	it("saveRecording with boundary values (tabId=0, empty strings) round-trips intact", async () => {
		// tabId=0 is a valid key; empty string fields are allowed by the schema.
		const entry = makeEntry({
			tabId: 0,
			dataUrl: "",
			slug: "",
			planMarkdown: "",
			createdAt: 0,
		});

		await saveRecording(entry);
		const retrieved = await getRecording(0);

		expect(retrieved).toEqual(entry);
	});

	// ── coverage gap: pruneStaleRecordings on empty store ───────────────────

	it("pruneStaleRecordings on empty store resolves without throwing", async () => {
		// Store is freshly created (no entries) — should not throw or reject.
		await expect(pruneStaleRecordings(0)).resolves.toBeUndefined();
	});

	// ── coverage gap: multiple tabIds coexist ───────────────────────────────

	it("multiple saveRecording calls with different tabIds coexist independently", async () => {
		const a = makeEntry({ tabId: 10, dataUrl: "data:video/webm;base64,A" });
		const b = makeEntry({ tabId: 20, dataUrl: "data:video/webm;base64,B" });
		const c = makeEntry({ tabId: 30, dataUrl: "data:video/webm;base64,C" });

		await saveRecording(a);
		await saveRecording(b);
		await saveRecording(c);

		expect(await getRecording(10)).toEqual(a);
		expect(await getRecording(20)).toEqual(b);
		expect(await getRecording(30)).toEqual(c);
	});

	it("getRecording returns the correct entry when multiple entries exist", async () => {
		const target = makeEntry({ tabId: 55, dataUrl: "data:video/webm;base64,TARGET" });
		await saveRecording(makeEntry({ tabId: 50 }));
		await saveRecording(target);
		await saveRecording(makeEntry({ tabId: 60 }));

		const retrieved = await getRecording(55);

		// Must be exactly the entry for tabId=55, not its neighbours.
		expect(retrieved).toEqual(target);
		expect(retrieved?.dataUrl).toBe("data:video/webm;base64,TARGET");
	});

	// ── coverage gap: removeRecording does not affect siblings ──────────────

	it("removeRecording only removes the targeted tabId, leaving others intact", async () => {
		const keep1 = makeEntry({ tabId: 401, dataUrl: "data:video/webm;base64,KEEP1" });
		const remove = makeEntry({ tabId: 402, dataUrl: "data:video/webm;base64,REMOVE" });
		const keep2 = makeEntry({ tabId: 403, dataUrl: "data:video/webm;base64,KEEP2" });

		await saveRecording(keep1);
		await saveRecording(remove);
		await saveRecording(keep2);

		await removeRecording(402);

		expect(await getRecording(402)).toBeUndefined();
		expect(await getRecording(401)).toEqual(keep1);
		expect(await getRecording(403)).toEqual(keep2);
	});
});
