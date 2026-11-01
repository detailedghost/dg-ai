import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { holdFor } from "../src/video-timing";
import type { TourMessage } from "../src/host";
import { runTour, type TourResult } from "../src/player";
import {
	buttons,
	clickButton,
	clickByAria,
	fakeHost,
	installDom,
	restoreDom,
	settle,
	threeStepScript,
	until,
} from "./fake-host";

beforeEach(() => {
	installDom();
});
afterEach(() => {
	restoreDom();
});

describe("runTour — walkthrough", () => {
	it("mounts the start screen first, renders step 1 after the walkthrough choice, advances on Next, and resolves done", async () => {
		const host = fakeHost();
		const script = threeStepScript();

		const result = runTour(host, script, {});

		await until(
			() => host.liveText().includes("Play walkthrough"),
			"the start screen",
		);
		expect(host.mounts[0]?.root.textContent).toContain("Play walkthrough");
		expect(host.liveText()).not.toContain("Alpha heading");

		clickButton(host, /play walkthrough/i);
		await until(() => host.liveText().includes("Alpha heading"), "step 1");
		expect(host.liveText()).not.toContain("Play walkthrough");
		expect(host.liveText()).toContain("Alpha body text");
		expect(host.liveText()).toContain("Step 1 of 3");

		clickByAria(host, "Next step");
		await until(() => host.liveText().includes("Beta heading"), "step 2");
		expect(host.liveText()).toContain("Beta body text");
		clickByAria(host, "Next step");
		await until(() => host.liveText().includes("Gamma heading"), "step 3");
		clickButton(host, /^done$/i);

		const outcome: TourResult = await settle(result, "the tour result");
		expect(outcome).toMatchObject({
			outcome: "done",
			mode: "walkthrough",
			steps: 3,
		});
		expect(outcome.error).toBeUndefined();
	});

	it("stores the cursor under demo_tour:<tab> as the user moves", async () => {
		const host = fakeHost("42");
		const key = "demo_tour:42";

		void runTour(host, threeStepScript(), {});
		await until(() => host.liveText().includes("Play walkthrough"), "start");
		clickButton(host, /play walkthrough/i);
		await until(() => host.liveText().includes("Alpha heading"), "step 1");
		expect((host.store.get(key) as { index: number }).index).toBe(0);

		clickByAria(host, "Next step");
		await until(
			() =>
				(host.store.get(key) as { index?: number } | undefined)?.index === 1,
			"cursor to move to step 2",
		);
		expect(host.store.get(key)).toMatchObject({ index: 1 });
	});

	it("resolves stopped when the user ends the tour", async () => {
		const host = fakeHost();
		const result = runTour(host, threeStepScript(), {});
		await until(() => host.liveText().includes("Play walkthrough"), "start");
		clickButton(host, /play walkthrough/i);
		await until(() => host.liveText().includes("Alpha heading"), "step 1");

		const end = buttons(host).find((b) => b.title === "End tour");
		expect(end).toBeDefined();
		end?.click();

		expect(await settle(result, "the tour result")).toMatchObject({
			outcome: "stopped",
			mode: "walkthrough",
		});
	});

	it("resumes from saved state without showing the start screen", async () => {
		const host = fakeHost("9");
		const script = threeStepScript();
		host.store.set("demo_tour:9", {
			script,
			index: 1,
			phase: "tutorial",
		});

		const result = runTour(host, script, {});

		await until(() => host.liveText().includes("Beta heading"), "step 2");
		expect(
			host.mounts.some((m) =>
				/Play walkthrough/.test(m.root.textContent ?? ""),
			),
		).toBe(false);
		clickByAria(host, "Next step");
		await until(() => host.liveText().includes("Gamma heading"), "step 3");
		clickButton(host, /^done$/i);
		expect(await settle(result, "the tour result")).toMatchObject({
			outcome: "done",
		});
	});

	it("resolves error with the message when the host cannot mount the start screen", async () => {
		const host = fakeHost();
		host.mountUi = async () => {
			throw new Error("shadow root unavailable");
		};

		const outcome = await settle(
			runTour(host, threeStepScript(), {}),
			"the tour result",
		);

		expect(outcome.outcome).toBe("error");
		expect(outcome.error).toContain("shadow root unavailable");
	});
});

