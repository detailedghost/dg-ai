import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MuxDeps, muxVideo } from "../src/demo/mux";
import type { PlayerJob } from "../src/demo/player-job";
import { runPlayer } from "../src/demo/player-process";
import type { DemoResult } from "../src/demo/result";
import { isolatedHome, releaseFetch } from "./demo-narration-route-fixtures";

const START = "https://example.test/";

let dir: string;
let lines: string[];
let log: ReturnType<typeof spyOn>;
let home: ReturnType<typeof isolatedHome>;

beforeEach(() => {
	home = isolatedHome();
	dir = mkdtempSync(join(tmpdir(), "dg-trim-"));
	lines = [];
	log = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		lines.push(args.join(" "));
	});
});
afterEach(() => {
	log.mockRestore();
	home.restore();
	rmSync(home.dir, { recursive: true, force: true });
	rmSync(dir, { recursive: true, force: true });
});

describe("muxVideo trimming", () => {
	const video = () => join(dir, "raw.webm");
	const wav = () => join(dir, "voice.wav");
	const out = () => join(dir, "out.webm");
	const ffmpeg = (calls: string[][], code = 0): MuxDeps => ({
		which: () => "/usr/bin/ffmpeg",
		spawn: async (argv) => {
			calls.push(argv);
			if (code === 0) writeFileSync(out(), "cut");
			return code;
		},
	});

	test("trims the video alone with one ffmpeg run", async () => {
		const calls: string[][] = [];
		const result = await muxVideo(
			{ video: video(), out: out(), startMs: 4200 },
			ffmpeg(calls),
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.slice(0, 6)).toEqual([
			"/usr/bin/ffmpeg",
			"-y",
			"-nostdin",
			"-ss",
			"4.200",
			"-i",
		]);
		expect(calls[0]).toContain(video());
		expect(calls[0]).not.toContain("-shortest");
		expect(calls[0]?.at(-1)).toBe(out());
		expect(result).toEqual({ audio: "none", trimmed: true });
	});

	test("trims the video and the voice together in one ffmpeg run", async () => {
		const calls: string[][] = [];
		const result = await muxVideo(
			{ video: video(), wav: wav(), out: out(), startMs: 2500 },
			ffmpeg(calls),
		);
		expect(calls).toHaveLength(1);
		const argv = calls[0] as string[];
		const seeks = argv.flatMap((arg, at) => (arg === "-ss" ? [argv[at + 1]] : []));
		expect(seeks).toEqual(["2.500", "2.500"]);
		expect(argv.indexOf(wav())).toBeGreaterThan(argv.indexOf(video()));
		expect(argv).toContain("libopus");
		expect(argv).toContain("-shortest");
		expect(result).toEqual({ audio: "muxed", trimmed: true });
	});

	test("keeps stream copy when only the voice is added", async () => {
		const calls: string[][] = [];
		await muxVideo({ video: video(), wav: wav(), out: out(), startMs: 200 }, ffmpeg(calls));
		expect(calls[0]).not.toContain("-ss");
		expect(calls[0]).toContain("copy");
	});

	test("prints one line naming the start screen and how to trim when ffmpeg is absent", async () => {
		const spawned: string[][] = [];
		const result = await muxVideo(
			{ video: video(), out: out(), startMs: 4200 },
			{ which: () => null, spawn: async (argv) => (spawned.push(argv), 0) },
		);
		expect(spawned).toEqual([]);
		expect(result).toEqual({ audio: "none", trimmed: false });
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("start screen");
		expect(lines[0]).toContain("ffmpeg -ss 4.200");
		expect(lines[0]).toContain(video());
	});

	test("reports the untrimmed video when ffmpeg fails", async () => {
		const result = await muxVideo(
			{ video: video(), out: out(), startMs: 4200 },
			ffmpeg([], 1),
		);
		expect(result).toEqual({ audio: "none", trimmed: false });
		expect(existsSync(out())).toBe(false);
		expect(lines.at(-1)).toContain("untrimmed");
	});
});

const job = (): PlayerJob => ({
	slug: "trim",
	planPath: join(dir, "trim.demo.md"),
	dir,
	video: true,
	startUrl: START,
	script: { title: "Trim", startUrl: START, steps: [{ title: "One", body: "b" }] },
});

function launch(onPlay: (send: (msg: unknown) => Promise<unknown>) => Promise<void>) {
	const main = { url: () => START };
	let binding: ((source: unknown, msg: unknown) => unknown) | undefined;
	const page = {
		mainFrame: () => main,
		exposeBinding: async (_name: string, cb: typeof binding) => {
			binding = cb;
		},
		addInitScript: async () => undefined,
		route: async () => undefined,
		on: () => undefined,
		evaluate: async () => undefined,
		goto: async () => onPlay(async (msg) => binding?.({ frame: main, page }, msg)),
		video: () => ({
			path: async () => {
				mkdirSync(join(dir, "rec"), { recursive: true });
				const file = join(dir, "rec", "raw.webm");
				writeFileSync(file, "webm");
				return file;
			},
		}),
	};
	return async () => ({
		context: {
			pages: () => [page],
			newPage: async () => page,
			once: () => undefined,
			close: async () => undefined,
		} as never,
		close: async () => undefined,
	});
}

const result = (): DemoResult =>
	JSON.parse(readFileSync(join(dir, "trim.result.json"), "utf8"));

describe("runPlayer with a late first step", () => {
	let now: ReturnType<typeof spyOn>;
	let clock: number;
	beforeEach(() => {
		clock = 1_000_000;
		now = spyOn(Date, "now").mockImplementation(() => clock);
	});
	afterEach(() => now.mockRestore());

	const late = launch(async (send) => {
		await send({ kind: "choice", mode: "video", narration: "captions", voice: "af_heart" });
		clock += 6_500;
		await send({ kind: "progress", index: 0 });
		await send({ kind: "done" });
	});

	test("records the start offset and trims the final video when ffmpeg is present", async () => {
		const calls: string[][] = [];
		const mux: MuxDeps = {
			which: () => "/usr/bin/ffmpeg",
			spawn: async (argv) => {
				calls.push(argv);
				writeFileSync(argv.at(-1) as string, "cut");
				return 0;
			},
		};
		await runPlayer(job(), { launch: late, mux, fetch: releaseFetch() });
		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain("6.500");
		const saved = result();
		expect(saved.startOffsetMs).toBe(6500);
		expect(saved.trimmed).toBe(true);
		expect(readFileSync(saved.video as string, "utf8")).toBe("cut");
		expect(readdirSync(dir).filter((n) => n.startsWith(".dg-mux-"))).toEqual([]);
	});

	test("keeps the full video and prints the trim line when ffmpeg is absent", async () => {
		const mux: MuxDeps = { which: () => null, spawn: async () => 0 };
		await runPlayer(job(), { launch: late, mux, fetch: releaseFetch() });
		const saved = result();
		expect(saved.startOffsetMs).toBe(6500);
		expect(saved.trimmed).toBe(false);
		expect(readFileSync(saved.video as string, "utf8")).toBe("webm");
		expect(lines.filter((l) => l.includes("start screen"))).toHaveLength(1);
	});
});
