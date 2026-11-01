import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { TourScript } from "@dg/common";
import type { TourOptions, TourResult } from "../src/player";
import { installDom, restoreDom, threeStepScript } from "./fake-host";

type Tour = {
	run(script: TourScript, opts?: TourOptions): Promise<TourResult>;
};
type Bridge = (msg: unknown) => Promise<unknown>;

let imports = 0;

async function loadEntry(bridge?: Bridge): Promise<Tour> {
	const win = installDom() as unknown as Record<string, unknown>;
	if (bridge) win.__dgDemoBridge = bridge;
	await import(`../src/hosts/player-entry?run=${++imports}`);
	return win.__dgTour as Tour;
}

const quickVideo = (): TourScript =>
	threeStepScript({
		mode: "video",
		steps: [
			{ title: "Alpha heading", body: "a", advance: 10 },
			{ title: "Beta heading", body: "b", advance: 10 },
		],
	});

beforeEach(() => {
	installDom();
});
afterEach(() => {
	restoreDom();
});

describe("window.__dgTour.run without a bridge", () => {
	it("keeps state in memory and returns the tour result", async () => {
		const tour = await loadEntry();

		const result = await tour.run(quickVideo(), { mode: "video" });

		expect(result).toMatchObject({ outcome: "done", mode: "video", steps: 2 });
	});
});

describe("window.__dgTour.run with a bridge", () => {
	it("reads and writes state through the bridge and reports completion", async () => {
		const store = new Map<string, unknown>();
		const calls: Array<{ kind: string; key?: string }> = [];
		const tour = await loadEntry(async (raw) => {
			const msg = raw as { kind: string; key?: string; value?: unknown };
			calls.push(msg);
			if (msg.kind === "storage-set") store.set(msg.key as string, msg.value);
			if (msg.kind === "storage-remove") store.delete(msg.key as string);
			if (msg.kind === "storage-get") return store.get(msg.key as string);
			return undefined;
		});

		const result = await tour.run(quickVideo(), { mode: "video" });

		expect(result.outcome).toBe("done");
		expect(
			calls.some(
				(c) => c.kind === "storage-get" && c.key === "demo_tour:local",
			),
		).toBe(true);
		expect(
			calls.some(
				(c) => c.kind === "storage-set" && c.key === "demo_tour:local",
			),
		).toBe(true);
		expect(calls.at(-1)).toEqual({ kind: "done" });
	});

	it("resumes the state the bridge holds instead of starting over", async () => {
		const script = quickVideo();
		const saved = { script, index: 1, phase: "tutorial" };
		const shown: string[] = [];
		const tour = await loadEntry(async (raw) => {
			const msg = raw as { kind: string; key?: string; index?: number };
			if (msg.kind === "storage-get") return saved;
			if (msg.kind === "progress") shown.push(String(msg.index));
			return undefined;
		});

		const result = await tour.run(script, { mode: "video" });

		expect(result.outcome).toBe("done");
		expect(shown).toEqual(["1"]);
	});

	it("returns the error message and tells the bridge", async () => {
		const sent: unknown[] = [];
		const tour = await loadEntry(async (raw) => {
			const msg = raw as { kind: string };
			sent.push(msg);
			if (msg.kind === "storage-get") throw new Error("bridge offline");
			return undefined;
		});

		const result = await tour.run(quickVideo(), { mode: "video" });

		expect(result.outcome).toBe("error");
		expect(result.error).toContain("bridge offline");
		expect(sent.at(-1)).toMatchObject({
			kind: "error",
			message: expect.stringContaining("bridge offline"),
		});
	});
});