describe("runTour — video", () => {
	it("advances each step after holdFor(step, null) and reports done", async () => {
		const host = fakeHost();
		const script = threeStepScript({
			mode: "video",
			steps: [
				{ title: "Alpha heading", body: "a", advance: 30 },
				{ title: "Beta heading", body: "b", advance: 50 },
				{ title: "Gamma heading", body: "c", advance: 40 },
			],
		});

		const outcome = await settle(
			runTour(host, script, { mode: "video" }),
			"the video tour result",
			5000,
		);

		expect(outcome).toMatchObject({ outcome: "done", mode: "video", steps: 3 });
		expect(
			host.mounts.some((m) =>
				/Play walkthrough/.test(m.root.textContent ?? ""),
			),
		).toBe(false);
		const shownAt = (title: string): number => {
			const mount = host.mounts.find((m) =>
				m.root.textContent?.includes(title),
			);
			if (!mount) throw new Error(`step ${title} never rendered`);
			return mount.mountedAt;
		};
		const slack = 10;
		expect(
			shownAt("Beta heading") - shownAt("Alpha heading"),
		).toBeGreaterThanOrEqual(holdFor(script.steps[0], null) - slack);
		expect(
			shownAt("Gamma heading") - shownAt("Beta heading"),
		).toBeGreaterThanOrEqual(holdFor(script.steps[1], null) - slack);
		expect(shownAt("Gamma heading") - shownAt("Beta heading")).toBeLessThan(
			holdFor({}, null),
		);
	});
});

describe("runTour — options", () => {
	it("lets opts.mode decide over script.mode and skips the start screen", async () => {
		const host = fakeHost();
		const script = threeStepScript({ mode: "video" });

		const result = runTour(host, script, { mode: "walkthrough" });

		await until(() => host.liveText().includes("Alpha heading"), "step 1");
		expect(
			host.mounts.some((m) =>
				/Play walkthrough/.test(m.root.textContent ?? ""),
			),
		).toBe(false);
		expect(buttons(host).some((b) => b.title === "End tour")).toBe(true);
		buttons(host)
			.find((b) => b.title === "End tour")
			?.click();
		expect(await settle(result, "the tour result")).toMatchObject({
			outcome: "stopped",
			mode: "walkthrough",
		});
	});

	it("reports the chosen mode and settings through the host", async () => {
		const host = fakeHost();

		void runTour(host, threeStepScript(), {});
		await until(() => host.liveText().includes("Play walkthrough"), "start");
		clickButton(host, /record video/i);
		await until(() => host.sent.some((m) => m.kind === "choice"), "choice");

		expect(host.sent.find((m) => m.kind === "choice")).toMatchObject({
			mode: "video",
			narration: "both",
			voice: "af_heart",
			includeSetup: false,
		});
	});

	it("clears the stored tour state when the tour ends", async () => {
		const host = fakeHost("3");
		const result = runTour(host, threeStepScript(), {});
		await until(() => host.liveText().includes("Play walkthrough"), "start");
		clickButton(host, /play walkthrough/i);
		await until(() => host.liveText().includes("Alpha heading"), "step 1");

		buttons(host)
			.find((b) => b.title === "End tour")
			?.click();
		await settle(result, "the tour result");

		expect(host.store.has("demo_tour:3")).toBe(false);
	});
});

