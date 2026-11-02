import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { TourNarrator } from "../src/host";
import { runTour } from "../src/player";
import {
	fakeHost,
	installDom,
	restoreDom,
	settle,
	threeStepScript,
} from "./fake-host";

beforeEach(() => {
	installDom();
});
afterEach(() => {
	restoreDom();
});

const script = () =>
	threeStepScript({
		mode: "video",
		steps: [
			{ title: "Alpha heading", body: "a", advance: 10 },
			{ title: "Beta heading", body: "b", advance: 10 },
		],
	});

function voicedHost(answer: unknown, narrator: TourNarrator) {
	const host = fakeHost();
	host.messages.send = async (msg) => {
		host.sent.push(msg);
		return msg.kind === "choice" ? answer : undefined;
	};
	host.narrator = narrator;
	return host;
}

describe("runTour with a narration option", () => {
	it("announces the choice, narrates the tutorial steps and holds each step for its clip", async () => {
		const prepared: string[][] = [];
		const host = voicedHost("voice", {
			prepare: async (steps, voice, report) => {
				prepared.push(steps.map((s) => s.title ?? ""), [voice]);
				report(100, "done");
				return [20, 20];
			},
		});

		const result = await settle(
			runTour(host, script(), {
				mode: "video",
				narration: { narration: "voice", voice: "am_adam" },
			}),
			"the narrated tour",
			5000,
		);

		expect(result).toMatchObject({ outcome: "done", mode: "video" });
		expect(host.sent).toContainEqual(
			expect.objectContaining({ kind: "choice", narration: "voice", voice: "am_adam" }),
		);
		expect(prepared).toEqual([["Alpha heading", "Beta heading"], ["am_adam"]]);
	});

	it("skips narration when the host answers captions-only", async () => {
		let prepares = 0;
		const host = voicedHost("captions-only", {
			prepare: async () => {
				prepares++;
				return [];
			},
		});
		await settle(
			runTour(host, script(), {
				mode: "video",
				narration: { narration: "both", voice: "af_heart" },
			}),
			"the captions tour",
			5000,
		);
		expect(prepares).toBe(0);
	});

	it("records without voice when narration fails", async () => {
		const warn = spyOn(console, "warn").mockImplementation(() => undefined);
		const host = voicedHost("voice", {
			prepare: async () => {
				throw new Error("model fetch failed");
			},
		});
		const result = await settle(
			runTour(host, script(), {
				mode: "video",
				narration: { narration: "both", voice: "af_heart" },
			}),
			"the fallback tour",
			8000,
		);
		expect(result.outcome).toBe("done");
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
		expect(host.live()).toEqual([]);
	});
});

describe("runTour with a narrator that reports clip lengths", () => {
	const clickScript = () =>
		threeStepScript({
			mode: "video",
			steps: [
				{
					title: "Alpha heading",
					body: "a",
					selector: "#go",
					action: { do: "click" },
					advance: 10,
				},
				{ title: "Beta heading", body: "b", advance: 10 },
			],
		});

	async function clickDelay(clipMs: number | undefined, holdMs: number) {
		const button = document.createElement("button");
		button.id = "go";
		document.body.appendChild(button);
		const host = voicedHost("voice", {
			prepare: async () => [holdMs, 20],
			clipMs: (index) => (index === 0 ? clipMs : undefined),
		});
		let clickedAt = 0;
		button.addEventListener("click", () => {
			clickedAt = performance.now();
		});
		const startedAt = performance.now();
		await settle(
			runTour(host, clickScript(), {
				mode: "video",
				narration: { narration: "voice", voice: "af_heart" },
			}),
			"the narrated tour",
			5000,
		);
		return clickedAt - startedAt;
	}

	it("performs the click once the clip ends instead of after the full hold", async () => {
		const delay = await clickDelay(30, 900);
		expect(delay).toBeGreaterThan(0);
		expect(delay).toBeLessThan(600);
	});

	it("keeps the hold as the upper bound when the clip outlasts it", async () => {
		const delay = await clickDelay(5000, 300);
		expect(delay).toBeGreaterThanOrEqual(280);
		expect(delay).toBeLessThan(1500);
	});
});

describe("runTour with a refused clip in voice mode", () => {
	it("stores the unvoiced step indices so those steps keep captions", async () => {
		const host = voicedHost("voice", {
			prepare: async () => [20, 20],
			clipMs: (index) => (index === 0 ? 100 : undefined),
		});
		const writes: unknown[] = [];
		const set = host.storage.set;
		host.storage.set = async (key, value) => {
			writes.push(value);
			return set(key, value);
		};
		await settle(
			runTour(host, script(), {
				mode: "video",
				narration: { narration: "voice", voice: "af_heart" },
			}),
			"the partial tour",
			5000,
		);
		const saved = JSON.stringify(writes);
		expect(saved).toContain('"videoUnvoiced":[1]');
	});
});
