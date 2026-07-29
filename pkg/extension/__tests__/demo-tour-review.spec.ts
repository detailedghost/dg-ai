/**
 * Pure-function tests for review modal helpers extracted from demo-tour.ts.
 * No DOM or WebExtension APIs needed — pure logic only.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { toPlanMarkdown } from "@dg/common";
import { Window } from "happy-dom";
import { MSG } from "@/lib/demo-messages";
import type { TourScript, TourStep } from "@/lib/demo-types";
import { holdFor } from "@/lib/video-timing";
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

import { browser } from "wxt/browser";
import { getNarrationMode } from "@/lib/config";
import {
	advanceClickNeeded,
	automaticActionConsentGranted,
	automaticActionConsentRequired,
	automaticPlayback,
	buildOverlay,
	buildVideoReviewHtml,
	captureMarkerEarly,
	completeSetupPhase,
	draftToScript,
	type EditEvent,
	type EditPhase,
	editMachine,
	editorInheritedPageUrl,
	editorPageUrl,
	editorReviewRows,
	editorSpotlightTarget,
	handleTourMessage,
	handoffCompletedSetup,
	initializeMarkerPlayback,
	initializeReviewedEditorPlayback,
	initialPlayPhase,
	initialPlayState,
	maybePerformAction,
	maybePerformStepEffect,
	missingActionTargetWarning,
	type PlayState,
	performAction,
	recordingStartState,
	resetTabIdForTests,
	resolvePendingMarker,
	restartState,
	reviewAction,
	runDemoTour,
	runVideoStepSequence,
	scriptToDraft,
	setupActionConsentRequired,
	stepEffect,
	type TourState,
} from "@/lib/features/demo-tour";

const baseState: TourState = {};
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

// ── reviewAction ────────────────────────────────────────────────────────────

describe("reviewAction", () => {
	it("'confirm' returns object with type === MSG.videoConfirmDownload", () => {
		expect(reviewAction("confirm").type).toBe(MSG.videoConfirmDownload);
	});

	it("'discard' returns object with type === MSG.videoDiscard", () => {
		expect(reviewAction("discard").type).toBe(MSG.videoDiscard);
	});
});

// ── handleTourMessage ───────────────────────────────────────────────────────

describe("handleTourMessage", () => {
	it("MSG.videoReview → { showingReview: true }", () => {
		expect(handleTourMessage(MSG.videoReview, baseState)).toEqual({
			showingReview: true,
		});
	});

	it("MSG.videoSaved → { showingReview: false }", () => {
		expect(handleTourMessage(MSG.videoSaved, baseState)).toEqual({
			showingReview: false,
		});
	});

	it("unknown type → null", () => {
		expect(handleTourMessage("unknown-type", baseState)).toBeNull();
	});
});

// ── buildVideoReviewHtml ────────────────────────────────────────────────────

describe("buildVideoReviewHtml", () => {
	it("contains the slug name", () => {
		expect(buildVideoReviewHtml("my-demo", true)).toContain("my-demo");
	});

	it("contains <video when hasVideo is true", () => {
		expect(buildVideoReviewHtml("my-demo", true)).toContain("<video");
	});

	it("contains a Download button", () => {
		expect(buildVideoReviewHtml("my-demo", true)).toContain("Download");
	});

	it("contains a Discard button", () => {
		expect(buildVideoReviewHtml("my-demo", true)).toContain("Discard");
	});

	it("does NOT contain <video when hasVideo is false", () => {
		expect(buildVideoReviewHtml("my-demo", false)).not.toContain("<video");
	});
});

// ── Additional behavior ────────────────────────────────────────────────────

describe("handleTourMessage — coverage gaps", () => {
	it("MSG.videoDiscard → { showingReview: false }", () => {
		expect(handleTourMessage(MSG.videoDiscard, baseState)).toEqual({
			showingReview: false,
		});
	});
});

describe("buildVideoReviewHtml — id attributes", () => {
	it("contains dg-review-download id", () => {
		expect(buildVideoReviewHtml("my-slug", true)).toContain(
			"dg-review-download",
		);
	});

	it("contains dg-review-discard id", () => {
		expect(buildVideoReviewHtml("my-slug", true)).toContain(
			"dg-review-discard",
		);
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

// ── editMachine (review stepper) ────────────────────────────────────────────

describe("editMachine", () => {
	// Prime, then feed events; returns the phase after each event.
	const run = (total: number, events: EditEvent[]): EditPhase => {
		const m = editMachine(total);
		let phase = m.next().value;
		for (const e of events) phase = m.next(e).value;
		return phase;
	};

	// The actions screen is the entry point: running a good plan shouldn't require
	// paging through every step first.
	it("primes on the actions screen, not step 0", () => {
		expect(editMachine(3).next().value).toEqual({ kind: "done" });
	});

	it("editAgain opens the stepper at the first step", () => {
		expect(run(3, ["editAgain"])).toEqual({ kind: "step", cursor: 0 });
	});

	it("advances and clamps at the last step", () => {
		expect(run(3, ["editAgain", "next", "next"])).toEqual({
			kind: "step",
			cursor: 2,
		});
		expect(run(3, ["editAgain", "next", "next", "next"])).toEqual({
			kind: "step",
			cursor: 2,
		});
	});

	it("goes back and clamps at 0", () => {
		expect(run(3, ["editAgain", "next", "back", "back"])).toEqual({
			kind: "step",
			cursor: 0,
		});
	});

	it("approve returns to the actions screen from any step", () => {
		expect(run(3, ["editAgain", "next", "approve"])).toEqual({ kind: "done" });
	});

	it("ignores next/back on the actions screen", () => {
		expect(run(3, ["next", "back"])).toEqual({ kind: "done" });
		expect(run(3, ["editAgain", "approve", "next", "back"])).toEqual({
			kind: "done",
		});
	});
});

describe("draftToScript", () => {
	it("preserves setup steps and the inclusion toggle from the editor draft", () => {
		const draft: Parameters<typeof draftToScript>[1] = {
			title: "Edited demo",
			mode: "walkthrough",
			rows: [
				{
					title: "Tour",
					selector: "",
					body: "Show it",
					timing: "",
					navigate: "",
					actKind: "",
					actText: "",
				},
			],
			setup: {
				rows: [
					{
						title: "Setup",
						selector: "#login",
						body: "Sign in",
						timing: "next",
						navigate: "",
						actKind: "fill",
						actText: "non-secret seed value",
					},
				],
				includeInTour: true,
			},
		};

		expect(draftToScript("https://app.example", draft)).toMatchObject({
			setup: {
				includeInTour: true,
				steps: [
					{
						title: "Setup",
						selector: "#login",
						body: "Sign in",
						advance: "next",
						action: { do: "fill", value: "non-secret seed value" },
					},
				],
			},
		});
	});

	it("omits setup when the editor has no setup rows", () => {
		const draft: Parameters<typeof draftToScript>[1] = {
			title: "Edited demo",
			mode: "walkthrough",
			rows: [
				{
					title: "Tour",
					selector: "",
					body: "Show it",
					timing: "",
					navigate: "",
					actKind: "",
					actText: "",
				},
			],
			setup: { rows: [], includeInTour: false },
		};

		expect(draftToScript("https://app.example", draft)).not.toHaveProperty(
			"setup",
		);
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

	it("returns from a navigated excluded setup to startUrl before video continuation", async () => {
		const navigatedSetupVideo: TourScript = {
			startUrl: "https://app.example/start",
			mode: "video",
			setup: {
				includeInTour: false,
				steps: [
					{
						body: "Prepare on another page",
						navigate: "https://app.example/setup",
					},
				],
			},
			steps: [{ body: "Begin the tutorial" }],
		};
		const events: string[] = [];
		const writeState = mock(
			async (_state: Parameters<typeof completeSetupPhase>[0]) => {
				events.push("state:tutorial");
			},
		);
		const navigate = mock((url: string) => {
			events.push(`navigate:${url}`);
		});
		const continuePlayback = mock(async () => {
			events.push("continue");
		});
		const abortPlayback = mock(async () => {
			events.push("abort");
		});

		const result = await handoffCompletedSetup(
			{
				script: navigatedSetupVideo,
				phase: "setup",
				index: 1,
			},
			"https://app.example/setup",
			{ writeState, navigate, continuePlayback, abortPlayback },
		);

		expect(result).toBe("navigate");
		expect(events).toEqual([
			"state:tutorial",
			"navigate:https://app.example/start",
		]);
		expect(writeState).toHaveBeenCalledWith(
			expect.objectContaining({ phase: "tutorial", index: 0 }),
		);
		expect(continuePlayback).not.toHaveBeenCalled();
		expect(abortPlayback).not.toHaveBeenCalled();
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

describe("setup action review and consent", () => {
	it("requires consent for click or fill setup actions only", () => {
		const base: TourScript = {
			startUrl: "https://app.example",
			steps: [{ body: "Tour", action: { do: "click" } }],
		};

		expect(setupActionConsentRequired(base)).toBe(false);
		expect(
			setupActionConsentRequired({
				...base,
				setup: {
					includeInTour: false,
					steps: [{ body: "Prepare", action: { do: "click" } }],
				},
			}),
		).toBe(true);
		expect(
			setupActionConsentRequired({
				...base,
				setup: {
					includeInTour: true,
					steps: [
						{
							body: "Seed",
							action: { do: "fill", value: "non-secret seed value" },
						},
					],
				},
			}),
		).toBe(true);
	});

	it("reviews setup rows and their actions before tutorial rows", () => {
		const draft: Parameters<typeof editorReviewRows>[0] = {
			title: "Review setup",
			mode: "video",
			setup: {
				includeInTour: false,
				rows: [
					{
						title: "Seed",
						selector: "#seed",
						body: "Seed data",
						timing: "next",
						navigate: "",
						actKind: "fill",
						actText: "non-secret seed value",
					},
				],
			},
			rows: [
				{
					title: "Tour",
					selector: "#dashboard",
					body: "Show dashboard",
					timing: "next",
					navigate: "",
					actKind: "",
					actText: "",
				},
			],
		};

		const rows = editorReviewRows(draft);
		expect(rows.map(({ kind }) => kind)).toEqual(["setup", "tutorial"]);
		expect(rows[0]).toMatchObject({
			status: "Setup · excluded preparation",
			row: {
				actKind: "fill",
				actText: "non-secret seed value",
			},
		});
	});
});

describe("playback lifecycle wiring", () => {
	const tutorialActionVideo: TourScript = {
		startUrl: "https://app.example/start",
		mode: "video",
		steps: [
			{
				body: "Open the dashboard",
				selector: "#dashboard",
				action: { do: "click" },
			},
		],
	};

	it("keeps tutorial actions unapproved when marker playback is initialized", async () => {
		const writeState = mock(
			async (_state: Awaited<ReturnType<typeof initializeMarkerPlayback>>) =>
				undefined,
		);

		expect(automaticActionConsentRequired(tutorialActionVideo)).toBe(true);
		const state = await initializeMarkerPlayback(
			tutorialActionVideo,
			writeState,
		);

		expect(automaticActionConsentGranted(state)).toBe(false);
		expect(
			automaticActionConsentGranted({
				...state,
				setupActionsApproved: true,
			}),
		).toBe(false);
		expect(writeState).toHaveBeenCalledWith(state);
	});

	it("persists all-action approval only after editor review", async () => {
		const writeState = mock(
			async (
				_state: Awaited<ReturnType<typeof initializeReviewedEditorPlayback>>,
			) => undefined,
		);

		const state = await initializeReviewedEditorPlayback(
			tutorialActionVideo,
			writeState,
		);

		expect(automaticActionConsentGranted(state)).toBe(true);
		expect(state).toMatchObject({
			phase: "tutorial",
			index: 0,
			automaticActionsApproved: true,
			fromEdit: true,
		});
		expect(writeState).toHaveBeenCalledWith(state);
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

// ── Defect 1: a missing action target must warn, not silently no-op ────────

describe("missingActionTargetWarning", () => {
	it("names the action kind and the selector that never resolved", () => {
		const message = missingActionTargetWarning({
			body: "Save",
			selector: "#save",
			action: { do: "click" },
		});

		expect(message).toContain("click");
		expect(message).toContain("#save");
	});
});

describe("performAction", () => {
	// performAction dispatches a real `input` event, which must come from the same
	// realm as the target element (happy-dom checks `instanceof Event` internally).
	function domInput(): HTMLElement {
		const win = new Window();
		Object.defineProperty(globalThis, "Event", {
			configurable: true,
			value: win.Event,
		});
		return win.document.createElement("input") as unknown as HTMLElement;
	}

	it("clicks the target and resolves once the click has fired", async () => {
		const target = new Window().document.createElement("button");
		let clicked = false;
		target.addEventListener("click", () => {
			clicked = true;
		});

		await performAction({ do: "click" }, target as unknown as HTMLElement);

		expect(clicked).toBe(true);
	});

	it("types the value into the target character by character, then resolves", async () => {
		const target = domInput();

		await performAction({ do: "fill", value: "hi" }, target);

		expect((target as unknown as HTMLInputElement).value).toBe("hi");
	});
});

describe("stepEffect", () => {
	it("returns an authored action as-is", () => {
		expect(
			stepEffect({ body: "x", action: { do: "fill", value: "hi" } }),
		).toEqual({
			do: "fill",
			value: "hi",
		});
	});

	// `advance: "click"` is a timing, not an action, so a tour built from timings alone
	// has no `action` anywhere — unattended playback must supply the click itself.
	it("synthesizes a click for a click-timed step with no authored action", () => {
		expect(stepEffect({ body: "x", advance: "click" })).toEqual({
			do: "click",
		});
	});

	it("prefers the authored action over the click timing", () => {
		expect(
			stepEffect({
				body: "x",
				advance: "click",
				action: { do: "fill", value: "q" },
			}),
		).toEqual({
			do: "fill",
			value: "q",
		});
	});

	it("returns nothing for a step that does not touch the page", () => {
		expect(stepEffect({ body: "x" })).toBeUndefined();
		expect(stepEffect({ body: "x", advance: "next" })).toBeUndefined();
		expect(stepEffect({ body: "x", advance: 2000 })).toBeUndefined();
		expect(stepEffect(undefined)).toBeUndefined();
	});
});

describe("maybePerformStepEffect", () => {
	const effectScript: TourScript = {
		startUrl: "https://app.example",
		steps: [],
	};

	beforeEach(() => {
		(browser.storage.local.set as ReturnType<typeof mock>).mockClear();
	});

	/**
	 * The bug this exists for: video playback called maybePerformAction, which bails on
	 * a step with no authored action. Every tour built from `click` timings therefore
	 * recorded without ever clicking anything, so the page never moved.
	 */
	it("clicks a click-timed step that has no authored action", async () => {
		const target = new Window().document.createElement("button");
		let clicks = 0;
		target.addEventListener("click", () => {
			clicks++;
		});

		await maybePerformStepEffect(
			{ script: effectScript, index: 0 },
			{ body: "Press it", advance: "click" },
			target as unknown as HTMLElement,
		);

		expect(clicks).toBe(1);
		expect(browser.storage.local.set).toHaveBeenCalledWith({
			"demo_tour:-1": expect.objectContaining({ acted: 0 }),
		});
	});

	it("still honours the acted guard, so a reload cannot re-click", async () => {
		const target = new Window().document.createElement("button");
		let clicks = 0;
		target.addEventListener("click", () => {
			clicks++;
		});

		await maybePerformStepEffect(
			{ script: effectScript, index: 1, acted: 1 },
			{ body: "Press it", advance: "click" },
			target as unknown as HTMLElement,
		);

		expect(clicks).toBe(0);
		expect(browser.storage.local.set).not.toHaveBeenCalled();
	});

	it("does nothing for a step that neither acts nor waits on a click", async () => {
		const target = new Window().document.createElement("button");
		let clicks = 0;
		target.addEventListener("click", () => {
			clicks++;
		});

		await maybePerformStepEffect(
			{ script: effectScript, index: 0 },
			{ body: "Just read this", advance: "next" },
			target as unknown as HTMLElement,
		);

		expect(clicks).toBe(0);
		expect(browser.storage.local.set).not.toHaveBeenCalled();
	});
});

