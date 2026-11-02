/**
 * Pure-function tests for review modal helpers extracted from demo-tour.ts.
 * No DOM or WebExtension APIs needed — pure logic only.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { toPlanMarkdown } from "@dg/common";
import { Window } from "happy-dom";
import { MSG } from "@/lib/demo-messages";
import type { TourScript } from "@/lib/demo-types";
import {
	demoMarkerFragment,
	readDemoScript,
	readEditFlag,
} from "@/utils/demo-marker";

// Stub WXT's browser export so demo-tour.ts can be imported in Bun's test environment.
mock.module("wxt/browser", () => ({
	browser: {
		runtime: {
			sendMessage: mock(() => Promise.resolve()),
			onMessage: {
				addListener: mock(() => {}),
				removeListener: mock(() => {}),
			},
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

import { browser } from "wxt/browser";
import { getNarrationMode } from "@/lib/config";
import {
	automaticPlayback,
	completeSetupPhase,
	draftToScript,
	editorInheritedPageUrl,
	editorPageUrl,
	editorReviewRows,
	editorSpotlightTarget,
	initialPlayPhase,
	initialPlayState,
	type PlayState,
} from "@dg/tour-ui";
import {
	captureMarkerEarly,
	rearmAfterDiscard,
	resetTabIdForTests,
	resolvePendingMarker,
	runDemoTour,
} from "@/lib/features/demo-tour";

const GLOBAL_KEYS = [
	"window",
	"document",
	"location",
	"history",
	"Event",
	"createShadowRootUi",
] as const;
const originalGlobals = new Map(
	GLOBAL_KEYS.map((key) => [
		key,
		Object.getOwnPropertyDescriptor(globalThis, key),
	]),
);

// bun:test shares module state across spec files, unlike the extension's per-tab realm.
beforeEach(() => {
	resetTabIdForTests();
});
afterEach(() => {
	resetTabIdForTests();
	(browser.runtime.sendMessage as ReturnType<typeof mock>).mockImplementation(
		() => Promise.resolve(),
	);
	(
		browser.runtime.onMessage.addListener as ReturnType<typeof mock>
	).mockImplementation(() => {});
	(browser.storage.local.get as ReturnType<typeof mock>).mockImplementation(
		() => Promise.resolve({}),
	);
	(browser.storage.local.set as ReturnType<typeof mock>).mockImplementation(
		() => Promise.resolve(),
	);
	(browser.storage.local.remove as ReturnType<typeof mock>).mockImplementation(
		() => Promise.resolve(),
	);
	for (const key of GLOBAL_KEYS) {
		const descriptor = originalGlobals.get(key);
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});

// ── getNarrationMode ────────────────────────────────────────────────────────

describe("getNarrationMode", () => {
	it("maps 'voice' to 'voice'", () => {
		expect(getNarrationMode("voice")).toBe("voice");
	});

	it("maps 'captions' to 'captions'", () => {
		expect(getNarrationMode("captions")).toBe("captions");
	});

	it("maps 'both' to 'both'", () => {
		expect(getNarrationMode("both")).toBe("both");
	});

	it("maps empty string to 'both'", () => {
		expect(getNarrationMode("")).toBe("both");
	});

	it("maps unrecognized value to 'both'", () => {
		expect(getNarrationMode("invalid")).toBe("both");
	});
});

// ── rearmAfterDiscard ───────────────────────────────────────────────────────

/**
 * Review lives in its own extension tab now, so a discard reaches this tab as a
 * message rather than a click. What it has to do is unchanged, and is still only
 * doable here: both outcomes are page overlays that need the content script's ctx.
 */
