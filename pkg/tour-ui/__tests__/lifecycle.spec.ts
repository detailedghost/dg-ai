import { describe, expect, it, mock } from "bun:test";
import type { TourScript, TourStep } from "@dg/common";
import { Window } from "happy-dom";
import {
	type completeSetupPhase,
	editorReviewRows,
	initialPlayState,
	missingActionTargetWarning,
	type PlayState,
} from "../src/engine";
import {
	automaticActionConsentGranted,
	automaticActionConsentRequired,
	handoffCompletedSetup,
	initializeMarkerPlayback,
	initializeReviewedEditorPlayback,
	maybePerformAction,
	maybePerformStepEffect,
	primeClickNavigation,
	setupActionConsentRequired,
} from "../src/lifecycle";
import { fakeHost } from "./fake-host";

const button = (): HTMLElement =>
	new Window().document.createElement("button") as unknown as HTMLElement;

function counted(target: HTMLElement): () => number {
	let clicks = 0;
	target.addEventListener("click", () => {
		clicks++;
	});
	return () => clicks;
}

describe("handoffCompletedSetup", () => {
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
			{ script: navigatedSetupVideo, phase: "setup", index: 1 },
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
			row: { actKind: "fill", actText: "non-secret seed value" },
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
		const writeState = mock(async (_state: PlayState) => undefined);

		expect(automaticActionConsentRequired(tutorialActionVideo)).toBe(true);
		const state = await initializeMarkerPlayback(
			tutorialActionVideo,
			writeState,
		);

		expect(automaticActionConsentGranted(state)).toBe(false);
		expect(
			automaticActionConsentGranted({ ...state, setupActionsApproved: true }),
		).toBe(false);
		expect(writeState).toHaveBeenCalledWith(state);
	});

	it("persists all-action approval only after editor review", async () => {
		const writeState = mock(async (_state: PlayState) => undefined);

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

describe("maybePerformStepEffect", () => {
	const script: TourScript = { startUrl: "https://app.example", steps: [] };

	it("clicks a click-timed step that has no authored action", async () => {
		const host = fakeHost();
		const target = button();
		const clicks = counted(target);

		await maybePerformStepEffect(
			host,
			{ script, index: 0 },
			{ body: "Press it", advance: "click" },
			target,
		);

		expect(clicks()).toBe(1);
		expect(host.store.get("demo_tour:7")).toMatchObject({ acted: 0 });
	});

	it("still honors the acted guard, so a reload cannot re-click", async () => {
		const host = fakeHost();
		const target = button();
		const clicks = counted(target);

		await maybePerformStepEffect(
			host,
			{ script, index: 1, acted: 1 },
			{ body: "Press it", advance: "click" },
			target,
		);

		expect(clicks()).toBe(0);
		expect(host.store.size).toBe(0);
	});

	it("does nothing for a step that neither acts nor waits on a click", async () => {
		const host = fakeHost();
		const target = button();
		const clicks = counted(target);

		await maybePerformStepEffect(
			host,
			{ script, index: 0 },
			{ body: "Just read this", advance: "next" },
			target,
		);

		expect(clicks()).toBe(0);
		expect(host.store.size).toBe(0);
	});
});

describe("maybePerformAction", () => {
	const script: TourScript = { startUrl: "https://app.example", steps: [] };

	it("does nothing when the step has no action", async () => {
		const host = fakeHost();

		await maybePerformAction(
			host,
			{ script, index: 0 },
			{ body: "No action" },
			button(),
		);

		expect(host.store.size).toBe(0);
	});

	it("marks the step acted and performs the action exactly once", async () => {
		const host = fakeHost();
		const target = button();
		const clicks = counted(target);

		await maybePerformAction(
			host,
			{ script, index: 2 },
			{ body: "Click it", action: { do: "click" } },
			target,
		);

		expect(clicks()).toBe(1);
		expect(host.store.get("demo_tour:7")).toMatchObject({ acted: 2 });
	});

	it("does not repeat an action already marked acted for this index", async () => {
		const host = fakeHost();
		const target = button();
		const clicks = counted(target);

		await maybePerformAction(
			host,
			{ script, index: 1, acted: 1 },
			{ body: "Click it", action: { do: "click" } },
			target,
		);

		expect(clicks()).toBe(0);
		expect(host.store.size).toBe(0);
	});

	it("runs once per index while another state write races the action", async () => {
		const host = fakeHost();
		const state: PlayState = { script, index: 0, phase: "tutorial" };
		host.store.set("demo_tour:7", state);
		const target = button();
		let clicks = 0;
		target.addEventListener("click", () => {
			clicks++;
			host.store.set("demo_tour:7", { ...state, index: 1 });
		});
		const step: TourStep = { body: "Click it", action: { do: "click" } };

		await Promise.all([
			maybePerformAction(host, state, step, target),
			maybePerformAction(host, state, step, target),
		]);
		await maybePerformAction(host, { ...state, index: 1 }, step, target);

		expect(clicks).toBe(2);
		expect(host.store.get("demo_tour:7")).toMatchObject({
			index: 1,
			acted: 1,
		});
	});
});

describe("primeClickNavigation", () => {
	it("persists the destination before either kind of click effect can navigate", async () => {
		const state = initialPlayState(
			{
				startUrl: "https://app.example/start",
				steps: [{ body: "Open" }, { body: "Landed" }],
			},
			"marker",
		);
		for (const step of [
			{ body: "Timed", advance: "click" },
			{ body: "Action", action: { do: "click" } },
		] satisfies TourStep[]) {
			const writeState = mock(() => Promise.resolve());

			await primeClickNavigation(state, step, writeState);

			expect(writeState).toHaveBeenCalledWith({ ...state, index: 1 });
		}
	});

	it("does not move the cursor early for a non-navigation effect", async () => {
		const state = initialPlayState(
			{ startUrl: "https://app.example/start", steps: [{ body: "Type" }] },
			"marker",
		);
		const writeState = mock(() => Promise.resolve());

		await primeClickNavigation(
			state,
			{ body: "Type", action: { do: "fill", value: "hello" } },
			writeState,
		);

		expect(writeState).not.toHaveBeenCalled();
	});
});