describe("maybePerformAction", () => {
	const tourScript: TourScript = { startUrl: "https://app.example", steps: [] };

	beforeEach(() => {
		(browser.storage.local.set as ReturnType<typeof mock>).mockClear();
	});

	it("does nothing when the step has no action", async () => {
		const target = new Window().document.createElement("button");

		await maybePerformAction(
			{ script: tourScript, index: 0 },
			{ body: "No action" },
			target as unknown as HTMLElement,
		);

		expect(browser.storage.local.set).not.toHaveBeenCalled();
	});

	it("marks the step acted and performs the action exactly once", async () => {
		const target = new Window().document.createElement("button");
		let clicks = 0;
		target.addEventListener("click", () => {
			clicks++;
		});

		await maybePerformAction(
			{ script: tourScript, index: 2 },
			{ body: "Click it", action: { do: "click" } },
			target as unknown as HTMLElement,
		);

		expect(clicks).toBe(1);
		expect(browser.storage.local.set).toHaveBeenCalledWith({
			"demo_tour:-1": expect.objectContaining({ acted: 2 }),
		});
	});

	it("does not repeat an action already marked acted for this index", async () => {
		const target = new Window().document.createElement("button");
		let clicks = 0;
		target.addEventListener("click", () => {
			clicks++;
		});

		await maybePerformAction(
			{ script: tourScript, index: 1, acted: 1 },
			{ body: "Click it", action: { do: "click" } },
			target as unknown as HTMLElement,
		);

		expect(clicks).toBe(0);
		expect(browser.storage.local.set).not.toHaveBeenCalled();
	});

	it("runs once per index while another state write races the action", async () => {
		const state: PlayState = {
			script: tourScript,
			index: 0,
			phase: "tutorial",
		};
		const store = new Map<string, PlayState>([["demo_tour:-1", state]]);
		(browser.storage.local.get as ReturnType<typeof mock>).mockImplementation(
			(key: string) =>
				Promise.resolve(store.has(key) ? { [key]: store.get(key) } : {}),
		);
		(browser.storage.local.set as ReturnType<typeof mock>).mockImplementation(
			(value: Record<string, PlayState>) => {
				for (const [key, next] of Object.entries(value)) store.set(key, next);
				return Promise.resolve();
			},
		);
		const target = new Window().document.createElement("button");
		let clicks = 0;
		target.addEventListener("click", () => {
			clicks++;
			store.set("demo_tour:-1", { ...state, index: 1 });
		});

		await Promise.all([
			maybePerformAction(
				state,
				{ body: "Click it", action: { do: "click" } },
				target as unknown as HTMLElement,
			),
			maybePerformAction(
				state,
				{ body: "Click it", action: { do: "click" } },
				target as unknown as HTMLElement,
			),
		]);
		await maybePerformAction(
			{ ...state, index: 1 },
			{ body: "Click it", action: { do: "click" } },
			target as unknown as HTMLElement,
		);

		expect(clicks).toBe(2);
		expect(store.get("demo_tour:-1")).toMatchObject({ index: 1, acted: 1 });
	});
});