describe("rearmAfterDiscard", () => {
	const script: TourScript = {
		startUrl: "https://app.example",
		mode: "video",
		steps: [{ body: "Show dashboard" }, { body: "Show settings" }],
	};

	/** Record which named surface was mounted — enough to tell the two branches apart. */
	function mountedUiNames(): string[] {
		const names: string[] = [];
		Object.defineProperty(globalThis, "createShadowRootUi", {
			configurable: true,
			value: mock(async (_ctx: unknown, opts: { name: string }) => {
				names.push(opts.name);
				return { mount: () => {}, remove: () => {} };
			}),
		});
		return names;
	}

	function withState(state: PlayState | undefined): void {
		(browser.storage.local.get as ReturnType<typeof mock>).mockImplementation(
			(key: string) =>
				Promise.resolve(
					state && key === "demo_tour:-1" ? { [key]: state } : {},
				),
		);
	}

	/**
	 * Re-arm, then let the prompt finish mounting.
	 *
	 * `promptToRecord` is deliberately fire-and-forget in production — a prompt that
	 * fails to render must not reject the discard — so its overlay lands a tick later.
	 * Draining that tick here also keeps the unfinished work out of the next test.
	 */
	async function rearm(): Promise<void> {
		await rearmAfterDiscard({} as Parameters<typeof rearmAfterDiscard>[0]);
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	beforeEach(() => {
		(browser.storage.local.set as ReturnType<typeof mock>).mockClear();
		(browser.storage.local.remove as ReturnType<typeof mock>).mockClear();
	});

	it("clears the recording flag, so the tab prompts instead of resuming playback", async () => {
		withState({ script, index: 1 });
		mountedUiNames();

		await rearm();

		expect(browser.storage.local.remove).toHaveBeenCalledWith(
			"demo_recording:-1",
		);
	});

	it("rewinds to step 1 and re-shows the record prompt", async () => {
		withState({ script, index: 1 });
		const names = mountedUiNames();

		await rearm();

		expect(browser.storage.local.set).toHaveBeenCalledWith({
			"demo_tour:-1": expect.objectContaining({ index: 0 }),
		});
		expect(names).toContain("dg-demo-modal");
	});

	it("returns an editor-launched tour to the editor instead of the record prompt", async () => {
		// The editor mirrors its draft into the URL fragment, so it needs a real document.
		withLocation("https://app.example/start", { withDocument: true });
		withState({ script, index: 1, fromEdit: true });
		const names = mountedUiNames();

		await rearm();

		expect(names).toContain("dg-demo-edit");
		expect(names).not.toContain("dg-demo-modal");
		// The editor owns the script from here, so the playback state is dropped.
		expect(browser.storage.local.remove).toHaveBeenCalledWith("demo_tour:-1");
	});

	it("still offers the record prompt when no tour state survived", async () => {
		withState(undefined);
		const names = mountedUiNames();

		await rearm();

		expect(names).toContain("dg-demo-modal");
		expect(browser.storage.local.set).not.toHaveBeenCalled();
	});
});

describe("getNarrationMode — all valid values", () => {
	it("handles 'both'", () => {
		expect(getNarrationMode("both")).toBe("both");
	});

	it("handles 'voice'", () => {
		expect(getNarrationMode("voice")).toBe("voice");
	});

	it("handles 'captions'", () => {
		expect(getNarrationMode("captions")).toBe("captions");
	});
});

describe("setup playback initialization", () => {
	const excludedVideo: TourScript = {
		startUrl: "https://app.example/start",
		mode: "video",
		setup: {
			includeInTour: false,
			steps: [{ body: "Prepare the account", advance: 1 }],
		},
		steps: [{ body: "Show the dashboard" }],
	};

	it("initializes excluded setup first from a validated marker", () => {
		const markerUrl = `${excludedVideo.startUrl}#${demoMarkerFragment(excludedVideo, false)}`;
		const decoded = readDemoScript(markerUrl);

		expect(decoded).toEqual(excludedVideo);
		expect(decoded && initialPlayPhase(decoded)).toBe("setup");
	});

	it("initializes excluded setup first after editor serialization", () => {
		const draft: Parameters<typeof draftToScript>[1] = {
			title: "Edited setup",
			mode: "video",
			setup: {
				includeInTour: false,
				rows: [
					{
						title: "Prepare",
						selector: "",
						body: "Prepare the account",
						timing: "next",
						navigate: "",
						actKind: "",
						actText: "",
					},
				],
			},
			rows: [
				{
					title: "Tour",
					selector: "",
					body: "Show the dashboard",
					timing: "next",
					navigate: "",
					actKind: "",
					actText: "",
				},
			],
		};

		expect(initialPlayPhase(draftToScript(excludedVideo.startUrl, draft))).toBe(
			"setup",
		);
		const setup = draft.setup;
		expect(setup).toBeDefined();
		if (!setup) throw new Error("fixture setup is required");
		setup.includeInTour = true;
		expect(initialPlayPhase(draftToScript(excludedVideo.startUrl, draft))).toBe(
			"tutorial",
		);
	});

	it("hands setup state off to tutorial at cursor zero without setup action state", () => {
		const setupState: Parameters<typeof completeSetupPhase>[0] = {
			script: excludedVideo,
			phase: "setup",
			index: 1,
			acted: 1,
			setupActionsApproved: true,
			fromEdit: true,
		};
		const completed = completeSetupPhase(setupState);

		expect(automaticPlayback(setupState)).toBe(false);
		expect(automaticPlayback(completed)).toBe(true);
		expect(completed).toEqual({
			script: excludedVideo,
			phase: "tutorial",
			index: 0,
			acted: undefined,
			setupActionsApproved: true,
			fromEdit: true,
		});
	});
});

describe("DemoMarker trust", () => {
	const script: TourScript = {
		startUrl: "https://app.example/start",
		steps: [{ body: "Tour" }],
	};

	it("rejects malformed scripts and malformed setup selectors", () => {
		const missingSteps = `${script.startUrl}#${demoMarkerFragment({ startUrl: script.startUrl }, false)}`;
		const malformedSelector = `${script.startUrl}#${demoMarkerFragment(
			{
				...script,
				setup: {
					includeInTour: false,
					steps: [{ body: "Prepare", selector: 42 }],
				},
			},
			false,
		)}`;

		expect(readDemoScript(missingSteps)).toBeUndefined();
		expect(readDemoScript(malformedSelector)).toBeUndefined();
		expect(readDemoScript(`${script.startUrl}#_demo=not-json`)).toBeUndefined();
	});

	it("rejects a valid script whose startUrl is not bound to the marker origin", () => {
		const url = `https://attacker.example/#${demoMarkerFragment(script, false)}`;

		expect(readDemoScript(url)).toBeUndefined();
	});

	it("does not throw when a marker contains syntactically malformed CSS", () => {
		const malformedCss = {
			...script,
			steps: [{ body: "Tour", selector: "[" }],
		};
		const url = `${script.startUrl}#${demoMarkerFragment(malformedCss, false)}`;

		expect(() => readDemoScript(url)).not.toThrow();
		expect(readDemoScript(url)).toEqual(malformedCss);
	});
});

describe("editor security sinks", () => {
	it("does not throw when spotlighting malformed CSS", () => {
		const root = new Window().document;

		expect(() => editorSpotlightTarget(root, "[")).not.toThrow();
		expect(editorSpotlightTarget(root, "[")).toBeNull();
	});

	it("resets the first excluded tutorial row to startUrl after setup navigation", () => {
		const startUrl = "https://app.example/start";
		const draft: Parameters<typeof editorReviewRows>[0] = {
			title: "Boundary",
			mode: "walkthrough",
			setup: {
				includeInTour: false,
				rows: [
					{
						title: "Prepare",
						selector: "",
						body: "Prepare",
						timing: "next",
						navigate: "https://app.example/setup",
						actKind: "",
						actText: "",
					},
				],
			},
			rows: [
				{
					title: "Tour",
					selector: "",
					body: "Begin the tutorial",
					timing: "next",
					navigate: "",
					actKind: "",
					actText: "",
				},
			],
		};
		const firstTutorial = draft.setup?.rows.length ?? 0;

		expect(editorInheritedPageUrl(draft, startUrl, firstTutorial)).toBe(
			startUrl,
		);
		expect(editorPageUrl(draft, startUrl, firstTutorial)).toBe(startUrl);
	});
});

describe("resolvePendingMarker", () => {
	const script: TourScript = {
		startUrl: "https://app.example/start",
		steps: [{ body: "Tour" }],
	};
	const pending = { script, edit: false, capturedAt: 1_000 };

	it("leaves an absent capture untouched", () => {
		expect(
			resolvePendingMarker(undefined, "https://app.example/start", 1_500),
		).toEqual({
			action: "leave",
		});
	});

	it("consumes a fresh capture once back on the tour's own origin", () => {
		expect(
			resolvePendingMarker(pending, "https://app.example/callback", 1_500),
		).toEqual({
			action: "consume",
			capture: pending,
		});
	});

	it("drops a capture once it exceeds the TTL, regardless of origin", () => {
		const stale = 1_000 + 2 * 60 * 1000 + 1;

		expect(
			resolvePendingMarker(pending, "https://app.example/start", stale),
		).toEqual({
			action: "drop",
		});
	});

	it("leaves a not-yet-expired capture on a different origin (e.g. an IdP mid-redirect)", () => {
		expect(
			resolvePendingMarker(pending, "https://idp.example/login", 1_500),
		).toEqual({
			action: "leave",
		});
	});
});

/** Swap in a happy-dom window's location/history, optionally its document too. */
/** Retry `assert` until it passes, so a test waits on state rather than wall time. */
async function eventually(assert: () => void, timeoutMs = 3000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			assert();
			return;
		} catch (error) {
			if (Date.now() > deadline) throw error;
		}
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}

function withLocation(
	url: string,
	opts: { withDocument?: boolean } = {},
): void {
	const win = new Window({ url });
	Object.defineProperty(globalThis, "location", {
		configurable: true,
		value: win.location,
	});
	Object.defineProperty(globalThis, "history", {
		configurable: true,
		value: win.history,
	});
	if (opts.withDocument) {
		Object.defineProperty(globalThis, "window", {
			configurable: true,
			value: win,
		});
		Object.defineProperty(globalThis, "document", {
			configurable: true,
			value: win.document,
		});
	}
}

/** Answer whoami with `tabId`, or with nothing at all to simulate a lost round trip. */
function withTabId(tabId: number | null): void {
	(browser.runtime.sendMessage as ReturnType<typeof mock>).mockImplementation(
		() => Promise.resolve(tabId === null ? {} : { tabId }),
	);
}

