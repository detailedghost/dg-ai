/**
 * The reverse interleaving of the `demo_pending` leak: captureMarkerEarly's write
 * landing after the same load's document_idle already claimed it. Coordinated
 * through a claim left in the pending key (see PendingMarkerClaim), not a
 * cross-context lock — the two content scripts are separate entrypoints and share
 * no module state.
 */
import { afterEach, describe, expect, it, mock } from "bun:test";
import type { TourScript } from "@/lib/demo-types";
import { demoMarkerFragment } from "@/utils/demo-marker";

// Stub WXT's browser export so demo-tour.ts can be imported in Bun's test environment.
mock.module("wxt/browser", () => ({
	browser: {
		runtime: {
			sendMessage: mock(() => Promise.resolve()),
			onMessage: { addListener: mock(() => {}) },
		},
		storage: {
			local: {
				get: mock(() => Promise.resolve({})),
				set: mock(() => Promise.resolve()),
				remove: mock(() => Promise.resolve()),
			},
			sync: {
				get: mock(() => Promise.resolve({})),
				set: mock(() => Promise.resolve()),
			},
		},
	},
}));

import { Window } from "happy-dom";
import { browser } from "wxt/browser";
import {
	captureMarkerEarly,
	resetTabIdForTests,
	resolvePendingMarker,
	runDemoTour,
} from "@/lib/features/demo-tour";

// Original globals, restored per test — this file overwrites location/history/document,
// and bun:test shares them (and demo-tour.ts's module state) across every spec file.
const originalLocation = globalThis.location;
const originalHistory = globalThis.history;
const originalDocument = globalThis.document;

afterEach(() => {
	Object.defineProperty(globalThis, "location", {
		configurable: true,
		value: originalLocation,
	});
	Object.defineProperty(globalThis, "history", {
		configurable: true,
		value: originalHistory,
	});
	Object.defineProperty(globalThis, "document", {
		configurable: true,
		value: originalDocument,
	});
	resetTabIdForTests();
});

/** Swap in a happy-dom window's location/history/document. */
function withLocation(url: string): void {
	const win = new Window({ url });
	Object.defineProperty(globalThis, "location", {
		configurable: true,
		value: win.location,
	});
	Object.defineProperty(globalThis, "history", {
		configurable: true,
		value: win.history,
	});
	Object.defineProperty(globalThis, "document", {
		configurable: true,
		value: win.document,
	});
}

/** Record which named shadow-root surface runDemoTour requested, without rendering it. */
function fakeShadowRootUi(): void {
	Object.defineProperty(globalThis, "createShadowRootUi", {
		configurable: true,
		value: mock(async () => ({ mount: () => {}, remove: () => {} })),
	});
}

/** Map-backed get/set/remove so end state is assertable, not just "was called". */
function statefulStorage(): Map<string, unknown> {
	const store = new Map<string, unknown>();
	(browser.storage.local.get as ReturnType<typeof mock>).mockImplementation(
		(key: string) =>
			Promise.resolve(store.has(key) ? { [key]: store.get(key) } : {}),
	);
	(browser.storage.local.set as ReturnType<typeof mock>).mockImplementation(
		(obj: Record<string, unknown>) => {
			for (const [k, v] of Object.entries(obj)) store.set(k, v);
			return Promise.resolve();
		},
	);
	(browser.storage.local.remove as ReturnType<typeof mock>).mockImplementation(
		(key: string) => {
			store.delete(key);
			return Promise.resolve();
		},
	);
	return store;
}

describe("demo_pending write-after-remove (residual, TTL-bounded)", () => {
	/**
	 * The reverse interleaving of the leak this slice fixes: captureMarkerEarly's
	 * `set` (document_start, gated behind whoami's retry backoff) landing AFTER
	 * this same navigation's document_idle already claimed the pending key — e.g.
	 * because a client-side router replayed the fragment back onto the URL
	 * (slice 4's rhist.ts scenario) after captureMarkerEarly had stripped it.
	 * Fixed via a claim left in the pending key: the delayed write sees its own
	 * marker already claimed and drops it instead of resurrecting a finished tour.
	 */
	it("does not re-leak demo_pending when captureMarkerEarly's set resolves after document_idle's clearPendingMarker remove", async () => {
		const script: TourScript = {
			startUrl: "https://app.example/start",
			steps: [{ body: "Tour step" }],
		};
		const store = statefulStorage();
		const pendingKey = "demo_pending:20";
		const marked = `${script.startUrl}#${demoMarkerFragment(script, false)}`;
		withLocation(marked);
		let releaseWhoami: (() => void) | undefined;
		const whoamiGate = new Promise<void>((resolve) => {
			releaseWhoami = resolve;
		});
		let calls = 0;
		(browser.runtime.sendMessage as ReturnType<typeof mock>).mockImplementation(
			async () => {
				calls++;
				if (calls === 1) await whoamiGate;
				return { tabId: 20 };
			},
		);

		// document_start: strips the URL, then blocks on the slow whoami before
		// it can write the capture.
		const captureDone = captureMarkerEarly();
		// A client-side router replay re-appends the fragment before document_idle
		// re-reads the URL.
		withLocation(marked);
		fakeShadowRootUi();

		// document_idle: URL branch taken, claims the pending key (not yet written —
		// the capture is still blocked behind whoami). A claim is never consumable.
		await runDemoTour({} as Parameters<typeof runDemoTour>[0]);
		expect(
			resolvePendingMarker(
				store.get(pendingKey) as Parameters<typeof resolvePendingMarker>[0],
				marked,
				Date.now(),
			).action,
		).not.toBe("consume");

		// Now the delayed capture lands, sees its own claim, and drops it instead
		// of resurrecting a finished tour.
		releaseWhoami?.();
		await captureDone;

		expect(store.has(pendingKey)).toBe(false);
	});
});
