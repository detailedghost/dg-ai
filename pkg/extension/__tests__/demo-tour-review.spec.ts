/**
 * Pure-function tests for review modal helpers extracted from demo-tour.ts.
 * No DOM or WebExtension APIs needed — pure logic only.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { Window } from "happy-dom";
import { MSG } from "@/lib/demo-messages";
import type { TourScript, TourStep } from "@/lib/demo-types";
import { demoMarkerFragment, readDemoScript } from "@/utils/demo-marker";

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
	maybePerformAction,
	missingActionTargetWarning,
	performAction,
	resolvePendingMarker,
	reviewAction,
	scriptToDraft,
	setupActionConsentRequired,
	type TourState,
} from "@/lib/features/demo-tour";

const baseState: TourState = {};

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

	it("primes at step 0", () => {
		expect(editMachine(3).next().value).toEqual({ kind: "step", cursor: 0 });
	});

	it("advances and clamps at the last step", () => {
		expect(run(3, ["next", "next"])).toEqual({ kind: "step", cursor: 2 });
		expect(run(3, ["next", "next", "next"])).toEqual({
			kind: "step",
			cursor: 2,
		});
	});

	it("goes back and clamps at 0", () => {
		expect(run(3, ["next", "back", "back"])).toEqual({
			kind: "step",
			cursor: 0,
		});
	});

	it("approve → done; editAgain returns to the last step", () => {
		expect(run(3, ["approve"])).toEqual({ kind: "done" });
		expect(run(3, ["approve", "editAgain"])).toEqual({
			kind: "step",
			cursor: 2,
		});
	});

	it("ignores next/back while done", () => {
		expect(run(3, ["approve", "next", "back"])).toEqual({ kind: "done" });
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

	it("shows enabled first/last jump controls with real aria-labels mid-tour", () => {
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

		expect(ariaLabels(root)).toEqual(["Go to first step", "Go to last step"]);
		expect(buttonByLabel(root, "Go to first step").disabled).toBe(false);
		expect(buttonByLabel(root, "Go to last step").disabled).toBe(false);
	});

	it("disables « on the first step and » on the last step", () => {
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
		expect(buttonByLabel(first, "Go to first step").disabled).toBe(true);
		expect(buttonByLabel(first, "Go to last step").disabled).toBe(false);

		const lastIndex = script.steps.length - 1;
		const last = domRoot();
		buildOverlay(
			last,
			fakeCtx,
			{ script, index: lastIndex },
			script.steps[lastIndex],
			null,
			[],
			false,
		);
		expect(buttonByLabel(last, "Go to first step").disabled).toBe(false);
		expect(buttonByLabel(last, "Go to last step").disabled).toBe(true);
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

describe("captureMarkerEarly", () => {
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
	}

	beforeEach(() => {
		(browser.storage.local.set as ReturnType<typeof mock>).mockClear();
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
			"demo_pending:-1": expect.objectContaining({ script, edit: false }),
		});
		expect(location.href).toBe(script.startUrl);
	});

	it("captures the edit flag alongside the script", async () => {
		const script: TourScript = {
			startUrl: "https://app.example/start",
			steps: [{ body: "Tour" }],
		};
		withLocation(`${script.startUrl}#${demoMarkerFragment(script, true)}`);

		await captureMarkerEarly();

		expect(browser.storage.local.set).toHaveBeenCalledWith({
			"demo_pending:-1": expect.objectContaining({ edit: true }),
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