describe("captureMarkerEarly", () => {
	beforeEach(() => {
		(browser.storage.local.set as ReturnType<typeof mock>).mockClear();
		(browser.storage.local.set as ReturnType<typeof mock>).mockImplementation(
			() => Promise.resolve(),
		);
		withTabId(7);
	});

	it("is a no-op when the current URL carries no marker", async () => {
		withLocation("https://app.example/start");

		await captureMarkerEarly();

		expect(browser.storage.local.set).not.toHaveBeenCalled();
		expect(location.href).toBe("https://app.example/start");
	});

	it("persists the marker per-tab and strips it from the URL", async () => {
		const script: TourScript = {
			startUrl: "https://app.example/start",
			steps: [{ body: "Tour" }],
		};
		withLocation(`${script.startUrl}#${demoMarkerFragment(script, false)}`);

		await captureMarkerEarly();

		expect(browser.storage.local.set).toHaveBeenCalledWith({
			"demo_pending:7": expect.objectContaining({
				script,
				edit: false,
				// Bounds the TTL check in resolvePendingMarker: a missing/non-numeric
				// capturedAt makes `now - capturedAt` NaN, so drop() never fires.
				capturedAt: expect.any(Number),
			}),
		});
		expect(location.href).toBe(script.startUrl);
	});

	it("captures the edit flag from the URL even though the strip runs first", async () => {
		const script: TourScript = {
			startUrl: "https://app.example/start",
			steps: [{ body: "Tour" }],
		};
		withLocation(`${script.startUrl}#${demoMarkerFragment(script, true)}`);

		await captureMarkerEarly();

		expect(browser.storage.local.set).toHaveBeenCalledWith({
			"demo_pending:7": expect.objectContaining({ edit: true }),
		});
	});

	it("restores the marker to the URL when the tab cannot be identified", async () => {
		const script: TourScript = {
			startUrl: "https://app.example/start",
			steps: [{ body: "Tour" }],
		};
		const marked = `${script.startUrl}#${demoMarkerFragment(script, false)}`;
		withLocation(marked);
		const seenAtWhoami: string[] = [];
		(browser.runtime.sendMessage as ReturnType<typeof mock>).mockImplementation(
			() => {
				seenAtWhoami.push(location.href);
				return Promise.resolve({});
			},
		);

		await captureMarkerEarly();

		// The strip already ran by the time whoami was asked (every retry)...
		expect(seenAtWhoami.length).toBeGreaterThan(0);
		for (const seen of seenAtWhoami)
			expect(readDemoScript(seen)).toBeUndefined();
		// ...but with no tab id to publish under, the marker is handed back rather
		// than lost from both the URL and storage at once.
		expect(browser.storage.local.set).not.toHaveBeenCalled();
		expect(location.href).toBe(marked);
	});

	/**
	 * The `edit:false` sibling above restores a fragment that is byte-identical
	 * whether the restore uses the captured `edit` or a hardcoded `false` —
	 * mutating the restore call to `demoMarkerFragment(script, false)` would
	 * still leave that test green. Only an `edit:true` capture tells them apart.
	 */
	it("restores the marker with edit:true when the tab cannot be identified", async () => {
		const script: TourScript = {
			startUrl: "https://app.example/start",
			steps: [{ body: "Tour" }],
		};
		withLocation(`${script.startUrl}#${demoMarkerFragment(script, true)}`);
		(browser.runtime.sendMessage as ReturnType<typeof mock>).mockImplementation(
			() => Promise.resolve({}),
		);

		await captureMarkerEarly();

		expect(browser.storage.local.set).not.toHaveBeenCalled();
		expect(readEditFlag(location.href)).toBe(true);
	});

	/**
	 * Reverting the strip to run after both awaits (the diagnosed bug) leaves every
	 * end-state assertion above green, because the URL is stripped either way by the
	 * time the function returns. Only a mid-flight read of `location.href` — taken by
	 * the mocks at the moment each await is invoked — can tell the orderings apart.
	 */
	it("has already stripped the marker before either the whoami round trip or the storage write begins", async () => {
		const script: TourScript = {
			startUrl: "https://app.example/start",
			steps: [{ body: "Tour" }],
		};
		withLocation(`${script.startUrl}#${demoMarkerFragment(script, false)}`);
		let seenAtWhoami: string | undefined;
		(browser.runtime.sendMessage as ReturnType<typeof mock>).mockImplementation(
			() => {
				seenAtWhoami = location.href;
				return Promise.resolve({ tabId: 7 });
			},
		);
		let seenAtSet: string | undefined;
		(browser.storage.local.set as ReturnType<typeof mock>).mockImplementation(
			() => {
				seenAtSet = location.href;
				return Promise.resolve();
			},
		);

		await captureMarkerEarly();

		expect(seenAtWhoami).toBeDefined();
		expect(readDemoScript(seenAtWhoami as string)).toBeUndefined();
		expect(seenAtSet).toBeDefined();
		expect(readDemoScript(seenAtSet as string)).toBeUndefined();
	});

	/**
	 * initTabId's bounded retry (mirroring sendToOffscreen in demo-recorder.ts) must
	 * actually recover from a transient failure, not merely give up after the first
	 * miss — a cold service worker on the first page load of a session is exactly
	 * the case the retry exists for.
	 */
	it("recovers once a retried whoami attempt gets a receiver, rather than giving up after the first miss", async () => {
		const script: TourScript = {
			startUrl: "https://app.example/start",
			steps: [{ body: "Tour" }],
		};
		withLocation(`${script.startUrl}#${demoMarkerFragment(script, false)}`);
		let attempts = 0;
		(browser.runtime.sendMessage as ReturnType<typeof mock>).mockImplementation(
			() => {
				attempts++;
				return attempts === 1
					? Promise.reject(new Error("no receiver"))
					: Promise.resolve({ tabId: 9 });
			},
		);

		await captureMarkerEarly();

		expect(attempts).toBeGreaterThanOrEqual(2);
		expect(browser.storage.local.set).toHaveBeenCalledWith({
			"demo_pending:9": expect.objectContaining({ script, edit: false }),
		});
		expect(location.href).toBe(script.startUrl);
	});
});

// ── The leak regression: demo_pending must be cleared regardless of which
// side of the race wins, and the edit flag must survive to pick editor vs tour ──

