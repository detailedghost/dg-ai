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
import type { MuxDeps } from "../src/demo/mux";
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
	dir = mkdtempSync(join(tmpdir(), "dg-narration-run-"));
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

const job = (over: Partial<PlayerJob> = {}): PlayerJob => ({
	slug: "narrated",
	planPath: join(dir, "narrated.demo.md"),
	dir,
	video: true,
	startUrl: START,
	script: {
		title: "Narrated",
		startUrl: START,
		steps: [{ title: "One", body: "hello" }],
	},
	...over,
});

const clip = (value: number, count: number): string =>
	Buffer.from(new Float32Array(count).fill(value).buffer).toString("base64");

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
		goto: async () =>
			onPlay(async (msg) => binding?.({ frame: main, page }, msg)),
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

const voiced = launch(async (send) => {
	await send({ kind: "choice", mode: "video", narration: "voice", voice: "af_heart" });
	await send({ kind: "progress", index: 0 });
	await send({ kind: "clip", index: 0, sampleRate: 24000, pcm: clip(0.5, 2400) });
	await send({ kind: "done" });
});

const readResult = (): DemoResult =>
	JSON.parse(readFileSync(join(dir, "narrated.result.json"), "utf8"));
const names = (ext: string): string[] =>
	readdirSync(dir).filter((name) => name.endsWith(ext));

describe("runPlayer with narration clips", () => {
	test("without ffmpeg it keeps the webm and the wav and the final line names both", async () => {
		const mux: MuxDeps = { which: () => null, spawn: async () => 0 };
		await runPlayer(job(), { launch: voiced, mux, fetch: releaseFetch() });
		const [video] = names(".webm");
		const [wav] = names(".wav");
		expect(readResult().audio).toBe("sidecar");
		expect(readResult().video).toBe(join(dir, video as string));
		expect(lines.at(-1)).toBe(
			`ffmpeg not found: video and voice saved separately (${join(dir, video as string)}, ${join(dir, wav as string)})`,
		);
		expect(existsSync(join(dir, "clips"))).toBe(false);
	});

	test("with ffmpeg it muxes into the final webm and removes the sidecar", async () => {
		const calls: string[][] = [];
		const mux: MuxDeps = {
			which: () => "/usr/bin/ffmpeg",
			spawn: async (argv) => {
				calls.push(argv);
				writeFileSync(argv[argv.length - 1] as string, "muxed");
				return 0;
			},
		};
		await runPlayer(job(), { launch: voiced, mux, fetch: releaseFetch() });
		const [video] = names(".webm");
		expect(names(".webm")).toHaveLength(1);
		expect(names(".wav")).toEqual([]);
		expect(readFileSync(join(dir, video as string), "utf8")).toBe("muxed");
		expect(readResult().audio).toBe("muxed");
		expect(calls[0]?.[0]).toBe("/usr/bin/ffmpeg");
	});

	test("reports audio none for a video with no clips", async () => {
		const silent = launch(async (send) => {
			await send({ kind: "progress", index: 0 });
			await send({ kind: "done" });
		});
		await runPlayer(job(), { launch: silent, fetch: offlineOk() });
		expect(readResult().audio).toBe("none");
		expect(names(".wav")).toEqual([]);
	});

	test("omits audio for a walkthrough", async () => {
		const walk = launch(async (send) => {
			await send({ kind: "done" });
		});
		await runPlayer(job({ video: false }), { launch: walk, fetch: offlineOk() });
		expect(readResult().audio).toBeUndefined();
	});
});

function offlineOk(): typeof fetch {
	return (async () => {
		throw new TypeError("fetch failed");
	}) as unknown as typeof fetch;
}