// ── Defect 2: an authored action must respect walkthrough pacing ───────────

describe("automaticPlayback — mode gating", () => {
	it("is false in walkthrough mode even for an action-bearing tutorial step", () => {
		const walkthroughScript: TourScript = {
			startUrl: "https://app.example",
			mode: "walkthrough",
			steps: [{ body: "Click it", action: { do: "click" } }],
		};

		expect(
			automaticPlayback({
				script: walkthroughScript,
				phase: "tutorial",
				index: 0,
			}),
		).toBe(false);
	});
});

describe("buildOverlay — callout controls", () => {
	function domRoot(): HTMLElement {
		const win = new Window();
		Object.defineProperty(globalThis, "window", {
			configurable: true,
			value: win,
		});
		Object.defineProperty(globalThis, "document", {
			configurable: true,
			value: win.document,
		});
		return win.document.createElement("div") as unknown as HTMLElement;
	}

	const script: TourScript = {
		startUrl: "https://app.example/start",
		mode: "walkthrough",
		steps: [{ body: "Step one" }, { body: "Step two" }, { body: "Step three" }],
	};
	const fakeCtx = {} as Parameters<typeof buildOverlay>[1];

	const ariaLabels = (root: HTMLElement): string[] =>
		[...root.querySelectorAll("button[aria-label]")].map(
			(b) => b.getAttribute("aria-label") ?? "",
		);
	const buttonByLabel = (root: HTMLElement, label: string): HTMLButtonElement =>
		root.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;
	// layer = root's single fixed-inset child; its first child is the spotlight
	// (highlight or dim), its last is the callout card — true for every non-video call.
	const layerOf = (root: HTMLElement): HTMLElement =>
		root.firstElementChild as HTMLElement;

	it("shows enabled jump and single-step controls with real aria-labels mid-tour", () => {
		const root = domRoot();

		buildOverlay(
			root,
			fakeCtx,
			{ script, index: 1 },
			script.steps[1],
			null,
			[],
			false,
		);

		// Order is the rendered order: « ‹ › »
		expect(ariaLabels(root)).toEqual([
			"Restart at the first step",
			"Previous step",
			"Next step",
			"Run to the last step",
		]);
		for (const label of [
			"Restart at the first step",
			"Previous step",
			"Next step",
			"Run to the last step",
		]) {
			expect(buttonByLabel(root, label).disabled).toBe(false);
		}
	});

	it("disables both backward controls on the first step and both forward on the last", () => {
		const first = domRoot();
		buildOverlay(
			first,
			fakeCtx,
			{ script, index: 0 },
			script.steps[0],
			null,
			[],
			false,
		);
		expect(buttonByLabel(first, "Restart at the first step").disabled).toBe(
			true,
		);
		expect(buttonByLabel(first, "Previous step").disabled).toBe(true);
		expect(buttonByLabel(first, "Next step").disabled).toBe(false);

		const lastIndex = script.steps.length - 1;
		const atEnd = domRoot();
		buildOverlay(
			atEnd,
			fakeCtx,
			{ script, index: lastIndex },
			script.steps[lastIndex],
			null,
			[],
			false,
		);
		expect(buttonByLabel(atEnd, "Previous step").disabled).toBe(false);
		expect(buttonByLabel(atEnd, "Next step").disabled).toBe(true);
		expect(buttonByLabel(atEnd, "Run to the last step").disabled).toBe(true);
	});

	it("tints only the single-step pair — ‹ --accent2, › --accent", () => {
		const root = domRoot();
		buildOverlay(
			root,
			fakeCtx,
			{ script, index: 1 },
			script.steps[1],
			null,
			[],
			false,
		);

		expect(
			buttonByLabel(root, "Previous step").getAttribute("style"),
		).toContain("var(--accent2)");

		const fwd = buttonByLabel(root, "Next step").getAttribute("style") ?? "";
		expect(fwd).toContain("var(--accent)");
		expect(fwd).not.toContain("var(--accent2)");

		// Jump controls stay untinted, so color marks stepping rather than direction.
		for (const label of ["Restart at the first step", "Run to the last step"]) {
			const style = buttonByLabel(root, label).getAttribute("style") ?? "";
			expect(style).not.toContain("var(--accent)");
			expect(style).not.toContain("var(--accent2)");
		}
	});

	it("carries navigation on the arrows alone — no Next button", () => {
		const root = domRoot();
		buildOverlay(
			root,
			fakeCtx,
			{ script, index: 1 },
			script.steps[1],
			null,
			[],
			false,
		);
		expect(root.textContent).not.toContain("Next");
		expect(root.textContent).not.toContain("Back");
	});

	it("keeps Done on the last step as the only way to finish", () => {
		const lastIndex = script.steps.length - 1;
		const atEnd = domRoot();
		buildOverlay(
			atEnd,
			fakeCtx,
			{ script, index: lastIndex },
			script.steps[lastIndex],
			null,
			[],
			false,
		);
		expect(atEnd.textContent).toContain("Done");

		const mid = domRoot();
		buildOverlay(
			mid,
			fakeCtx,
			{ script, index: 1 },
			script.steps[1],
			null,
			[],
			false,
		);
		expect(mid.textContent).not.toContain("Done");
	});

	it("hides every manual control, including the jump buttons, in video mode", () => {
		const root = domRoot();

		buildOverlay(
			root,
			fakeCtx,
			{ script, index: 1 },
			script.steps[1],
			null,
			[],
			true,
		);

		expect(root.querySelectorAll("button[aria-label]")).toHaveLength(0);
	});

	it("shows a visible warning when a step's action target was not found", () => {
		const root = domRoot();
		const actionStep: TourStep = { body: "Click it", action: { do: "click" } };

		buildOverlay(
			root,
			fakeCtx,
			{ script, index: 0 },
			actionStep,
			null,
			[],
			false,
		);

		expect(root.textContent).toContain("Target not found");
	});

	it("omits the warning for a step with no action, even without a target", () => {
		const root = domRoot();

		buildOverlay(
			root,
			fakeCtx,
			{ script, index: 0 },
			script.steps[0],
			null,
			[],
			false,
		);

		expect(root.textContent).not.toContain("Target not found");
	});

	// ── slice 3: no viewport dim on the targeted spotlight ──────────────────
	it("renders a bordered highlight with no viewport-dim shadow when a target is present", () => {
		const root = domRoot();
		const target = root.ownerDocument?.createElement("button") as HTMLElement;

		buildOverlay(
			root,
			fakeCtx,
			{ script, index: 0 },
			script.steps[0],
			target,
			[],
			false,
		);

		const highlight = layerOf(root).firstElementChild as HTMLElement;
		expect(highlight.getAttribute("style") ?? "").not.toContain("624.9375rem");
		expect(highlight.getAttribute("style") ?? "").toContain("var(--accent)");
	});

	it("still dims the whole viewport when there is no target (unchanged, deliberately kept)", () => {
		const root = domRoot();

		buildOverlay(
			root,
			fakeCtx,
			{ script, index: 0 },
			script.steps[0],
			null,
			[],
			false,
		);

		const highlight = layerOf(root).firstElementChild as HTMLElement;
		// happy-dom reformats rgba() spacing when parsed through the `background`
		// shorthand (unlike the opaque box-shadow string in the targeted branch).
		expect(highlight.getAttribute("style") ?? "").toContain(
			"rgba(0, 0, 0, 0.55)",
		);
	});

	// ── slice 3: phase-coloured spotlight border + card accent ──────────────
	it("renders the setup-phase spotlight border and card accent in orange, not blue", () => {
		const root = domRoot();
		const target = root.ownerDocument?.createElement("button") as HTMLElement;

		buildOverlay(
			root,
			fakeCtx,
			{ script, index: 0, phase: "setup" },
			script.steps[0],
			target,
			[],
			false,
		);

		const highlight = layerOf(root).firstElementChild as HTMLElement;
		const card = layerOf(root).lastElementChild as HTMLElement;
		expect(highlight.getAttribute("style") ?? "").toContain(
			"var(--accent-setup)",
		);
		expect(card.getAttribute("style") ?? "").toContain("var(--accent-setup)");
	});

	it("renders the tutorial-phase spotlight border and card accent in blue", () => {
		const root = domRoot();
		const target = root.ownerDocument?.createElement("button") as HTMLElement;

		buildOverlay(
			root,
			fakeCtx,
			{ script, index: 0, phase: "tutorial" },
			script.steps[0],
			target,
			[],
			false,
		);

		const highlight = layerOf(root).firstElementChild as HTMLElement;
		expect(highlight.getAttribute("style") ?? "").toContain("var(--accent)");
		expect(highlight.getAttribute("style") ?? "").not.toContain(
			"var(--accent-setup)",
		);
	});

	it("follows the phase across the setup→tutorial handoff, not the step index", () => {
		const lateSetup = domRoot();
		const lateTarget = lateSetup.ownerDocument?.createElement(
			"button",
		) as HTMLElement;
		buildOverlay(
			lateSetup,
			fakeCtx,
			{ script, index: script.steps.length - 1, phase: "setup" },
			script.steps[script.steps.length - 1],
			lateTarget,
			[],
			false,
		);
		expect(
			(layerOf(lateSetup).firstElementChild as HTMLElement).getAttribute(
				"style",
			) ?? "",
		).toContain("var(--accent-setup)");

		const earlyTutorial = domRoot();
		const earlyTarget = earlyTutorial.ownerDocument?.createElement(
			"button",
		) as HTMLElement;
		buildOverlay(
			earlyTutorial,
			fakeCtx,
			{ script, index: 0, phase: "tutorial" },
			script.steps[0],
			earlyTarget,
			[],
			false,
		);
		const earlyStyle =
			(layerOf(earlyTutorial).firstElementChild as HTMLElement).getAttribute(
				"style",
			) ?? "";
		expect(earlyStyle).toContain("var(--accent)");
		expect(earlyStyle).not.toContain("var(--accent-setup)");
	});

	// The tutorial-phase test above only reads `highlight` — the card's own accent,
	// which shares the same `phaseAccent` variable, was never actually checked.
	it("renders the tutorial-phase card accent in blue too, not just the highlight", () => {
		const root = domRoot();
		const target = root.ownerDocument?.createElement("button") as HTMLElement;

		buildOverlay(
			root,
			fakeCtx,
			{ script, index: 0, phase: "tutorial" },
			script.steps[0],
			target,
			[],
			false,
		);

		const card = layerOf(root).lastElementChild as HTMLElement;
		expect(card.getAttribute("style") ?? "").toContain("var(--accent)");
		expect(card.getAttribute("style") ?? "").not.toContain(
			"var(--accent-setup)",
		);
	});
});