describe("runDemoTour — entry-marker resolution (document_idle)", () => {
	/**
	 * Stand in for WXT's shadow-root UI, recording which named surface was
	 * requested rather than rendering it — the tour ("dg-demo-tour" /
	 * "dg-demo-modal" / "dg-demo-setup-consent") and the editor ("dg-demo-edit")
	 * request different names, so this is enough to tell `begin()` apart from
	 * `showEditPanel()` without standing up a full DOM render.
	 */
	function fakeShadowRootUi(): string[] {
		const names: string[] = [];
		Object.defineProperty(globalThis, "createShadowRootUi", {
			configurable: true,
			value: mock(async (_ctx: unknown, opts: { name: string }) => {
				names.push(opts.name);
				return { mount: () => {}, remove: () => {} };
			}),
		});
		return names;
	}

	const script: TourScript = {
		startUrl: "https://app.example/start",
		steps: [{ body: "Tour step" }],
	};

	/** Map-backed get/set/remove so end state (not just "was called") is assertable. */
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
		(
			browser.storage.local.remove as ReturnType<typeof mock>
		).mockImplementation((key: string) => {
			store.delete(key);
			return Promise.resolve();
		});
		return store;
	}

	beforeEach(() => {
		(browser.storage.local.set as ReturnType<typeof mock>).mockClear();
		(browser.storage.local.remove as ReturnType<typeof mock>).mockClear();
		// Reset remove's impl: a prior test's mock otherwise leaks in (mockClear keeps it).
		(
			browser.storage.local.remove as ReturnType<typeof mock>
		).mockImplementation(() => Promise.resolve());
		(browser.storage.local.get as ReturnType<typeof mock>).mockImplementation(
			() => Promise.resolve({}),
		);
	});

	it("takes the URL branch and claims demo_pending so it can never resurrect — the leak this slice fixes", async () => {
		withTabId(11);
		withLocation(`${script.startUrl}#${demoMarkerFragment(script, false)}`, {
			withDocument: true,
		});
		const uiNames = fakeShadowRootUi();
		const store = statefulStorage();
		store.set("demo_pending:11", {
			script,
			edit: false,
			capturedAt: Date.now(),
		});
		store.set("demo_tour:11", initialPlayState(script, "marker"));

		await runDemoTour({} as Parameters<typeof runDemoTour>[0]);

		// The URL branch was taken: a fresh marker-sourced tour was persisted...
		expect(browser.storage.local.set).toHaveBeenCalledWith({
			"demo_tour:11": expect.objectContaining({ script, index: 0 }),
		});
		// ...and `demo_pending` is left as a claim, never consumable again as a
		// fresh tour start (real end state, not just a call a mock can't verify).
		expect(
			resolvePendingMarker(
				store.get("demo_pending:11") as Parameters<
					typeof resolvePendingMarker
				>[0],
				script.startUrl,
				Date.now(),
			).action,
		).not.toBe("consume");
		// It actually reached the tour surface (not silently bailing on missing
		// state), and the marker was stripped from the URL in place.
		expect(uiNames).toEqual(["dg-demo-tour"]);
		expect(location.href).toBe(script.startUrl);
	});

	/**
	 * Reverting the strip to run after `initializeMarkerPlayback` / `setRecording` (the
	 * same ordering hazard item (a) fixed in captureMarkerEarly) leaves every assertion
	 * above green, since the URL is stripped either way by the time the function
	 * returns. Only a mid-flight read of `location.href` — taken at the moment the
	 * storage write fires — can tell the orderings apart.
	 */
	it("has already stripped the marker before initializeMarkerPlayback's storage write begins", async () => {
		withTabId(16);
		withLocation(`${script.startUrl}#${demoMarkerFragment(script, false)}`, {
			withDocument: true,
		});
		fakeShadowRootUi();
		const store = statefulStorage();
		let seenAtSet: string | undefined;
		(browser.storage.local.set as ReturnType<typeof mock>).mockImplementation(
			(obj: Record<string, unknown>) => {
				seenAtSet ??= location.href;
				for (const [k, v] of Object.entries(obj)) store.set(k, v);
				return Promise.resolve();
			},
		);

		await runDemoTour({} as Parameters<typeof runDemoTour>[0]);

		expect(seenAtSet).toBeDefined();
		expect(readDemoScript(seenAtSet as string)).toBeUndefined();
	});

	it("consumes a pending capture with edit:true by reopening the editor, never the tour", async () => {
		withTabId(12);
		withLocation(script.startUrl, { withDocument: true }); // no marker on the URL itself
		const uiNames = fakeShadowRootUi();
		const pendingKey = "demo_pending:12";
		const store = statefulStorage();
		store.set(pendingKey, { script, edit: true, capturedAt: Date.now() });

		await runDemoTour({} as Parameters<typeof runDemoTour>[0]);

		expect(uiNames).toEqual(["dg-demo-edit"]);
		expect(store.has(pendingKey)).toBe(false);
	});

	it("consumes a pending capture with edit:false by starting the tour, never the editor", async () => {
		withTabId(13);
		withLocation(script.startUrl, { withDocument: true });
		const uiNames = fakeShadowRootUi();
		const pendingKey = "demo_pending:13";
		const store = statefulStorage();
		store.set(pendingKey, { script, edit: false, capturedAt: Date.now() });
		store.set("demo_tour:13", initialPlayState(script, "marker"));

		await runDemoTour({} as Parameters<typeof runDemoTour>[0]);

		// The positive half of "tour, never editor": it actually reached the tour
		// surface, not just "rendered nothing" (which an editor test asserts too).
		expect(uiNames).toEqual(["dg-demo-tour"]);
		expect(store.has(pendingKey)).toBe(false);
	});

	// The URL-branch tests above only exercise edit:false; `_edit=1` live in the URL
	// itself (not routed through a pending capture) was the untested combination.
	it("resolves _edit=1 straight from the URL (no pending capture involved) by opening the editor, not the tour", async () => {
		withTabId(14);
		withLocation(`${script.startUrl}#${demoMarkerFragment(script, true)}`, {
			withDocument: true,
		});
		const uiNames = fakeShadowRootUi();
		const store = statefulStorage();
		store.set("demo_pending:14", {
			script,
			edit: false,
			capturedAt: Date.now(),
		});

		await runDemoTour({} as Parameters<typeof runDemoTour>[0]);

		expect(uiNames).toEqual(["dg-demo-edit"]);
		// The URL branch claims demo_pending unconditionally, even though this
		// stale capture (edit:false) disagrees with the URL's own _edit=1.
		expect(
			resolvePendingMarker(
				store.get("demo_pending:14") as Parameters<
					typeof resolvePendingMarker
				>[0],
				script.startUrl,
				Date.now(),
			).action,
		).not.toBe("consume");
	});

	/**
	 * `edit` is snapshotted before claimPendingMarker's await — the same ordering
	 * hazard item (c) fixed in captureMarkerEarly, resurfaced one call away. A
	 * router that rewrites the fragment mid-await must not flip `edit` to false.
	 */
	it("keeps edit:true even when the URL is rewritten during claimPendingMarker's await", async () => {
		withTabId(15);
		withLocation(`${script.startUrl}#${demoMarkerFragment(script, true)}`, {
			withDocument: true,
		});
		const uiNames = fakeShadowRootUi();
		(browser.storage.local.set as ReturnType<typeof mock>).mockImplementation(
			async () => {
				// A client-side router rewrites the URL while the claim write is in flight.
				withLocation(script.startUrl, { withDocument: true });
			},
		);

		await runDemoTour({} as Parameters<typeof runDemoTour>[0]);

		expect(uiNames).toEqual(["dg-demo-edit"]);
	});

	/**
	 * The non-edit sibling above proves the strip runs; this proves the guard
	 * around it holds too — collapsing `if (!edit)` to an unconditional strip
	 * would leave every end-state assertion here green, since showEditPanel's
	 * own persist() rewrites the fragment again by the time the function
	 * returns. Only a mid-flight read, taken when the first storage write
	 * fires, catches it.
	 */
	it("still carries the _demo marker through the first storage write on the edit branch", async () => {
		withTabId(17);
		withLocation(`${script.startUrl}#${demoMarkerFragment(script, true)}`, {
			withDocument: true,
		});
		fakeShadowRootUi();
		const store = statefulStorage();
		let seenAtSet: string | undefined;
		(browser.storage.local.set as ReturnType<typeof mock>).mockImplementation(
			(obj: Record<string, unknown>) => {
				seenAtSet ??= location.href;
				for (const [k, v] of Object.entries(obj)) store.set(k, v);
				return Promise.resolve();
			},
		);

		await runDemoTour({} as Parameters<typeof runDemoTour>[0]);

		expect(seenAtSet).toBeDefined();
		expect(readDemoScript(seenAtSet as string)?.steps?.length).toBeGreaterThan(
			0,
		);
	});

	/**
	 * initTabId's refusal path (item d/e) reached from the document_idle entry
	 * point itself: runDemoTour must stay fully inert — no per-tab key written
	 * under any id, and the marker left exactly where it was for a later load to
	 * find, rather than the tour being silently lost.
	 */
	it("whoami failing at document_idle leaves the marker in the URL and touches no storage at all", async () => {
		withLocation(`${script.startUrl}#${demoMarkerFragment(script, false)}`, {
			withDocument: true,
		});
		(browser.runtime.sendMessage as ReturnType<typeof mock>).mockImplementation(
			() => Promise.resolve({}),
		);
		const uiNames = fakeShadowRootUi();
		const markedUrl = location.href;

		await runDemoTour({} as Parameters<typeof runDemoTour>[0]);

		expect(uiNames).toEqual([]);
		expect(browser.storage.local.set).not.toHaveBeenCalled();
		expect(browser.storage.local.remove).not.toHaveBeenCalled();
		expect(location.href).toBe(markedUrl);
	});
});

