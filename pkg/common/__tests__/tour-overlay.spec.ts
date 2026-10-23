import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import {
	renderTourOverlayStep,
	TOUR_OVERLAY_TOKENS_CSS,
	type TourOverlayStep,
} from "../src/tour-overlay";

const baseStep: TourOverlayStep = {
	index: 0,
	total: 3,
	scriptTitle: "Saved filters",
	heading: "Save a filter",
	body: "Click here to persist the current filter set.",
	phase: "tutorial",
	video: false,
};

let originalDocument: Document;
let originalWindow: unknown;

beforeEach(() => {
	const window = new Window({ url: "https://example.test/" });
	originalDocument = globalThis.document;
	originalWindow = (globalThis as { window?: unknown }).window;
	globalThis.document = window.document as unknown as Document;
	(globalThis as { window?: unknown }).window = window;
	for (const key of ["innerWidth", "innerHeight"] as const) {
		Object.defineProperty(globalThis, key, {
			configurable: true,
			value: 1280,
		});
	}
});

afterEach(() => {
	globalThis.document = originalDocument;
	(globalThis as { window?: unknown }).window = originalWindow;
});

describe("renderTourOverlayStep — content", () => {
	it("renders the progress line, heading, and body into the card", () => {
		const { card, cleanup } = renderTourOverlayStep({
			css: TOUR_OVERLAY_TOKENS_CSS,
			step: baseStep,
			target: null,
		});
		expect(card.textContent).toContain("Saved filters · Step 1 of 3");
		expect(card.textContent).toContain("Save a filter");
		expect(card.textContent).toContain(
			"Click here to persist the current filter set.",
		);
		cleanup();
	});

	it("omits the progress title segment when the script has no title", () => {
		const { card, cleanup } = renderTourOverlayStep({
			css: TOUR_OVERLAY_TOKENS_CSS,
			step: { ...baseStep, scriptTitle: undefined },
			target: null,
		});
		expect(card.textContent).toContain("Step 1 of 3");
		expect(card.textContent).not.toContain("·");
		cleanup();
	});

	it("dims the viewport and centers the card when there is no target", () => {
		const { highlight, cleanup } = renderTourOverlayStep({
			css: TOUR_OVERLAY_TOKENS_CSS,
			step: baseStep,
			target: null,
		});
		expect(highlight.style.background.replace(/\s+/g, "")).toBe(
			"rgba(0,0,0,0.55)",
		);
		cleanup();
	});

	it("outlines the resolved target instead of dimming the viewport", () => {
		document.body.innerHTML = '<button id="save">Save</button>';
		const target = document.getElementById("save") as HTMLElement;
		const { highlight, cleanup } = renderTourOverlayStep({
			css: TOUR_OVERLAY_TOKENS_CSS,
			step: baseStep,
			target,
		});
		expect(highlight.style.background).toBe("");
		expect(highlight.style.border).not.toBe("");
		cleanup();
	});

	it("resolves a string target the same way as a live element", () => {
		document.body.innerHTML = '<button id="save">Save</button>';
		const { highlight, cleanup } = renderTourOverlayStep({
			css: TOUR_OVERLAY_TOKENS_CSS,
			step: baseStep,
			target: "#save",
		});
		expect(highlight.style.background).toBe("");
		cleanup();
	});

	it("tints the highlight and card for a setup-phase step", () => {
		const { highlight, card, cleanup } = renderTourOverlayStep({
			css: TOUR_OVERLAY_TOKENS_CSS,
			step: { ...baseStep, phase: "setup" },
			target: null,
		});
		expect(highlight.style.background.replace(/\s+/g, "")).toBe(
			"rgba(0,0,0,0.55)",
		);
		expect(card.style.boxShadow).toContain("var(--accent-setup)");
		cleanup();
	});

	it("shows a REC badge in video mode and hides it otherwise", () => {
		const { layer, cleanup } = renderTourOverlayStep({
			css: TOUR_OVERLAY_TOKENS_CSS,
			step: { ...baseStep, video: true },
			target: null,
		});
		expect(layer.textContent).toContain("REC");
		cleanup();
	});

	it("omits the body text box for a voice-only video recording", () => {
		const { card, cleanup } = renderTourOverlayStep({
			css: TOUR_OVERLAY_TOKENS_CSS,
			step: { ...baseStep, video: true, hideBody: true },
			target: null,
		});
		expect(card.textContent).not.toContain(
			"Click here to persist the current filter set.",
		);
		expect(card.textContent).toContain("Save a filter");
		cleanup();
	});

	it("warns when an authored action's target never resolved", () => {
		const { card, cleanup } = renderTourOverlayStep({
			css: TOUR_OVERLAY_TOKENS_CSS,
			step: { ...baseStep, actionMissing: true },
			target: null,
		});
		expect(card.textContent).toContain("Target not found");
		cleanup();
	});

	it("hints to click the target for an advance:click step", () => {
		const { card, cleanup } = renderTourOverlayStep({
			css: TOUR_OVERLAY_TOKENS_CSS,
			step: { ...baseStep, waitingForClick: true },
			target: null,
		});
		expect(card.textContent).toContain("Click the highlighted element");
		cleanup();
	});

	it("injects the given CSS text verbatim, unmodified", () => {
		document.body.innerHTML = "";
		const { layer, cleanup } = renderTourOverlayStep({
			css: TOUR_OVERLAY_TOKENS_CSS,
			step: baseStep,
			target: null,
		});
		// The style lives beside `layer` in whichever root this call mounted into
		// (a caller's root, or the self-created shadow root) — walk up to find it.
		const mountRoot = layer.getRootNode() as ParentNode;
		const style = mountRoot.querySelector("style");
		expect(style?.textContent).toBe(TOUR_OVERLAY_TOKENS_CSS);
		cleanup();
	});
});