describe("restartState", () => {
	const withSetup: TourScript = {
		startUrl: "https://app.example/start",
		mode: "walkthrough",
		setup: { includeInTour: false, steps: [{ body: "Prepare" }] },
		steps: [{ body: "One" }, { body: "Two" }],
	};
	const noSetup: TourScript = {
		startUrl: "https://app.example/start",
		mode: "walkthrough",
		steps: [{ body: "One" }, { body: "Two" }],
	};

	it("returns to the first step of the tour's opening phase", () => {
		expect(
			restartState({ script: withSetup, index: 1, phase: "tutorial" }),
		).toMatchObject({
			index: 0,
			phase: "setup",
		});
		expect(
			restartState({ script: noSetup, index: 1, phase: "tutorial" }),
		).toMatchObject({
			index: 0,
			phase: "tutorial",
		});
	});

	it("clears acted so every action runs again on the second pass", () => {
		expect(
			restartState({ script: noSetup, index: 1, acted: 1 }).acted,
		).toBeUndefined();
	});

	// Re-asking for consent the user already gave would make restarting worse than
	// just re-running the whole command.
	it("keeps the approvals and the editor origin", () => {
		expect(
			restartState({
				script: withSetup,
				index: 2,
				phase: "tutorial",
				automaticActionsApproved: true,
				setupActionsApproved: true,
				fromEdit: true,
			}),
		).toMatchObject({
			automaticActionsApproved: true,
			setupActionsApproved: true,
			fromEdit: true,
		});
	});
});