describe("video narration completion", () => {
	function videoHarness(
		tabId: number,
		script: TourScript,
		recording: boolean,
		durations: number[] = [],
	): {
		store: Map<string, unknown>;
		listener: (msg: {
			type?: string;
			index?: number;
			durations?: number[];
			hideBody?: boolean;
		}) => void;
	} {
		withTabId(tabId);
		withLocation(script.startUrl, { withDocument: true });
		const store = new Map<string, unknown>([
			[
				`demo_tour:${tabId}`,
				{
					script,
					index: 0,
					phase: "tutorial",
					videoDurations: durations,
				},
			],
			...(recording ? ([[`demo_recording:${tabId}`, true]] as const) : []),
		]);
		(browser.storage.local.get as ReturnType<typeof mock>).mockImplementation(
			(key: string) =>
				Promise.resolve(store.has(key) ? { [key]: store.get(key) } : {}),
		);
		(browser.storage.local.set as ReturnType<typeof mock>).mockImplementation(
			(value: Record<string, unknown>) => {
				for (const [key, next] of Object.entries(value)) store.set(key, next);
				return Promise.resolve();
			},
		);
		(
			browser.storage.local.remove as ReturnType<typeof mock>
		).mockImplementation((key: string) => {
			store.delete(key);
			return Promise.resolve();
		});
		type Listener = (msg: {
			type?: string;
			index?: number;
			durations?: number[];
			hideBody?: boolean;
		}) => void;
		const listeners = new Set<Listener>();
		(
			browser.runtime.onMessage.addListener as ReturnType<typeof mock>
		).mockImplementation((next: Listener) => {
			listeners.add(next);
		});
		(
			browser.runtime.onMessage.removeListener as ReturnType<typeof mock>
		).mockImplementation((next: Listener) => {
			listeners.delete(next);
		});
		Object.defineProperty(globalThis, "createShadowRootUi", {
			configurable: true,
			value: mock(
				async (
					_ctx: unknown,
					opts: { onMount: (root: HTMLElement) => void },
				) => {
					const root = document.createElement("div");
					return { mount: () => opts.onMount(root), remove: () => {} };
				},
			),
		});
		return {
			store,
			listener: (msg) => {
				for (const next of [...listeners]) next(msg);
			},
		};
	}

	it("ignores a stale index and runs the effect only after the current narration ends", async () => {
		const script: TourScript = {
			startUrl: "https://app.example/start",
			mode: "video",
			steps: [{ selector: "#target", body: "Open it", advance: "click" }],
		};
		const { listener } = videoHarness(70, script, true, [60_000]);
		document.body.innerHTML = '<button id="target"></button>';
		let clicks = 0;
		document
			.getElementById("target")
			?.addEventListener("click", () => clicks++);

		await runDemoTour({} as Parameters<typeof runDemoTour>[0]);
		listener({ type: MSG.narrationComplete, index: 69 });
		await Promise.resolve();
		expect(clicks).toBe(0);

		listener({ type: MSG.narrationComplete, index: 0 });
		await eventually(() => expect(clicks).toBe(1));
	});

	it("advances a captions-only timings tour when no completion signal arrives", async () => {
		const script: TourScript = {
			startUrl: "https://app.example/start",
			mode: "video",
			steps: [
				{ selector: "#target", body: "First", advance: "click" },
				{ selector: "#target", body: "Second", advance: "click" },
			],
		};
		const originalScript = JSON.stringify(script);
		const { store } = videoHarness(71, script, true, [1, 1]);
		document.body.innerHTML = '<button id="target"></button>';
		let clicks = 0;
		document
			.getElementById("target")
			?.addEventListener("click", () => clicks++);

		await runDemoTour({} as Parameters<typeof runDemoTour>[0]);
		await eventually(() => {
			expect(clicks).toBe(2);
			expect((store.get("demo_tour:71") as PlayState | undefined)?.index).toBe(
				2,
			);
		});

		expect(
			JSON.stringify(
				(store.get("demo_tour:71") as PlayState | undefined)?.script,
			),
		).toBe(originalScript);
		expect((store.get("demo_tour:71") as PlayState | undefined)?.index).toBe(2);
	});

	it("persists recorder durations and voice-only display state for navigation reloads", async () => {
		const script: TourScript = {
			startUrl: "https://app.example/start",
			mode: "video",
			steps: [{ body: "First" }, { body: "Second" }],
		};
		const { store, listener } = videoHarness(72, script, false);

		await runDemoTour({} as Parameters<typeof runDemoTour>[0]);
		listener({
			type: MSG.videoStart,
			durations: [1200, 2400],
			hideBody: true,
		});

		await eventually(() =>
			expect(store.get("demo_tour:72")).toMatchObject({
				index: 0,
				videoDurations: [1200, 2400],
				videoHideBody: true,
			}),
		);
	});
});

