import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { TourScript } from "@dg/common";
import { initialPlayState, type PlayState } from "../src/engine";
import type { CaptureStart, TourRecorder } from "../src/host";
import { runTour } from "../src/player";
import {
	buttons,
	clickButton,
	clickByAria,
	type FakeHost,
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

const actionScript = (): TourScript =>
	threeStepScript({
		steps: [
			{ title: "Alpha heading", body: "a", action: { do: "click" } },
			{ title: "Beta heading", body: "b" },
		],
	});

function clickByTitle(host: FakeHost, title: string): void {
	const found = buttons(host).find((b) => b.title === title);
	if (!found) throw new Error(`no live button titled ${title}`);
	found.click();
}

type FakeRecorder = TourRecorder & {
	captures: number;
	wrapUps: number;
	start(start: CaptureStart): void;
};

function fakeRecorder(): FakeRecorder {
	let resolveCapture: ((start: CaptureStart) => void) | undefined;
	const recorder: FakeRecorder = {
		captures: 0,
		wrapUps: 0,
		capture: () =>
			new Promise<CaptureStart>((resolve) => {
				recorder.captures++;
				resolveCapture = resolve;
			}),
		wrapUp: async () => {
			recorder.wrapUps++;
		},
		start: (start) => resolveCapture?.(start),
	};
	return recorder;
}

describe("runTour — action consent", () => {
	it("asks before automatic actions and stops when the viewer cancels", async () => {
		const host = Object.assign(fakeHost(), { actionConsent: true });

		const result = runTour(host, actionScript(), { mode: "walkthrough" });
		await until(
			() => host.live().some((m) => m.name === "dg-demo-setup-consent"),
			"the consent card",
		);
		expect(host.liveText()).not.toContain("Alpha heading");
		clickButton(host, /^cancel$/i);

		expect(await settle(result, "the cancelled result")).toMatchObject({
			outcome: "stopped",
		});
		expect(host.store.has("demo_tour:7")).toBe(false);
	});

	it("records the approval and plays on", async () => {
		const host = Object.assign(fakeHost(), { actionConsent: true });

		void runTour(host, actionScript(), { mode: "walkthrough" });
		await until(
			() => host.liveText().includes("Approve automatic actions"),
			"the consent card",
		);
		clickButton(host, /approve automatic actions/i);
		await until(() => host.liveText().includes("Alpha heading"), "step 1");

		expect(host.store.get("demo_tour:7")).toMatchObject({
			automaticActionsApproved: true,
		});
	});

	it("does not ask when the host has no consent capability", async () => {
		const host = fakeHost();

		void runTour(host, actionScript(), { mode: "walkthrough" });
		await until(() => host.liveText().includes("Alpha heading"), "step 1");

		expect(host.mounts.map((m) => m.name)).not.toContain(
			"dg-demo-setup-consent",
		);
	});
});

describe("runTour — end screen", () => {
	const twoSteps = (): TourScript =>
		threeStepScript({
			steps: [
				{ title: "Alpha heading", body: "a" },
				{ title: "Beta heading", body: "b" },
			],
		});

	it("keeps the tour until the viewer closes the end card", async () => {
		const host = Object.assign(fakeHost(), { endScreen: true });

		const result = runTour(host, twoSteps(), { mode: "walkthrough" });
		await until(() => host.liveText().includes("Alpha heading"), "step 1");
		clickByAria(host, "Next step");
		await until(() => host.liveText().includes("Beta heading"), "step 2");
		clickButton(host, /^done$/i);
		await until(
			() => host.liveText().includes("Walkthrough complete"),
			"the end card",
		);
		expect(host.store.has("demo_tour:7")).toBe(true);
		expect(host.liveText()).not.toContain("Back to the plan");
		clickButton(host, /close/i);

		expect(await settle(result, "the done result")).toMatchObject({
			outcome: "done",
		});
		expect(host.store.has("demo_tour:7")).toBe(false);
	});

	it("offers the plan again for a tour launched from the editor", async () => {
		const opened: TourScript[] = [];
		const host = Object.assign(fakeHost(), {
			endScreen: true,
			openEditor: async (script: TourScript) => {
				opened.push(script);
			},
		});
		const script = twoSteps();
		host.store.set("demo_tour:7", {
			...initialPlayState(script, "reviewed-editor"),
			index: 1,
		});

		const result = runTour(host, script, { mode: "walkthrough" });
		await until(() => host.liveText().includes("Beta heading"), "step 2");
		clickButton(host, /^done$/i);
		await until(
			() => host.liveText().includes("Back to the plan"),
			"the end card",
		);
		clickButton(host, /back to the plan/i);

		expect(await settle(result, "the done result")).toMatchObject({
			outcome: "done",
		});
		expect(opened).toHaveLength(1);
		expect(host.store.has("demo_tour:7")).toBe(false);
	});

	it("returns an editor-launched tour to the editor when the viewer ends it", async () => {
		const opened: TourScript[] = [];
		const host = Object.assign(fakeHost(), {
			openEditor: async (script: TourScript) => {
				opened.push(script);
			},
		});
		const script = twoSteps();
		host.store.set("demo_tour:7", initialPlayState(script, "reviewed-editor"));

		const result = runTour(host, script, { mode: "walkthrough" });
		await until(() => host.liveText().includes("Alpha heading"), "step 1");
		clickByTitle(host, "End tour");

		expect(await settle(result, "the stopped result")).toMatchObject({
			outcome: "stopped",
		});
		expect(opened).toEqual([script]);
	});
});

describe("runTour — recorder", () => {
	const video = (): TourScript =>
		threeStepScript({
			mode: "video",
			steps: [
				{ title: "Alpha heading", body: "a" },
				{ title: "Beta heading", body: "b" },
			],
		});

	it("waits for capture, then plays with the recorder's durations and keeps the state for the save", async () => {
		const recorder = fakeRecorder();
		const host = Object.assign(fakeHost(), { recorder });

		const result = runTour(host, video(), { mode: "video" });
		await until(() => recorder.captures === 1, "the capture request");
		expect(host.liveText()).not.toContain("Alpha heading");
		recorder.start({ durations: [5, 5], hideBody: true });

		expect(await settle(result, "the done result")).toMatchObject({
			outcome: "done",
			mode: "video",
		});
		expect(recorder.wrapUps).toBe(1);
		expect(host.store.get("demo_recording:7")).toBe(true);
		expect(host.store.get("demo_tour:7")).toMatchObject({
			videoDurations: [5, 5],
			videoHideBody: true,
		});
		expect(host.sent.filter((m) => m.kind === "progress")).toEqual([
			{ kind: "progress", index: 0 },
			{ kind: "progress", index: 1 },
		]);
		expect(host.sent.at(-1)).toEqual({ kind: "done" });
	});

	it("resumes a running recording without asking for capture again", async () => {
		const recorder = fakeRecorder();
		const host = Object.assign(fakeHost(), { recorder });
		const script = video();
		host.store.set("demo_recording:7", true);
		host.store.set("demo_tour:7", {
			...initialPlayState(script, "marker"),
			index: 1,
			videoDurations: [5, 5],
		} satisfies PlayState);

		await settle(runTour(host, script, { mode: "video" }), "the done result");

		expect(recorder.captures).toBe(0);
		expect(host.sent.filter((m) => m.kind === "progress")).toEqual([
			{ kind: "progress", index: 1 },
		]);
	});

	it("hands excluded setup off before it asks for capture", async () => {
		const recorder = fakeRecorder();
		const host = Object.assign(fakeHost(), { recorder });
		const script: TourScript = {
			...video(),
			setup: {
				includeInTour: false,
				steps: [{ title: "Prep heading", body: "prep" }],
			},
		};

		void runTour(host, script, { mode: "video" });
		await until(() => host.liveText().includes("Prep heading"), "setup");
		expect(recorder.captures).toBe(0);
		clickButton(host, /^done$/i);

		await until(() => recorder.captures === 1, "the capture request");
		expect(host.store.get("demo_tour:7")).toMatchObject({
			phase: "tutorial",
			index: 0,
		});
	});
});

describe("runTour — walkthrough messages", () => {
	it("sends no step progress for a walkthrough", async () => {
		const host = fakeHost();
		const script = threeStepScript({
			steps: [{ title: "Alpha heading", body: "a" }],
		});

		const result = runTour(host, script, { mode: "walkthrough" });
		await until(() => host.liveText().includes("Alpha heading"), "step 1");
		clickButton(host, /^done$/i);
		await settle(result, "the done result");

		expect(host.sent).toEqual([]);
	});
});

describe("runTour — video stop", () => {
	it("cancels a running video step when the host reports a stop", async () => {
		const host = fakeHost();
		document.body.innerHTML = '<button id="go"></button>';
		let clicks = 0;
		document.getElementById("go")?.addEventListener("click", () => clicks++);
		const script = threeStepScript({
			mode: "video",
			steps: [
				{ title: "Alpha heading", body: "a", selector: "#go", advance: "click" },
				{ title: "Beta heading", body: "b" },
			],
		});
		host.store.set("demo_tour:7", {
			...initialPlayState(script, "marker"),
			videoDurations: [60_000],
		} satisfies PlayState);

		const result = runTour(host, script, { mode: "video" });
		await until(() => host.liveText().includes("Alpha heading"), "step 1");
		host.emit({ kind: "stopped" });

		expect(await settle(result, "the stopped result")).toMatchObject({
			outcome: "stopped",
			mode: "video",
		});
		expect(clicks).toBe(0);
		expect(host.mounts.some((m) => m.root.textContent?.includes("Beta"))).toBe(
			false,
		);
		expect(host.store.has("demo_tour:7")).toBe(false);
	});

	it("uses the recorder's stored duration as the narration timeout", async () => {
		const host = fakeHost();
		const script = threeStepScript({
			mode: "video",
			steps: [{ title: "Alpha heading", body: "a", advance: 60_000 }],
		});
		host.store.set("demo_tour:7", {
			...initialPlayState(script, "marker"),
			videoDurations: [5],
		} satisfies PlayState);

		expect(
			await settle(runTour(host, script, { mode: "video" }), "the result"),
		).toMatchObject({ outcome: "done" });
	});
});

describe("runTour — detach", () => {
	it("removes its UI and leaves storage alone when the signal aborts", async () => {
		const host = fakeHost();
		const controller = new AbortController();
		let idle = 0;

		const result = runTour(host, threeStepScript(), {
			mode: "walkthrough",
			signal: controller.signal,
			onIdle: () => idle++,
		});
		await until(() => host.liveText().includes("Alpha heading"), "step 1");
		expect(idle).toBe(1);
		const saved = host.store.get("demo_tour:7");
		controller.abort();

		expect(await settle(result, "the detached result")).toMatchObject({
			outcome: "stopped",
		});
		expect(host.live()).toEqual([]);
		expect(host.store.get("demo_tour:7")).toBe(saved);
	});
});

describe("runTour — review", () => {
	it("resolves stopped when the viewer closes the editor", async () => {
		const host = fakeHost();

		const result = runTour(host, threeStepScript(), {});
		await until(() => host.liveText().includes("Play walkthrough"), "start");
		clickButton(host, /review the plan/i);
		await until(
			() => host.live().some((m) => m.name === "dg-demo-edit"),
			"the editor",
		);
		clickByAria(host, "Close the editor");

		expect(await settle(result, "the dismissed result")).toMatchObject({
			outcome: "stopped",
		});
		expect(host.live()).toEqual([]);
		expect(host.store.has("demo_tour:7")).toBe(false);
	});

	it("plays the reviewed plan in the mode the viewer picks", async () => {
		const host = fakeHost();
		const script = threeStepScript({
			steps: [{ title: "Alpha heading", body: "a", advance: 5 }],
		});

		const result = runTour(host, script, {});
		await until(() => host.liveText().includes("Play walkthrough"), "start");
		clickButton(host, /review the plan/i);
		await until(
			() =>
				host
					.live()
					.some(
						(m) =>
							m.name === "dg-demo-edit" &&
							m.root.textContent?.includes("Record video"),
					),
			"the editor",
		);
		clickButton(host, /record video/i);

		expect(await settle(result, "the reviewed result")).toMatchObject({
			outcome: "done",
			mode: "video",
		});
		expect(host.sent.find((m) => m.kind === "choice")).toMatchObject({
			mode: "video",
		});
	});
});