describe("recordingStartState", () => {
	const script: TourScript = {
		startUrl: "https://app.example/start",
		mode: "video",
		steps: [{ body: "One" }, { body: "Two" }, { body: "Three" }],
	};

	it("rewinds a mid-tour cursor to the first step", () => {
		expect(recordingStartState({ script, index: 2 }).index).toBe(0);
	});

	it("clears the acted high-water mark so replayed actions can run again", () => {
		expect(recordingStartState({ script, index: 2, acted: 2 }).acted).toBe(-1);
	});

	it("is a no-op on a cursor already at the first step", () => {
		expect(recordingStartState({ script, index: 0 })).toMatchObject({
			index: 0,
			acted: -1,
		});
	});

	it("preserves everything else about the state", () => {
		const state: PlayState = {
			script,
			index: 2,
			phase: "tutorial",
			setupActionsApproved: true,
			automaticActionsApproved: true,
			fromEdit: true,
		};
		expect(recordingStartState(state)).toMatchObject({
			script,
			phase: "tutorial",
			setupActionsApproved: true,
			automaticActionsApproved: true,
			fromEdit: true,
		});
	});
});

describe("advanceClickNeeded", () => {
	const clickStep: TourStep = { body: "Press it", advance: "click" };

	it("synthesizes the click when a control advances a click-timed step", () => {
		expect(advanceClickNeeded(clickStep, true, true)).toBe(true);
	});

	it("does not synthesize when the user clicked the target themselves", () => {
		expect(advanceClickNeeded(clickStep, true, false)).toBe(false);
	});

	it("does not synthesize without a resolved target", () => {
		expect(advanceClickNeeded(clickStep, false, true)).toBe(false);
	});

	it("leaves an authored action to maybePerformAction instead", () => {
		const authored: TourStep = { ...clickStep, action: { do: "click" } };
		expect(advanceClickNeeded(authored, true, true)).toBe(false);
	});

	it("ignores steps that are not waiting on a click", () => {
		expect(advanceClickNeeded({ body: "x", advance: "next" }, true, true)).toBe(
			false,
		);
		expect(advanceClickNeeded({ body: "x", advance: 3000 }, true, true)).toBe(
			false,
		);
		expect(advanceClickNeeded({ body: "x" }, true, true)).toBe(false);
	});
});