describe("runDemoTour through runTour", () => {
	type Listener = (msg: Record<string, unknown>) => void;

	function harness(tabId: number, state?: PlayState, recording = false) {
		withTabId(tabId);
		withLocation("https://app.example/start", { withDocument: true });
		const store = new Map<string, unknown>();
		if (state) store.set(`demo_tour:${tabId}`, state);
		if (recording) store.set(`demo_recording:${tabId}`, true);
		(browser.storage.local.get as ReturnType<typeof mock>).mockImplementation(
			(key: string) =>
				Promise.resolve(store.has(key) ? { [key]: store.get(key) } : {}),
		);
		(browser.storage.local.set as ReturnType<typeof mock>).mockImplementation(
			(value: Record<string, unknown>) => {
				for (const [key, next] of Object.entries(value)) store.set(key, next);
				return Promise.resolve();
			},
		);
		(
			browser.storage.local.remove as ReturnType<typeof mock>
		).mockImplementation((key: string) => {
			store.delete(key);
			return Promise.resolve();
		});
		const listeners = new Set<Listener>();
		(
			browser.runtime.onMessage.addListener as ReturnType<typeof mock>
		).mockImplementation((next: Listener) => {
			listeners.add(next);
		});
		(
			browser.runtime.onMessage.removeListener as ReturnType<typeof mock>
		).mockImplementation((next: Listener) => {
			listeners.delete(next);
		});
		const sent: Array<{ type?: string; index?: number }> = [];
		(browser.runtime.sendMessage as ReturnType<typeof mock>).mockImplementation(
			(msg: { type?: string }) => {
				sent.push(msg);
				return Promise.resolve(
					msg.type === MSG.whoami ? { tabId } : undefined,
				);
			},
		);
		const mounts: Array<{ name: string; root: HTMLElement; live: boolean }> =
			[];
		Object.defineProperty(globalThis, "createShadowRootUi", {
			configurable: true,
			value: mock(
				async (
					_ctx: unknown,
					opts: { name: string; onMount: (root: HTMLElement) => void },
				) => {
					const entry = {
						name: opts.name,
						root: document.createElement("div"),
						live: true,
					};
					mounts.push(entry);
					return {
						mount: () => opts.onMount(entry.root),
						remove: () => {
							entry.live = false;
						},
					};
				},
			),
		});
		const live = () => mounts.filter((m) => m.live);
		const click = (pattern: RegExp): void => {
			const found = live()
				.flatMap((m) => [...m.root.querySelectorAll("button")])
				.find(
					(b) =>
						pattern.test(b.textContent ?? "") ||
						pattern.test(b.getAttribute("aria-label") ?? ""),
				);
			if (!found) throw new Error(`no live button matching ${pattern}`);
			found.click();
		};
		return {
			store,
			sent,
			mounts,
			live,
			click,
			text: () => live().map((m) => m.root.textContent ?? "").join("\n"),
			emit: (msg: Record<string, unknown>) => {
				for (const next of [...listeners]) next(msg);
			},
		};
	}

	const ctx = {} as Parameters<typeof runDemoTour>[0];

	it("asks for consent before marker-authored actions", async () => {
		const script: TourScript = {
			startUrl: "https://app.example/start",
			steps: [{ body: "Press it", action: { do: "click" } }],
		};
		const h = harness(80, initialPlayState(script, "marker"));

		await runDemoTour(ctx);

		expect(h.live().map((m) => m.name)).toEqual(["dg-demo-setup-consent"]);
	});

	it("plays a walkthrough to the end card without any recorder message", async () => {
		const script: TourScript = {
			startUrl: "https://app.example/start",
			steps: [{ body: "Only step" }],
		};
		const h = harness(81, initialPlayState(script, "marker"));

		await runDemoTour(ctx);
		h.click(/^Done$/);
		await eventually(() => expect(h.text()).toContain("Walkthrough complete"));

		expect(h.store.has("demo_tour:81")).toBe(true);
		expect(h.sent.map((m) => m.type)).toEqual([MSG.whoami]);
		h.click(/Close/);
		await eventually(() => expect(h.store.has("demo_tour:81")).toBe(false));
	});

	it("prompts to record, then plays on the recorder's start and cues each step", async () => {
		const script: TourScript = {
			startUrl: "https://app.example/start",
			mode: "video",
			steps: [{ body: "First" }],
		};
		const h = harness(82, initialPlayState(script, "marker"));

		await runDemoTour(ctx);
		await eventually(() => expect(h.text()).toContain("Video demo ready"));
		expect(h.live().map((m) => m.name)).toEqual(["dg-demo-modal"]);
		h.emit({ type: MSG.videoStart, durations: [5], hideBody: false });

		await eventually(() =>
			expect(h.sent).toContainEqual({ type: MSG.playStep, index: 0 }),
		);
		await eventually(() => {
			expect(h.text()).toContain("Wrapping up");
			expect(h.sent).toContainEqual({ type: MSG.videoStop });
		});
		expect(h.store.get("demo_recording:82")).toBe(true);
		expect(h.store.has("demo_tour:82")).toBe(true);
	});

	it("clears the tour and says so once the recording is saved", async () => {
		const script: TourScript = {
			startUrl: "https://app.example/start",
			mode: "video",
			steps: [{ body: "First" }],
		};
		const h = harness(83, initialPlayState(script, "marker"));

		await runDemoTour(ctx);
		h.emit({ type: MSG.videoSaved, filename: "dg-demo/take.webm" });

		await eventually(() => expect(h.text()).toContain("Recording saved"));
		expect(h.store.has("demo_tour:83")).toBe(false);
		expect(h.store.has("demo_recording:83")).toBe(false);
	});

	it("shows narration progress on the preparing notice", async () => {
		const script: TourScript = {
			startUrl: "https://app.example/start",
			mode: "video",
			steps: [{ body: "First" }],
		};
		const h = harness(84, initialPlayState(script, "marker"));

		await runDemoTour(ctx);
		h.emit({ type: MSG.videoPreparing, narrate: true });
		await eventually(() => expect(h.text()).toContain("Preparing narration"));
		h.emit({ type: MSG.narrationProgress, progress: 42, label: "Voicing" });

		await eventually(() => expect(h.text()).toContain("Voicing · 42%"));
	});
});

// ── Slice 3: planning stepper jump controls («»load) and add/remove steps ──
// Not yet implemented — RED until the editor stepper grows these affordances.

