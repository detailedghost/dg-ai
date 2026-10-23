import { describe, expect, test } from "bun:test";
import type { TourScript } from "@dg/common";
import {
	type DemoPwDriver,
	recordLocalDemo,
} from "../../src/demo/local-record";

function fakeDriver(): DemoPwDriver & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		async open(url) {
			calls.push(`open ${url}`);
		},
		async goto(url) {
			calls.push(`goto ${url}`);
		},
		async renderStep(step) {
			calls.push(`renderStep ${step.index}/${step.total} target=${step.target ?? "none"} video=${step.video}`);
		},
		async click(selector) {
			calls.push(`click ${selector}`);
		},
		async fill(selector, value) {
			calls.push(`fill ${selector} ${value}`);
		},
		async screenshot(filename, colorScheme) {
			calls.push(`screenshot ${colorScheme} ${filename}`);
		},
		async videoStart(filename) {
			calls.push(`videoStart ${filename}`);
		},
		async videoStop() {
			calls.push("videoStop");
		},
		async close() {
			calls.push("close");
		},
	};
}

const baseScript: TourScript = {
	title: "Saved filters",
	startUrl: "https://app.example/start",
	steps: [
		{ selector: "#save", title: "Save a filter", body: "Click here.", action: { do: "click" } },
		{ body: "Centered step, no selector." },
	],
};

const noHold = async (): Promise<void> => undefined;

describe("recordLocalDemo", () => {
	test("opens, takes a before pair, renders every tutorial step, takes an after pair, then closes — no video outside video mode", async () => {
		const driver = fakeDriver();
		await recordLocalDemo(baseScript, "/out", driver, noHold);
		expect(driver.calls).toEqual([
			"open https://app.example/start",
			"screenshot light /out/before-light.png",
			"screenshot dark /out/before-dark.png",
			"renderStep 0/2 target=#save video=false",
			"click #save",
			"renderStep 1/2 target=none video=false",
			"screenshot light /out/after-light.png",
			"screenshot dark /out/after-dark.png",
			"close",
		]);
	});

	test("brackets the steps with video-start/video-stop in video mode", async () => {
		const driver = fakeDriver();
		await recordLocalDemo({ ...baseScript, mode: "video" }, "/out", driver, noHold);
		expect(driver.calls[3]).toBe("videoStart /out/recording.webm");
		expect(driver.calls.at(-4)).toBe("videoStop");
		expect(driver.calls.filter((c) => c.includes("video=true"))).toHaveLength(2);
	});

	test("navigates when a step's navigate differs from the current url, and skips it when already there", async () => {
		const driver = fakeDriver();
		const script: TourScript = {
			startUrl: "https://app.example/a",
			steps: [
				{ body: "Already here.", navigate: "https://app.example/a" },
				{ body: "Go to b.", navigate: "https://app.example/b" },
			],
		};
		await recordLocalDemo(script, "/out", driver, noHold);
		expect(driver.calls.filter((c) => c.startsWith("goto"))).toEqual([
			"goto https://app.example/b",
		]);
	});

	test("fills an authored @type action instead of clicking", async () => {
		const driver = fakeDriver();
		const script: TourScript = {
			startUrl: "https://app.example/a",
			steps: [{ selector: "#q", body: "Search.", action: { do: "fill", value: "cute puppies" } }],
		};
		await recordLocalDemo(script, "/out", driver, noHold);
		expect(driver.calls).toContain("fill #q cute puppies");
	});

	test("synthesizes the click an advance:click step is waiting for — there's no user to click it", async () => {
		const driver = fakeDriver();
		const script: TourScript = {
			startUrl: "https://app.example/a",
			steps: [{ selector: "#toggle", body: "Toggle it.", advance: "click" }],
		};
		await recordLocalDemo(script, "/out", driver, noHold);
		expect(driver.calls).toContain("click #toggle");
	});

	test("excludes setup steps not marked includeInTour", async () => {
		const driver = fakeDriver();
		const script: TourScript = {
			startUrl: "https://app.example/a",
			setup: { includeInTour: false, steps: [{ body: "Sign in first." }] },
			steps: [{ body: "Tutorial step." }],
		};
		await recordLocalDemo(script, "/out", driver, noHold);
		const rendered = driver.calls.filter((c) => c.startsWith("renderStep"));
		expect(rendered).toHaveLength(1);
	});
});