describe("runVideoStepSequence", () => {
	it("waits for narration, then the effect, then the authored tail before advancing", async () => {
		let finishNarration: ((outcome: "ended") => void) | undefined;
		const narration = new Promise<"ended">((resolve) => {
			finishNarration = resolve;
		});
		const order: string[] = [];
		const step: TourStep = { body: "Save", advance: 1200 };
		const sequence = runVideoStepSequence(step, {
			waitForNarration: () => narration,
			performEffect: async () => {
				order.push("effect");
			},
			pause: async (ms) => {
				order.push(`pause:${ms}`);
			},
			advance: async () => {
				order.push("advance");
			},
			cancelled: () => false,
		});

		expect(order).toEqual([]);
		finishNarration?.("ended");
		await sequence;

		expect(order).toEqual(["effect", `pause:${holdFor(step, 0)}`, "advance"]);
	});

	it("uses the bounded silent fallback without adding a narrated tail", async () => {
		const order: string[] = [];

		await runVideoStepSequence(
			{ body: "Silent" },
			{
				waitForNarration: async () => "timeout",
				performEffect: async () => {
					order.push("effect");
				},
				pause: async () => {
					order.push("pause");
				},
				advance: async () => {
					order.push("advance");
				},
				cancelled: () => false,
			},
		);

		expect(order).toEqual(["effect", "advance"]);
	});

	it("continues when synthesis fails after an earlier narrated step", async () => {
		const order: string[] = [];
		for (const [index, outcome] of ["ended", "timeout"].entries()) {
			await runVideoStepSequence(
				{ body: `Step ${index}` },
				{
					waitForNarration: async () => outcome as "ended" | "timeout",
					performEffect: async () => {
						order.push(`effect:${index}`);
					},
					pause: async () => {},
					advance: async () => {
						order.push(`advance:${index}`);
					},
					cancelled: () => false,
				},
			);
		}

		expect(order).toEqual(["effect:0", "advance:0", "effect:1", "advance:1"]);
	});
});

