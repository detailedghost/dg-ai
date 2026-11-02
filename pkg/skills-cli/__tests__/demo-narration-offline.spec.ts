import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlayerJob } from "../src/demo/player-job";
import { runPlayer } from "../src/demo/player-process";
import type { DemoResult } from "../src/demo/result";

const START = "https://example.test/";
const OFFLINE_LINE =
	"narration assets are not downloaded; running captions-only";

let dir: string;
let lines: string[];
let log: ReturnType<typeof spyOn>;
const previous = { HOME: process.env.HOME, DG_HOME: process.env.DG_HOME };

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dg-narration-offline-"));
	process.env.HOME = dir;
	process.env.DG_HOME = join(dir, "state");
	mkdirSync(process.env.DG_HOME, { recursive: true });
	lines = [];
	log = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		lines.push(args.join(" "));
	});
});
afterEach(() => {
	log.mockRestore();
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(dir, { recursive: true, force: true });
});

const job = (): PlayerJob & { narration: "both" } => ({
	slug: "narrated",
	planPath: join(dir, "narrated.demo.md"),
	dir,
	video: true,
	narration: "both",
	startUrl: START,
	script: {
		title: "Narrated",
		startUrl: START,
		steps: [{ title: "One", body: "hello" }],
	},
});

function launch() {
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
		goto: async () => {
			const send = (msg: unknown) => binding?.({ frame: main, page }, msg);
			await send({ kind: "choice", mode: "video", narration: "both", voice: "af_heart" });
			await send({ kind: "progress", index: 0 });
			await send({ kind: "done" });
		},
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

describe("runPlayer with a both narration choice and no cached assets", () => {
	test("prints the captions-only line, finishes, and reports audio none", async () => {
		const offline = (async () => {
			throw new TypeError("fetch failed");
		}) as unknown as typeof fetch;
		const code = await runPlayer(job(), { launch: launch(), fetch: offline });
		expect(code).toBe(0);
		expect(lines).toContain(OFFLINE_LINE);
		const result = JSON.parse(
			readFileSync(join(dir, "narrated.result.json"), "utf8"),
		) as DemoResult & { audio: string };
		expect(result.outcome).toBe("done");
		expect(result.audio).toBe("none");
		expect(readdirSync(dir).filter((name) => name.endsWith(".wav"))).toEqual([]);
	});
});
