/**
 * Pure-function tests for review modal helpers extracted from demo-tour.ts.
 * No DOM or WebExtension APIs needed — pure logic only.
 */
import { describe, expect, it, mock } from "bun:test";
import { MSG } from "@/lib/demo-messages";

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
	buildVideoReviewHtml,
	type EditEvent,
	type EditPhase,
	editMachine,
	getNarrationMode,
	handleTourMessage,
	reviewAction,
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

// ── GREEN: coverage gap tests ───────────────────────────────────────────────

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
		expect(run(3, ["next", "next", "next"])).toEqual({ kind: "step", cursor: 2 });
	});

	it("goes back and clamps at 0", () => {
		expect(run(3, ["next", "back", "back"])).toEqual({ kind: "step", cursor: 0 });
	});

	it("approve → done; editAgain returns to the last step", () => {
		expect(run(3, ["approve"])).toEqual({ kind: "done" });
		expect(run(3, ["approve", "editAgain"])).toEqual({ kind: "step", cursor: 2 });
	});

	it("ignores next/back while done", () => {
		expect(run(3, ["approve", "next", "back"])).toEqual({ kind: "done" });
	});
});