// ── Defect 3: a tour behind a client-side auth redirect keeps its marker ───

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
		let listener:
			| ((msg: {
					type?: string;
					index?: number;
					durations?: number[];
					hideBody?: boolean;
			  }) => void)
			| undefined;
		(
			browser.runtime.onMessage.addListener as ReturnType<typeof mock>
		).mockImplementation((next: typeof listener) => {
			listener = next;
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
			listener: (msg) => listener?.(msg),
		};
	}

	it("ignores a stale index and runs the effect only after the current narration ends", async () => {
		const script: TourScript = {
			startUrl: "https://app.example/start",
			mode: "video",
			steps: [{ selector: "#target", body: "Open it", advance: "click" }],
		};
		const { listener } = videoHarness(70, script, true, [100]);
		document.body.innerHTML = '<button id="target"></button>';
		let clicks = 0;
		document
			.getElementById("target")
			?.addEventListener("click", () => clicks++);

		await runDemoTour({} as Parameters<typeof runDemoTour>[0]);
		listener({ type: MSG.narrationComplete, index: 69 });
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(clicks).toBe(0);

		listener({ type: MSG.narrationComplete, index: 0 });
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(clicks).toBe(1);
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
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(clicks).toBe(2);
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
		await new Promise((resolve) => setTimeout(resolve, 5));

		expect(store.get("demo_tour:72")).toMatchObject({
			index: 0,
			videoDurations: [1200, 2400],
			videoHideBody: true,
		});
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

	// Flushes past createShadowRootUi's own await plus any dispatch()-triggered
	// re-render — a macrotask boundary clears every pending microtask ahead of it.
	const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

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
		await flush();

		expect(clicks).toEqual({ s0: 1, s1: 1, s2: 1 });
		const last = containers[containers.length - 1];
		expect(last.textContent).toContain("3 / 3");
	});

	it("« returns to the first step and re-enters the editor, not the tour", async () => {
		const store = statefulLocalStorage();
		const containers = await openEditorAtStep(41, 2, store);
		const root = containers[containers.length - 1];

		const jumpBack = buttonByLabel(root, "Restart at the first step");
		expect(jumpBack).not.toBeNull();
		jumpBack.click();
		await flush();

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
		await flush();

		// draftToScript is the single serialization path (persist() mirrors it into
		// the URL on every edit) — the added row must show up there.
		expect(readDemoScript(location.href)?.steps.length).toBe(
			script.steps.length + 1,
		);
	});

	it("removing the row the cursor is on leaves a valid cursor and omits it from the draft", async () => {
		const store = statefulLocalStorage();
		const containers = await openEditorAtStep(43, 2, store);
		const root = containers[containers.length - 1];

		const removeStep = buttonByLabel(root, "Remove step");
		expect(removeStep).not.toBeNull();
		removeStep.click();
		await flush();

		expect(readDemoScript(location.href)?.steps.length).toBe(
			script.steps.length - 1,
		);
		const last = containers[containers.length - 1];
		expect(last.textContent).toContain("2 / 2");
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
		await flush();

		const last = containers[containers.length - 1];
		expect(last.textContent).not.toContain("NaN");
		expect(last.textContent ?? "").toMatch(/\d+ \/ \d+/);
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
		await flush();

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
		await flush();

		expect(readDemoScript(location.href)?.steps.length).toBe(
			script.steps.length - 1,
		);
		const last = containers[containers.length - 1];
		expect(last.textContent).not.toContain("NaN");
		expect(last.textContent ?? "").toMatch(/\d+ \/ 2/);
	});

	it("removing a step, then clicking Approve, carries the reduced count onto the done screen", async () => {
		const store = statefulLocalStorage();
		const containers = await openEditorAtStep(46, 2, store);
		const root = containers[containers.length - 1];

		const removeStep = buttonByLabel(root, "Remove step");
		expect(removeStep).not.toBeNull();
		removeStep.click();
		await flush();

		const approve = buttonByText(
			containers[containers.length - 1],
			"✓ Approve",
		);
		expect(approve).toBeTruthy();
		approve.click();
		await flush();

		const done = containers[containers.length - 1];
		expect(done.textContent).toContain(`${script.steps.length - 1} step(s)`);
	});

	it("adding a step, then clicking Approve, carries the increased count onto the done screen", async () => {
		const store = statefulLocalStorage();
		const containers = await openEditorAtStep(47, 0, store);
		const root = containers[containers.length - 1];

		const addStep = buttonByLabel(root, "Add step");
		expect(addStep).not.toBeNull();
		addStep.click();
		await flush();

		const approve = buttonByText(
			containers[containers.length - 1],
			"✓ Approve",
		);
		expect(approve).toBeTruthy();
		approve.click();
		await flush();

		const done = containers[containers.length - 1];
		expect(done.textContent).toContain(`${script.steps.length + 1} step(s)`);
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
		await flush();

		expect(clicks).toEqual({ s0: 0, s1: 1, s2: 1 });
		const last = containers[containers.length - 1];
		expect(last.textContent).toContain("3 / 3");
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
		await flush();

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
		await flush();

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

	it("leaves navigate empty when the planning click stays on the same page", async () => {
		const store = statefulLocalStorage();
		const containers = await openEditorAtStep(59, 0, store);

		buttonByLabel(containers[containers.length - 1], "Next step").click();
		await flush();

		expect(readDemoScript(location.href)?.steps[0]?.navigate).toBeUndefined();
	});

	it("adding a step inserts it immediately after the cursor's row, not at the end", async () => {
		const store = statefulLocalStorage();
		const containers = await openEditorAtStep(52, 1, store);
		const root = containers[containers.length - 1];

		buttonByLabel(root, "Add step").click();
		await flush();

		const steps = readDemoScript(location.href)?.steps ?? [];
		expect(steps.map((s) => s.body)).toEqual(["One", "Two", "", "Three"]);
	});

	it("removing the cursor's row removes exactly that row, not the first or last by default", async () => {
		const store = statefulLocalStorage();
		const containers = await openEditorAtStep(53, 1, store);
		const root = containers[containers.length - 1];

		buttonByLabel(root, "Remove step").click();
		await flush();

		const steps = readDemoScript(location.href)?.steps ?? [];
		expect(steps.map((s) => s.body)).toEqual(["One", "Three"]);
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
			await flush();

			const out = readDemoScript(location.href);
			expect(out?.setup?.steps.length).toBe(2);
			expect(out?.steps.length).toBe(2);
		});

		it("adding a step while the cursor is on a tutorial row lands in the tutorial section, even with setup present", async () => {
			const containers = await openWithSetupAtStep(55, 1);
			const root = containers[containers.length - 1];

			buttonByLabel(root, "Add step").click();
			await flush();

			const out = readDemoScript(location.href);
			expect(out?.setup?.steps.length).toBe(1);
			expect(out?.steps.length).toBe(3);
		});

		it("removing the only setup row omits setup from the serialized script and leaves tutorial rows untouched", async () => {
			const containers = await openWithSetupAtStep(56, 0);
			const root = containers[containers.length - 1];

			buttonByLabel(root, "Remove step").click();
			await flush();

			const out = readDemoScript(location.href);
			expect(out?.setup).toBeUndefined();
			expect(out?.steps.map((s) => s.body)).toEqual(["Tut one", "Tut two"]);
		});
	});
});

