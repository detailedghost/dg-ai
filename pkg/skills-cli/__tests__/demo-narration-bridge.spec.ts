import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBridge } from "../src/demo/bridge";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dg-bridge-clip-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const bridge = (onVoiceChoice?: () => Promise<"voice" | "captions-only">) =>
	createBridge({
		job: { dir, planPath: join(dir, "s.demo.md"), slug: "s", video: true },
		onVoiceChoice,
	});

const base64 = (samples: number[]): string =>
	Buffer.from(new Float32Array(samples).buffer).toString("base64");

const clipFiles = (): string[] => {
	const clips = join(dir, "clips");
	return existsSync(clips) ? readdirSync(clips).sort() : [];
};

describe("bridge clip messages", () => {
	const granted = async () => {
		const b = bridge(async () => "voice");
		await b.handle({ kind: "choice", mode: "video", narration: "voice", voice: "af_heart" });
		return b;
	};

	test("drops a clip when the voice choice was never granted", async () => {
		await bridge().handle({
			kind: "clip",
			index: 0,
			sampleRate: 24000,
			pcm: base64([0.5]),
		});
		expect(clipFiles()).toEqual([]);
	});

	test("writes the decoded float samples to clips/<index>.f32", async () => {
		await (await granted()).handle({
			kind: "clip",
			index: 2,
			sampleRate: 24000,
			pcm: base64([0.25, -0.5]),
		});
		expect(clipFiles()).toEqual(["2.f32"]);
		const bytes = readFileSync(join(dir, "clips", "2.f32"));
		expect([...new Float32Array(bytes.buffer, bytes.byteOffset, 2)]).toEqual([
			0.25, -0.5,
		]);
	});

	test("accepts a clip far larger than an ordinary message", async () => {
		const samples = new Array(300_000).fill(0.1) as number[];
		await (await granted()).handle({
			kind: "clip",
			index: 0,
			sampleRate: 24000,
			pcm: base64(samples),
		});
		expect(readFileSync(join(dir, "clips", "0.f32")).length).toBe(1_200_000);
	});

	test.each([
		["a negative index", { index: -1 }],
		["a fractional index", { index: 1.5 }],
		["an index past the cap", { index: 1000 }],
		["a string index", { index: "0" }],
		["a foreign sample rate", { sampleRate: 44100 }],
		["non-base64 data", { pcm: "not base64!" }],
		["data that is not whole floats", { pcm: Buffer.from([1, 2, 3]).toString("base64") }],
		["empty data", { pcm: "" }],
	])("drops %s", async (_name, patch) => {
		await (await granted()).handle({
			kind: "clip",
			index: 0,
			sampleRate: 24000,
			pcm: base64([0.5]),
			...patch,
		});
		expect(clipFiles()).toEqual([]);
	});

	test("drops a clip above the byte bound", async () => {
		const samples = new Float32Array(2 * 1024 * 1024 + 1);
		await (await granted()).handle({
			kind: "clip",
			index: 0,
			sampleRate: 24000,
			pcm: Buffer.from(samples.buffer).toString("base64"),
		});
		expect(clipFiles()).toEqual([]);
	});
});

describe("bridge voice choice", () => {
	const choice = (narration: string, mode = "video") => ({
		kind: "choice",
		mode,
		narration,
		voice: "af_heart",
	});

	test("asks the voice hook for a both or voice choice on a video and returns its answer", async () => {
		let asked = 0;
		const b = bridge(async () => {
			asked++;
			return "voice";
		});
		expect(await b.handle(choice("both"))).toBe("voice");
		expect(await b.handle(choice("voice"))).toBe("voice");
		expect(asked).toBe(2);
	});

	test("never asks for a captions choice or a walkthrough", async () => {
		let asked = 0;
		const b = bridge(async () => {
			asked++;
			return "voice";
		});
		expect(await b.handle(choice("captions"))).toBe("captions-only");
		expect(await b.handle(choice("both", "walkthrough"))).toBe("captions-only");
		expect(asked).toBe(0);
	});

	test("stores the narration and voice in choice.json", async () => {
		await bridge().handle(choice("voice"));
		expect(JSON.parse(readFileSync(join(dir, "choice.json"), "utf8"))).toMatchObject({
			mode: "video",
			narration: "voice",
			voice: "af_heart",
		});
	});
});

describe("bridge bounds", () => {
	const voiced = async (extra: Partial<Parameters<typeof createBridge>[0]> = {}) => {
		const failures: string[] = [];
		const progress: number[] = [];
		const b = createBridge({
			job: { dir, planPath: join(dir, "s.demo.md"), slug: "s", video: true },
			onVoiceChoice: async () => "voice",
			onNarrationFailed: (reason) => failures.push(reason),
			onProgress: (index) => void progress.push(index),
			steps: 2,
			...extra,
		});
		await b.handle({ kind: "choice", mode: "video", narration: "both", voice: "af_heart" });
		return { b, failures, progress };
	};
	const clip = (index: number) => ({
		kind: "clip",
		index,
		sampleRate: 24000,
		pcm: base64([0.5]),
	});

	test("drops a clip whose index is at or past the step count", async () => {
		const { b } = await voiced();
		await b.handle(clip(2));
		await b.handle(clip(1));
		expect(clipFiles()).toEqual(["1.f32"]);
	});

	test("ignores a progress index outside the steps", async () => {
		const { b, progress } = await voiced();
		for (const index of [-1, 2, 1.5, "x"]) await b.handle({ kind: "progress", index });
		await b.handle({ kind: "progress", index: 1 });
		expect(progress).toEqual([1]);
	});

	test("stops writing once the clips reach the total byte cap", async () => {
		const { b } = await voiced({ steps: 999 });
		const chunk = new Float32Array(1_500_000);
		const pcm = Buffer.from(chunk.buffer).toString("base64");
		for (let index = 0; index < 40; index++)
			await b.handle({ kind: "clip", index, sampleRate: 24000, pcm });
		expect(clipFiles().length).toBe(33);
	});

	test("reports a sanitized narration failure only after a voice grant", async () => {
		const { b, failures } = await voiced();
		await b.handle({ kind: "narration-failed", reason: "blocked\nby csp" });
		expect(failures).toEqual(["blocked by csp"]);
		const seen: string[] = [];
		const quiet = createBridge({
			job: { dir, planPath: join(dir, "s.demo.md"), slug: "s", video: true },
			onNarrationFailed: (r) => void seen.push(r),
		});
		await quiet.handle({ kind: "narration-failed", reason: "x" });
		expect(seen).toEqual([]);
	});

	test("discards every saved clip when narration fails", async () => {
		const { b } = await voiced();
		const pcm = Buffer.from(new Float32Array(240).buffer).toString("base64");
		await b.handle({ kind: "clip", index: 0, sampleRate: 24000, pcm });
		await b.handle({ kind: "clip", index: 1, sampleRate: 24000, pcm });
		expect(clipFiles().length).toBe(2);
		await b.handle({ kind: "narration-failed", reason: "boom" });
		expect(clipFiles()).toEqual([]);
	});
});
