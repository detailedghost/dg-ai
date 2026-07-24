/**
 * Pure-function tests for review modal helpers extracted from demo-tour.ts.
 * No DOM or WebExtension APIs needed — pure logic only.
 */
import { describe, expect, it, mock } from "bun:test";
import { Window } from "happy-dom";
import { MSG } from "@/lib/demo-messages";
import type { TourScript } from "@/lib/demo-types";
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

import {
	automaticActionConsentGranted,
	automaticActionConsentRequired,
	automaticPlayback,
	buildVideoReviewHtml,
	completeSetupPhase,
	draftToScript,
	type EditEvent,
	type EditPhase,
	editMachine,
	editorInheritedPageUrl,
	editorPageUrl,
	editorReviewRows,
	editorSpotlightTarget,
	getNarrationMode,
	handleTourMessage,
	initializeMarkerPlayback,
	initializeReviewedEditorPlayback,
	initialPlayPhase,
	reviewAction,
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