// ── Defect 4: setup rows must be fully editable, same as tutorial rows ─────

describe("scriptToDraft", () => {
	it("surfaces every field for a setup row exactly like a tutorial row", () => {
		const script: TourScript = {
			title: "Full tour",
			startUrl: "https://app.example",
			mode: "video",
			setup: {
				includeInTour: false,
				steps: [
					{
						title: "Sign in",
						selector: "#login",
						body: "Sign in first",
						navigate: "https://app.example/login",
						advance: 2000,
						action: { do: "fill", value: "non-secret seed value" },
					},
				],
			},
			steps: [
				{ title: "Dashboard", body: "See the dashboard", selector: "#dash" },
			],
		};

		const draft = scriptToDraft(script);

		expect(draft.setup).toMatchObject({
			includeInTour: false,
			rows: [
				{
					title: "Sign in",
					selector: "#login",
					body: "Sign in first",
					navigate: "https://app.example/login",
					timing: "2s",
					actKind: "fill",
					actText: "non-secret seed value",
				},
			],
		});
		// Round-trips back to an equivalent script — every setup field survives edit + save.
		expect(draftToScript(script.startUrl, draft)).toEqual(script);
	});

	it("omits setup entirely when the script has none", () => {
		const script: TourScript = {
			startUrl: "https://app.example",
			steps: [{ body: "Tour" }],
		};

		expect(scriptToDraft(script).setup).toBeUndefined();
	});
});
