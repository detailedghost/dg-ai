import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { muxVideo } from "../src/demo/mux";

let dir: string;
let video: string;
let wav: string;
let out: string;
let lines: string[];
let log: ReturnType<typeof spyOn>;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dg-mux-"));
	video = join(dir, "raw.webm");
	wav = join(dir, "voice.wav");
	out = join(dir, "tour-20260101-0000.webm");
	writeFileSync(video, "video");
	writeFileSync(wav, "voice");
	lines = [];
	log = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		lines.push(args.join(" "));
	});
});
afterEach(() => {
	log.mockRestore();
	rmSync(dir, { recursive: true, force: true });
});

describe("muxVideo", () => {
	test("runs ffmpeg with copy video, opus audio, apad and -shortest and leaves the sidecar for the caller to remove", async () => {
		const calls: string[][] = [];
		const result = await muxVideo(
			{ video, wav, out },
			{
				which: () => "/usr/bin/ffmpeg",
				spawn: async (argv) => {
					calls.push(argv);
					writeFileSync(out, "muxed");
					return 0;
				},
			},
		);
		expect(calls).toEqual([
			[
				"/usr/bin/ffmpeg",
				"-y",
				"-nostdin",
				"-i",
				video,
				"-i",
				wav,
				"-c:v",
				"copy",
				"-c:a",
				"libopus",
				"-af",
				"apad",
				"-shortest",
				out,
			],
		]);
		expect(result.audio).toBe("muxed");
		expect(existsSync(wav)).toBe(true);
		expect(existsSync(out)).toBe(true);
	});

	test("keeps both files and names them when ffmpeg is absent", async () => {
		let spawned = false;
		const result = await muxVideo(
			{ video, wav, out },
			{
				which: () => null,
				spawn: async () => {
					spawned = true;
					return 0;
				},
			},
		);
		expect(spawned).toBe(false);
		expect(result.audio).toBe("sidecar");
		expect(existsSync(video)).toBe(true);
		expect(existsSync(wav)).toBe(true);
		expect(lines).toContain(
			`ffmpeg not found: video and voice saved separately (${video}, ${wav})`,
		);
	});

	test("keeps the sidecar when ffmpeg exits non-zero", async () => {
		const result = await muxVideo(
			{ video, wav, out },
			{ which: () => "/usr/bin/ffmpeg", spawn: async () => 1 },
		);
		expect(result.audio).toBe("sidecar");
		expect(existsSync(wav)).toBe(true);
		expect(existsSync(video)).toBe(true);
	});
});

describe("muxVideo failure cleanup", () => {
	test("removes a partial output and keeps video and voice when ffmpeg fails after writing", async () => {
		const result = await muxVideo(
			{ video, wav, out },
			{
				which: () => "/usr/bin/ffmpeg",
				spawn: async () => {
					writeFileSync(out, "partial");
					return 1;
				},
			},
		);
		expect(result.audio).toBe("sidecar");
		expect(existsSync(out)).toBe(false);
		expect(existsSync(video)).toBe(true);
		expect(existsSync(wav)).toBe(true);
		expect(lines.at(-1)).toBe(
			`ffmpeg failed (exit 1): video and voice saved separately (${video}, ${wav})`,
		);
	});

	test("passes the explicit out path as the final ffmpeg argument even when a stale file exists", async () => {
		writeFileSync(out, "stale");
		let last: string | undefined;
		await muxVideo(
			{ video, wav, out },
			{
				which: () => "/usr/bin/ffmpeg",
				spawn: async (argv) => {
					last = argv.at(-1);
					writeFileSync(out, "fresh");
					return 0;
				},
			},
		);
		expect(last).toBe(out);
	});
});
