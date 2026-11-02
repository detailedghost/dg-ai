import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { recIndicator, renderStep } from "../src/overlay";
import {
	buttons,
	fakeHost,
	installDom,
	restoreDom,
	threeStepScript,
} from "./fake-host";

beforeEach(() => {
	installDom();
});
afterEach(() => {
	restoreDom();
});

describe("renderStep", () => {
	it("mounts through the host with the step title, body and position", async () => {
		const host = fakeHost();
		const script = threeStepScript();
		const step = script.steps[1];
		if (!step) throw new Error("fixture needs a second step");

		await renderStep(host, { script, index: 1 }, step);

		expect(host.live().length).toBe(1);
		expect(host.liveText()).toContain(step.title as string);
		expect(host.liveText()).toContain(step.body);
		expect(host.liveText()).toContain("Step 2 of 3");
	});

	it("offers Done only on the last step", async () => {
		const script = threeStepScript();
		const first = fakeHost();
		const last = fakeHost();
		const lastStep = script.steps[2];
		if (!lastStep || !script.steps[0]) throw new Error("fixture needs steps");

		await renderStep(first, { script, index: 0 }, script.steps[0]);
		await renderStep(last, { script, index: 2 }, lastStep);

		const hasDone = (h: typeof first) =>
			buttons(h).some((b) => /^done$/i.test(b.textContent ?? ""));
		expect(hasDone(first)).toBe(false);
		expect(hasDone(last)).toBe(true);
	});
});

describe("renderStep in a voice-only recording", () => {
	const voiced = async (index: number, unvoiced: number[]) => {
		const host = fakeHost();
		const script = threeStepScript({ mode: "video" });
		const step = script.steps[index];
		if (!step) throw new Error("fixture needs steps");
		await renderStep(
			host,
			{ script, index, mode: "video", videoHideBody: true, videoUnvoiced: unvoiced } as never,
			step,
		);
		return { text: host.liveText(), step };
	};

	it("hides the body of a voiced step", async () => {
		const { text, step } = await voiced(0, [1]);
		expect(text).not.toContain(step.body);
	});

	it("keeps the caption of a step that has no voice", async () => {
		const { text, step } = await voiced(1, [1]);
		expect(text).toContain(step.body);
	});
});

describe("recIndicator", () => {
	it("labels the recording state", () => {
		expect(recIndicator().textContent).toContain("REC");
	});
});