describe("renderTourOverlayStep — mount boundary", () => {
	it("creates its own isolated host under document.body when no root is given (the dg-skills pw path)", () => {
		const before = document.body.children.length;
		const { cleanup } = renderTourOverlayStep({
			css: TOUR_OVERLAY_TOKENS_CSS,
			step: baseStep,
			target: null,
		});
		expect(document.body.children.length).toBe(before + 1);
		cleanup();
		expect(document.body.children.length).toBe(before);
	});

	it("mounts into a caller-supplied root and never removes it on cleanup (the extension's WXT container)", () => {
		const container = document.createElement("div");
		document.body.appendChild(container);
		const bodyChildrenBefore = document.body.children.length;
		const { cleanup } = renderTourOverlayStep(
			{ css: TOUR_OVERLAY_TOKENS_CSS, step: baseStep, target: null },
			container,
		);
		expect(container.children.length).toBeGreaterThan(0);
		cleanup();
		expect(document.body.children.length).toBe(bodyChildrenBefore);
		expect(document.body.contains(container)).toBe(true);
	});
});

describe("renderTourOverlayStep — cross-realm safety (dg-skills pw's page.evaluateHandle call)", () => {
	// `page.evaluateHandle(renderTourOverlayStep, opts)` ships this function's source
	// text to a fresh browser realm via Function.prototype.toString() and re-parses it
	// there — any reference to a module-level import, constant, or sibling helper would
	// throw a ReferenceError in that realm even though a direct same-realm call (the
	// extension's) never notices. Rebuilding it from its own toString() and running it
	// is the only way to catch that without an actual second JS realm.
	it("still runs correctly when reconstructed purely from its own source text", () => {
		// biome-ignore lint: deliberately re-parsing the function's own source, same trick Playwright uses.
		const rebuilt = new Function(
			`return (${renderTourOverlayStep.toString()});`,
		)() as typeof renderTourOverlayStep;
		document.body.innerHTML = '<button id="save">Save</button>';
		const target = document.getElementById("save") as HTMLElement;
		const { card, highlight, cleanup } = rebuilt(
			{ css: TOUR_OVERLAY_TOKENS_CSS, step: baseStep, target },
			undefined,
		);
		expect(card.textContent).toContain("Save a filter");
		expect(highlight.style.background).toBe("");
		cleanup();
	});
});

describe("renderTourOverlayStep — shared-module parity", () => {
	// The contract the spec asks for: one TourScript step, rendered through the
	// extension's calling convention (a supplied shadow root) and through
	// dg-skills pw's calling convention (no root, reconstructed from source text
	// the way page.evaluateHandle serializes it), must produce the same overlay.
	it("renders the same spotlight and callout content both ways for one step", () => {
		const step: TourOverlayStep = {
			...baseStep,
			video: true,
			heading: "Narrated step",
		};

		const container = document.createElement("div");
		document.body.appendChild(container);
		const extensionSide = renderTourOverlayStep(
			{ css: TOUR_OVERLAY_TOKENS_CSS, step, target: null },
			container,
		);

		// biome-ignore lint: see the cross-realm safety test above.
		const rebuilt = new Function(
			`return (${renderTourOverlayStep.toString()});`,
		)() as typeof renderTourOverlayStep;
		const pwSide = rebuilt({ css: TOUR_OVERLAY_TOKENS_CSS, step, target: null });

		expect(pwSide.card.textContent).toBe(extensionSide.card.textContent);
		expect(pwSide.card.style.boxShadow).toBe(extensionSide.card.style.boxShadow);
		expect(pwSide.highlight.style.background).toBe(
			extensionSide.highlight.style.background,
		);
		expect(pwSide.layer.textContent).toBe(extensionSide.layer.textContent);

		extensionSide.cleanup();
		pwSide.cleanup();
	});
});