describe("showEditPanel — planning stepper « » and add/remove (slice 3)", () => {
	const script: TourScript = {
		startUrl: "https://app.example/start",
		mode: "walkthrough",
		steps: [
			{ selector: "#s0", body: "One", advance: "click" },
			{ selector: "#s1", body: "Two", advance: "click" },
			{ selector: "#s2", body: "Three", advance: "click" },
		],
	};

	/** Unlike fakeShadowRootUi above, actually invokes onMount into a live
	 *  container — these tests assert on the stepper's own rendered DOM. */
	function renderingShadowRootUi(): HTMLElement[] {
		const containers: HTMLElement[] = [];
		Object.defineProperty(globalThis, "createShadowRootUi", {
			configurable: true,
			value: mock(
				async (
					_ctx: unknown,
					opts: { onMount: (root: HTMLElement) => void },
				) => {
					const container = document.createElement("div");
					containers.push(container);
					return { mount: () => opts.onMount(container), remove: () => {} };
				},
			),
		});
		return containers;
	}

	/** Map-backed get/set/remove so a stored edit cursor is honored on open,
	 *  and a later `runDemoTour` call (simulating a reload) sees prior writes. */
	function statefulLocalStorage(): Map<string, unknown> {
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
		(
			browser.storage.local.remove as ReturnType<typeof mock>
		).mockImplementation((key: string) => {
			store.delete(key);
			return Promise.resolve();
		});
		return store;
	}

	const buttonByLabel = (root: HTMLElement, label: string): HTMLButtonElement =>
		root.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;
	// "✓ Approve" is a plain pillButton with no aria-label — find it by text instead.
	const buttonByText = (root: HTMLElement, text: string): HTMLButtonElement =>
		[...root.querySelectorAll("button")].find(
			(b) => b.textContent === text,
		) as HTMLButtonElement;

	/** Open the editor at step `cursor` via runDemoTour's edit branch. */
	async function openEditorAtStep(
		tabId: number,
		cursor: number,
		store: Map<string, unknown>,
	): Promise<HTMLElement[]> {
		withTabId(tabId);
		withLocation(`${script.startUrl}#${demoMarkerFragment(script, true)}`, {
			withDocument: true,
		});
		store.set(`demo_edit:${tabId}`, cursor);
		const containers = renderingShadowRootUi();
		document.body.innerHTML =
			'<button id="s0"></button><button id="s1"></button><button id="s2"></button>';
		await runDemoTour({} as Parameters<typeof runDemoTour>[0]);
		return containers;
	}

	it("» advances to the last row, performing each step's action on the way", async () => {
		const store = statefulLocalStorage();
		const clicks = { s0: 0, s1: 0, s2: 0 };
		const containers = await openEditorAtStep(40, 0, store);
		for (const id of ["s0", "s1", "s2"] as const) {
			document
				.getElementById(id)
				?.addEventListener("click", () => clicks[id]++);
		}
		const root = containers[containers.length - 1];

		const jumpForward = buttonByLabel(root, "Run to the last step");
		expect(jumpForward).not.toBeNull();
		jumpForward.click();
		await eventually(() => {
			expect(clicks).toEqual({ s0: 1, s1: 1, s2: 1 });
			const last = containers[containers.length - 1];
			expect(last.textContent).toContain("3 / 3");
		});
	});

	it("« returns to the first step and re-enters the editor, not the tour", async () => {
		const store = statefulLocalStorage();
		const containers = await openEditorAtStep(41, 2, store);
		const root = containers[containers.length - 1];

		const jumpBack = buttonByLabel(root, "Restart at the first step");
		expect(jumpBack).not.toBeNull();
		jumpBack.click();
		await eventually(() => expect(store.get("demo_edit:41")).toBe(0));

		// A reload, not an in-memory jump: simulate the next page load and confirm
		// it re-enters the editor (never the walkthrough) sitting on step 1.
		const uiNames: string[] = [];
		Object.defineProperty(globalThis, "createShadowRootUi", {
			configurable: true,
			value: mock(async (_ctx: unknown, opts: { name: string }) => {
				uiNames.push(opts.name);
				return { mount: () => {}, remove: () => {} };
			}),
		});
		await runDemoTour({} as Parameters<typeof runDemoTour>[0]);

		expect(uiNames).toEqual(["dg-demo-edit"]);
	});

	it("adding a step then approving serializes the new step", async () => {
		const store = statefulLocalStorage();
		const containers = await openEditorAtStep(42, 0, store);
		const root = containers[containers.length - 1];

		const addStep = buttonByLabel(root, "Add step");
		expect(addStep).not.toBeNull();
		addStep.click();
		await eventually(() => {
			// draftToScript is the single serialization path (persist() mirrors it into
			// the URL on every edit) — the added row must show up there.
			expect(readDemoScript(location.href)?.steps.length).toBe(
				script.steps.length + 1,
			);
		});
	});

	it("removing the row the cursor is on leaves a valid cursor and omits it from the draft", async () => {
		const store = statefulLocalStorage();
		const containers = await openEditorAtStep(43, 2, store);
		const root = containers[containers.length - 1];

		const removeStep = buttonByLabel(root, "Remove step");
		expect(removeStep).not.toBeNull();
		removeStep.click();
		await eventually(() => {
			expect(readDemoScript(location.href)?.steps.length).toBe(
				script.steps.length - 1,
			);
			const last = containers[containers.length - 1];
			expect(last.textContent).toContain("2 / 2");
		});
	});

	it("removing the last remaining row leaves a valid cursor", async () => {
		const single: TourScript = {
			startUrl: "https://app.example/start",
			mode: "walkthrough",
			steps: [{ selector: "#s0", body: "Only one" }],
		};
		withTabId(44);
		withLocation(`${single.startUrl}#${demoMarkerFragment(single, true)}`, {
			withDocument: true,
		});
		const store = statefulLocalStorage();
		store.set("demo_edit:44", 0);
		const containers = renderingShadowRootUi();

		await runDemoTour({} as Parameters<typeof runDemoTour>[0]);
		const root = containers[containers.length - 1];
		const removeStep = buttonByLabel(root, "Remove step");
		expect(removeStep).not.toBeNull();
		removeStep.click();
		await eventually(() => {
			const last = containers[containers.length - 1];
			expect(last.textContent).not.toContain("NaN");
			expect(last.textContent ?? "").toMatch(/\d+ \/ \d+/);
		});
	});

	// The sibling test above only proves a *reload* re-enters the editor; its own
	// comment promises "sitting on step 1" but never checks it — close that gap.
	it("« resumes the editor sitting on the first step, not wherever it was pressed from", async () => {
		const store = statefulLocalStorage();
		const containers = await openEditorAtStep(45, 2, store);
		const root = containers[containers.length - 1];

		const jumpBack = buttonByLabel(root, "Restart at the first step");
		expect(jumpBack).not.toBeNull();
		jumpBack.click();
		await eventually(() => expect(store.get("demo_edit:45")).toBe(0));

		const reentered = renderingShadowRootUi();
		await runDemoTour({} as Parameters<typeof runDemoTour>[0]);
		const resumed = reentered[reentered.length - 1];
		expect(resumed.textContent).toContain("1 / 3");
		expect(buttonByLabel(resumed, "Previous step").disabled).toBe(true);
	});

	// The existing remove tests both put the cursor on the *last* row; exercise an
	// interior removal too, without pinning the (unratified) exact landing index.
	it("removing a middle row (cursor not on the last row) leaves a well-formed cursor", async () => {
		const store = statefulLocalStorage();
		const containers = await openEditorAtStep(48, 1, store);
		const root = containers[containers.length - 1];

		const removeStep = buttonByLabel(root, "Remove step");
		expect(removeStep).not.toBeNull();
		removeStep.click();
		await eventually(() => {
			expect(readDemoScript(location.href)?.steps.length).toBe(
				script.steps.length - 1,
			);
			const last = containers[containers.length - 1];
			expect(last.textContent).not.toContain("NaN");
			expect(last.textContent ?? "").toMatch(/\d+ \/ 2/);
		});
	});

	it("removing a step, then clicking Approve, carries the reduced count onto the done screen", async () => {
		const store = statefulLocalStorage();
		const containers = await openEditorAtStep(46, 2, store);
		const root = containers[containers.length - 1];

		const removeStep = buttonByLabel(root, "Remove step");
		expect(removeStep).not.toBeNull();
		removeStep.click();
		await eventually(() =>
			expect(containers[containers.length - 1].textContent).toContain("/ 2"),
		);

		const approve = buttonByText(
			containers[containers.length - 1],
			"✓ Approve",
		);
		expect(approve).toBeTruthy();
		approve.click();
		await eventually(() => {
			const done = containers[containers.length - 1];
			expect(done.textContent).toContain(`${script.steps.length - 1} step(s)`);
		});
	});

	it("adding a step, then clicking Approve, carries the increased count onto the done screen", async () => {
		const store = statefulLocalStorage();
		const containers = await openEditorAtStep(47, 0, store);
		const root = containers[containers.length - 1];

		const addStep = buttonByLabel(root, "Add step");
		expect(addStep).not.toBeNull();
		addStep.click();
		await eventually(() =>
			expect(containers[containers.length - 1].textContent).toContain("/ 4"),
		);

		const approve = buttonByText(
			containers[containers.length - 1],
			"✓ Approve",
		);
		expect(approve).toBeTruthy();
		approve.click();
		await eventually(() => {
			const done = containers[containers.length - 1];
			expect(done.textContent).toContain(`${script.steps.length + 1} step(s)`);
		});
	});

	it("disables « on the first row and » on the last row", async () => {
		const store = statefulLocalStorage();
		const atStart = await openEditorAtStep(49, 0, store);
		const startRoot = atStart[atStart.length - 1];
		expect(buttonByLabel(startRoot, "Restart at the first step").disabled).toBe(
			true,
		);
		expect(buttonByLabel(startRoot, "Run to the last step").disabled).toBe(
			false,
		);

		const atEnd = await openEditorAtStep(50, script.steps.length - 1, store);
		const endRoot = atEnd[atEnd.length - 1];
		expect(buttonByLabel(endRoot, "Restart at the first step").disabled).toBe(
			false,
		);
		expect(buttonByLabel(endRoot, "Run to the last step").disabled).toBe(true);
	});

	// jumpToEnd must resume from the machine's own cursor, not replay from row 0 —
	// otherwise a step already passed on the way to the editor gets re-acted.
	it("» started mid-stream only performs actions for rows from the cursor onward", async () => {
		const store = statefulLocalStorage();
		const clicks = { s0: 0, s1: 0, s2: 0 };
		const containers = await openEditorAtStep(51, 1, store);
		for (const id of ["s0", "s1", "s2"] as const) {
			document
				.getElementById(id)
				?.addEventListener("click", () => clicks[id]++);
		}
		const root = containers[containers.length - 1];

		buttonByLabel(root, "Run to the last step").click();
		await eventually(() => {
			expect(clicks).toEqual({ s0: 0, s1: 1, s2: 1 });
			const last = containers[containers.length - 1];
			expect(last.textContent).toContain("3 / 3");
		});
	});

	it("records a click-navigation in the draft and serialized plan without markers", async () => {
		const store = statefulLocalStorage();
		const containers = await openEditorAtStep(57, 0, store);
		document.getElementById("s0")?.addEventListener("click", () => {
			history.pushState(
				history.state,
				"",
				`https://app.example/landed#${demoMarkerFragment(script, false)}`,
			);
		});

		buttonByLabel(containers[containers.length - 1], "Next step").click();
		await eventually(() =>
			expect(readDemoScript(location.href)?.steps[1]?.navigate).toBeDefined(),
		);

		const captured = readDemoScript(location.href);
		expect(captured?.steps[0]?.navigate).toBeUndefined();
		expect(captured?.steps[1]?.navigate).toBe("https://app.example/landed");
		expect(captured?.steps[1]?.navigate).not.toContain("_demo");
		expect(toPlanMarkdown(captured as TourScript)).toContain(
			"https://app.example/landed",
		);

		resetTabIdForTests();
		withTabId(58);
		withLocation("https://app.example/landed", { withDocument: true });
		document.body.innerHTML = '<button id="s1"></button>';
		const replayStore = statefulLocalStorage();
		replayStore.set("demo_tour:58", {
			script: captured,
			index: 1,
			phase: "tutorial",
		});
		const uiNames: string[] = [];
		Object.defineProperty(globalThis, "createShadowRootUi", {
			configurable: true,
			value: mock(async (_ctx: unknown, opts: { name: string }) => {
				uiNames.push(opts.name);
				return { mount: () => {}, remove: () => {} };
			}),
		});

		await runDemoTour({} as Parameters<typeof runDemoTour>[0]);

		expect(location.href).toBe("https://app.example/landed");
		expect(uiNames).toEqual(["dg-demo-tour"]);
	});

	it("carries the draft and next-row cursor through an anchor navigation", async () => {
		const store = statefulLocalStorage();
		const containers = await openEditorAtStep(60, 0, store);
		const button = document.getElementById("s0");
		const anchor = document.createElement("a");
		anchor.id = "s0";
		anchor.href = "https://app.example/landed";
		button?.replaceWith(anchor);

		buttonByLabel(containers[containers.length - 1], "Next step").click();
		await eventually(() => {
			expect(location.href).toBe("https://app.example/landed");
			const continuation = store.get("demo_pending:60") as {
				script: TourScript;
				edit: boolean;
			};
			expect(continuation.script.steps[1]?.navigate).toBe(
				"https://app.example/landed",
			);
			expect(continuation.edit).toBe(true);
			expect(store.get("demo_edit:60")).toBe(1);
		});
	});

	it("leaves navigate empty when the planning click stays on the same page", async () => {
		const store = statefulLocalStorage();
		const containers = await openEditorAtStep(59, 0, store);

		buttonByLabel(containers[containers.length - 1], "Next step").click();
		await eventually(() => {
			expect(readDemoScript(location.href)?.steps[0]?.navigate).toBeUndefined();
		});
	});

	it("adding a step inserts it immediately after the cursor's row, not at the end", async () => {
		const store = statefulLocalStorage();
		const containers = await openEditorAtStep(52, 1, store);
		const root = containers[containers.length - 1];

		buttonByLabel(root, "Add step").click();
		await eventually(() => {
			const steps = readDemoScript(location.href)?.steps ?? [];
			expect(steps.map((s) => s.body)).toEqual(["One", "Two", "", "Three"]);
		});
	});

	it("removing the cursor's row removes exactly that row, not the first or last by default", async () => {
		const store = statefulLocalStorage();
		const containers = await openEditorAtStep(53, 1, store);
		const root = containers[containers.length - 1];

		buttonByLabel(root, "Remove step").click();
		await eventually(() => {
			const steps = readDemoScript(location.href)?.steps ?? [];
			expect(steps.map((s) => s.body)).toEqual(["One", "Three"]);
		});
	});

	// Add/remove must resolve the section (setup vs tutorial) from the cursor's
	// own row, not always one or the other — exercise both sides of that branch.
	describe("with a setup section present", () => {
		const scriptWithSetup: TourScript = {
			startUrl: "https://app.example/prep",
			mode: "walkthrough",
			setup: {
				includeInTour: false,
				steps: [{ selector: "#prep", body: "Prep" }],
			},
			steps: [
				{ selector: "#t0", body: "Tut one" },
				{ selector: "#t1", body: "Tut two" },
			],
		};

		/** Open the editor on `scriptWithSetup` at `cursor` (setup rows come first). */
		async function openWithSetupAtStep(
			tabId: number,
			cursor: number,
		): Promise<HTMLElement[]> {
			withTabId(tabId);
			withLocation(
				`${scriptWithSetup.startUrl}#${demoMarkerFragment(scriptWithSetup, true)}`,
				{ withDocument: true },
			);
			statefulLocalStorage().set(`demo_edit:${tabId}`, cursor);
			const containers = renderingShadowRootUi();
			await runDemoTour({} as Parameters<typeof runDemoTour>[0]);
			return containers;
		}

		it("adding a step while the cursor is on a setup row lands in the setup section", async () => {
			const containers = await openWithSetupAtStep(54, 0);
			const root = containers[containers.length - 1];

			buttonByLabel(root, "Add step").click();
			await eventually(() => {
				const out = readDemoScript(location.href);
				expect(out?.setup?.steps.length).toBe(2);
				expect(out?.steps.length).toBe(2);
			});
		});

		it("adding a step while the cursor is on a tutorial row lands in the tutorial section, even with setup present", async () => {
			const containers = await openWithSetupAtStep(55, 1);
			const root = containers[containers.length - 1];

			buttonByLabel(root, "Add step").click();
			await eventually(() => {
				const out = readDemoScript(location.href);
				expect(out?.setup?.steps.length).toBe(1);
				expect(out?.steps.length).toBe(3);
			});
		});

		it("removing the only setup row omits setup from the serialized script and leaves tutorial rows untouched", async () => {
			const containers = await openWithSetupAtStep(56, 0);
			const root = containers[containers.length - 1];

			buttonByLabel(root, "Remove step").click();
			await eventually(() => {
				const out = readDemoScript(location.href);
				expect(out?.setup).toBeUndefined();
				expect(out?.steps.map((s) => s.body)).toEqual(["Tut one", "Tut two"]);
			});
		});
	});
});
