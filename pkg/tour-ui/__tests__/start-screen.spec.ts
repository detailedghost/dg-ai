import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { toPlanMarkdown } from "@dg/common";
import { showStartScreen } from "../src/start-screen";
import {
	buttons,
	clickButton,
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

describe("showStartScreen", () => {
	it("renders the narration and voice selects and every action button", async () => {
		const host = fakeHost();
		void showStartScreen(host, threeStepScript(), {});
		await until(() => host.live().length > 0, "the start screen mount");
		const root = host.live()[0]?.root as HTMLElement;

		expect(root.querySelectorAll("select").length).toBe(2);
		const labels = buttons(host).map((b) => b.textContent ?? "");
		for (const wanted of [
			/review/i,
			/play walkthrough/i,
			/record video/i,
			/download plan/i,
		]) {
			expect(labels.some((l) => wanted.test(l))).toBe(true);
		}
	});

	it("resolves with mode walkthrough for Play walkthrough", async () => {
		const host = fakeHost();
		const choice = showStartScreen(host, threeStepScript(), {});
		await until(() => host.live().length > 0, "the start screen mount");

		clickButton(host, /play walkthrough/i);

		expect(await settle(choice, "the choice")).toMatchObject({
			mode: "walkthrough",
		});
	});

	it("resolves with mode video for Record video", async () => {
		const host = fakeHost();
		const choice = showStartScreen(host, threeStepScript(), {});
		await until(() => host.live().length > 0, "the start screen mount");

		clickButton(host, /record video/i);

		expect(await settle(choice, "the choice")).toMatchObject({ mode: "video" });
	});

	it("carries the include-setup toggle into the choice", async () => {
		const host = fakeHost();
		const script = threeStepScript({
			setup: { includeInTour: false, steps: [{ body: "Prepare" }] },
		});
		const choice = showStartScreen(host, script, {});
		await until(() => host.live().length > 0, "the start screen mount");
		const toggle = host
			.live()[0]
			?.root.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
		expect(toggle).not.toBeNull();
		if (toggle) toggle.checked = true;

		clickButton(host, /play walkthrough/i);

		expect(await settle(choice, "the choice")).toMatchObject({
			includeSetup: true,
		});
	});

	it("sends the plan markdown through the host for Download plan", async () => {
		const host = fakeHost();
		const script = threeStepScript();
		void showStartScreen(host, script, {});
		await until(() => host.live().length > 0, "the start screen mount");

		clickButton(host, /download plan/i);
		await until(() => host.sent.length > 0, "the download message");

		expect(host.sent[0]).toMatchObject({
			kind: "download-plan",
			markdown: toPlanMarkdown(script),
		});
	});
});

describe("showStartScreen — review and settings", () => {
	it("resolves with mode review for the review button", async () => {
		const host = fakeHost();
		const choice = showStartScreen(host, threeStepScript(), {});
		await until(() => host.live().length > 0, "the start screen mount");

		clickButton(host, /review the plan/i);

		expect(await settle(choice, "the choice")).toMatchObject({
			mode: "review",
		});
	});

	it("removes its mount once a choice is made", async () => {
		const host = fakeHost();
		const choice = showStartScreen(host, threeStepScript(), {});
		await until(() => host.live().length > 0, "the start screen mount");

		clickButton(host, /record video/i);
		await settle(choice, "the choice");

		expect(host.live()).toHaveLength(0);
	});

	it("starts from the supplied narration and voice", async () => {
		const host = fakeHost();
		const choice = showStartScreen(host, threeStepScript(), {
			narration: "captions",
			voice: "bf_emma",
		});
		await until(() => host.live().length > 0, "the start screen mount");

		clickButton(host, /record video/i);

		expect(await settle(choice, "the choice")).toMatchObject({
			narration: "captions",
			voice: "bf_emma",
		});
	});

	it("carries a changed narration and voice into the choice and reports each change", async () => {
		const host = fakeHost();
		const patches: unknown[] = [];
		const choice = showStartScreen(host, threeStepScript(), {
			onSetting: (patch) => patches.push(patch),
		});
		await until(() => host.live().length > 0, "the start screen mount");
		const [narration, voice] = [
			...(host.live()[0]?.root.querySelectorAll("select") ?? []),
		] as HTMLSelectElement[];
		if (!narration || !voice) throw new Error("expected two selects");
		narration.value = "voice";
		narration.dispatchEvent(new window.Event("change"));
		voice.value = "am_puck";
		voice.dispatchEvent(new window.Event("change"));

		clickButton(host, /play walkthrough/i);

		expect(await settle(choice, "the choice")).toMatchObject({
			narration: "voice",
			voice: "am_puck",
		});
		expect(patches).toEqual([{ narration: "voice" }, { voice: "am_puck" }]);
	});

	it("uses the default narration and voice when none are supplied", async () => {
		const host = fakeHost();
		const choice = showStartScreen(host, threeStepScript(), {});
		await until(() => host.live().length > 0, "the start screen mount");

		clickButton(host, /play walkthrough/i);

		expect(await settle(choice, "the choice")).toMatchObject({
			narration: "both",
			voice: "af_heart",
			includeSetup: false,
		});
	});
});