describe("runTour — review", () => {
	it("opens the edit panel for the review choice instead of starting playback", async () => {
		const host = fakeHost();

		void runTour(host, threeStepScript(), {});
		await until(() => host.liveText().includes("Play walkthrough"), "start");
		clickButton(host, /review the plan/i);
		await until(
			() => host.mounts.some((m) => m.name === "dg-demo-edit"),
			"the edit panel",
		);

		expect(host.liveText()).not.toContain("Step 1 of 3");
		expect(host.store.has("demo_tour:7")).toBe(false);
	});
});

describe("runTour — narration messages", () => {
	it("advances a step after the narration-complete message plus the tail instead of the silent hold", async () => {
		const host = fakeHost();
		let handler: ((msg: TourMessage) => void) | undefined;
		const original = host.messages.on;
		host.messages.on = (h) => {
			handler = h;
			return original(h);
		};
		const script = threeStepScript({
			mode: "video",
			steps: [{ title: "Alpha heading", body: "a" }],
		});
		const started = Date.now();

		const result = runTour(host, script, { mode: "video" });
		await until(() => handler !== undefined, "the narration listener");
		handler?.({ kind: "narration-complete", ms: 10 });

		const outcome = await settle(result, "the tour result", 2500);
		expect(outcome).toMatchObject({ outcome: "done", mode: "video", steps: 1 });
		expect(Date.now() - started).toBeLessThan(holdFor({}, null));
	});
});

describe("runTour — video controls", () => {
	it("stops the tour when the host reports a stop during a video step", async () => {
		const host = fakeHost();
		const script = threeStepScript({ mode: "video" });

		const result = runTour(host, script, { mode: "video" });
		await until(() => host.liveText().includes("Alpha heading"), "step 1");
		host.emit({ kind: "stopped" });

		const outcome = await settle(result, "the stopped result", 1000);
		expect(outcome).toMatchObject({ outcome: "stopped", mode: "video" });
		expect(host.liveText()).not.toContain("Beta heading");
		expect(host.store.has("demo_tour:7")).toBe(false);
	});

	it("ignores a narration-complete message for another step", async () => {
		const host = fakeHost();
		const script = threeStepScript({
			mode: "video",
			steps: [{ title: "Alpha heading", body: "a" }],
		});

		const result = runTour(host, script, { mode: "video" });
		await until(() => host.liveText().includes("Alpha heading"), "step 1");
		host.emit({ kind: "narration-complete", index: 4 });
		await new Promise((resolve) => setTimeout(resolve, 50));
		host.emit({ kind: "stopped" });

		expect(await settle(result, "the tour result", 1000)).toMatchObject({
			outcome: "stopped",
		});
	});
});

describe("runTour — failure", () => {
	it("clears the saved state after an error so the next run shows the start screen", async () => {
		const host = fakeHost();
		const mountUi = host.mountUi;
		let mounted = 0;
		host.mountUi = async (name, onMount) => {
			mounted++;
			if (mounted === 2) throw new Error("mount failed on step 1");
			return mountUi(name, onMount);
		};
		const first = runTour(host, threeStepScript(), {});
		await until(() => host.liveText().includes("Play walkthrough"), "start");
		clickButton(host, /play walkthrough/i);

		const outcome = await settle(first, "the failed result");

		expect(outcome.outcome).toBe("error");
		expect(host.store.has("demo_tour:7")).toBe(false);
		host.mountUi = mountUi;
		void runTour(host, threeStepScript(), {});
		await until(
			() => host.liveText().includes("Play walkthrough"),
			"the start screen again",
		);
	});
});

describe("runTour — result mode", () => {
	it("reports video when the user picks Record video", async () => {
		const host = fakeHost();
		const result = runTour(host, threeStepScript(), {});
		await until(() => host.liveText().includes("Play walkthrough"), "start");
		clickButton(host, /record video/i);
		await until(() => host.liveText().includes("Alpha heading"), "step 1");
		host.emit({ kind: "stopped" });

		expect(await settle(result, "the tour result", 1000)).toMatchObject({
			outcome: "stopped",
			mode: "video",
		});
	});
});
