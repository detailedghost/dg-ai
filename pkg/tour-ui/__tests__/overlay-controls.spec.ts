import { afterEach, describe, expect, it } from "bun:test";
import type { TourScript, TourStep } from "@dg/common";
import { Window } from "happy-dom";
import {
	buildOverlay,
	INERT_CONTROLS,
	type StepControls,
} from "../src/overlay";

const GLOBAL_KEYS = ["window", "document"] as const;
const originalGlobals = new Map(
	GLOBAL_KEYS.map((key) => [
		key,
		Object.getOwnPropertyDescriptor(globalThis, key),
	]),
);

afterEach(() => {
	for (const key of GLOBAL_KEYS) {
		const descriptor = originalGlobals.get(key);
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
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
	const noControls = INERT_CONTROLS;

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
			noControls,
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
			noControls,
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
			noControls,
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
			noControls,
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
			noControls,
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
			noControls,
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
			noControls,
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
			noControls,
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
			noControls,
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
			noControls,
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
			noControls,
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
			noControls,
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
			noControls,
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
			noControls,
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
			noControls,
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
			noControls,
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
			noControls,
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

describe("buildOverlay — control wiring", () => {
	const script: TourScript = {
		startUrl: "https://app.example/start",
		mode: "walkthrough",
		steps: [{ body: "One" }, { body: "Two" }, { body: "Three" }],
	};

	function mount(index: number): {
		root: HTMLElement;
		calls: string[];
		target: HTMLElement;
	} {
		const win = new Window();
		Object.defineProperty(globalThis, "window", {
			configurable: true,
			value: win,
		});
		Object.defineProperty(globalThis, "document", {
			configurable: true,
			value: win.document,
		});
		const root = win.document.createElement("div") as unknown as HTMLElement;
		const target = win.document.createElement("a") as unknown as HTMLElement;
		const calls: string[] = [];
		const actions: StepControls = {
			end: () => calls.push("end"),
			restart: () => calls.push("restart"),
			back: () => calls.push("back"),
			next: (t) => calls.push(t === target ? "next:target" : "next"),
			last: () => calls.push("last"),
		};
		buildOverlay(
			root,
			actions,
			{ script, index },
			script.steps[index] as TourStep,
			target,
			[],
			false,
		);
		return { root, calls, target };
	}

	it("routes every callout button to its control", () => {
		const { root, calls } = mount(1);
		const press = (selector: string): void =>
			(root.querySelector(selector) as HTMLButtonElement).click();

		press('button[title="End tour"]');
		press('button[aria-label="Restart at the first step"]');
		press('button[aria-label="Previous step"]');
		press('button[aria-label="Next step"]');
		press('button[aria-label="Run to the last step"]');

		expect(calls).toEqual(["end", "restart", "back", "next:target", "last"]);
	});

	it("hands the highlighted target to Done on the last step", () => {
		const { root, calls } = mount(2);
		const done = [...root.querySelectorAll("button")].find(
			(b) => b.textContent === "Done",
		) as HTMLButtonElement;

		done.click();

		expect(calls).toEqual(["next:target"]);
	});
});
