import { afterEach, describe, expect, it } from "bun:test";
import type { TourScript, TourStep } from "@dg/common";
import { Window } from "happy-dom";
import {
	advanceClickNeeded,
	automaticPlayback,
	draftToScript,
	type EditEvent,
	type EditPhase,
	editMachine,
	editorReviewRows,
	type PlayState,
	performAction,
	recordingStartState,
	restartState,
	runVideoStepSequence,
	scriptToDraft,
	stepEffect,
} from "../src/engine";
import { holdFor } from "../src/video-timing";

const originalEvent = Object.getOwnPropertyDescriptor(globalThis, "Event");
afterEach(() => {
	if (originalEvent) Object.defineProperty(globalThis, "Event", originalEvent);
	else Reflect.deleteProperty(globalThis, "Event");
});

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

describe("editorReviewRows", () => {
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
