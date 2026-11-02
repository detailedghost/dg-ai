import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlayerJob } from "../src/demo/player-job";
import { runPlayer } from "../src/demo/player-process";
import type { DemoResult } from "../src/demo/result";

type Send = (msg: unknown, trusted?: boolean) => Promise<unknown>;

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dg-player-run-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const START = "https://example.test/";

const job = (over: Partial<PlayerJob> = {}): PlayerJob => ({
	slug: "run-tour",
	planPath: join(dir, "run-tour.demo.md"),
	dir,
	video: false,
	startUrl: START,
	script: {
		title: "Run Tour",
		startUrl: START,
		steps: [{ title: "One", body: "b" }, { title: "Two", body: "b" }],
	},
	...over,
});

function launchWith(
	script: (send: Send) => Promise<void>,
	recorded = true,
	canRecord?: boolean,
	evaluated: string[] = [],
) {
	const main = { url: () => START };
	const foreign = { url: () => "https://evil.test/" };
	let binding: ((source: unknown, msg: unknown) => unknown) | undefined;
	let loaded: (() => void) | undefined;
	const page = {
		mainFrame: () => main,
		exposeBinding: async (_name: string, cb: typeof binding) => {
			binding = cb;
		},
		addInitScript: async () => undefined,
		route: async () => undefined,
		on: (event: string, cb: () => void) => {
			if (event === "domcontentloaded") loaded = cb;
		},
		evaluate: async (expression: string) => {
			evaluated.push(expression);
		},
		goto: async () => {
			loaded?.();
			await script((msg, trusted = true) =>
				Promise.resolve(
					binding?.({ frame: trusted ? main : foreign, page }, msg),
				),
			);
		},
		video: () =>
			recorded
				? {
						path: async () => {
							const file = join(dir, "rec", "raw.webm");
							mkdirSync(join(dir, "rec"), { recursive: true });
							writeFileSync(file, "webm");
							return file;
						},
					}
				: null,
	};
	return async () => ({
		context: {
			pages: () => [page],
			newPage: async () => page,
			once: () => undefined,
			close: async () => undefined,
		} as never,
		close: async () => undefined,
		...(canRecord === undefined ? {} : { canRecord }),
	});
}

const result = (): DemoResult =>
	JSON.parse(readFileSync(join(dir, "run-tour.result.json"), "utf8"));

describe("runPlayer", () => {
	test("a human choice of Record video on a walkthrough job keeps a private webm", async () => {
		const launch = launchWith(async (send) => {
			await send({ kind: "choice", mode: "video", narration: "captions", voice: "af_heart" });
			await send({ kind: "done" });
		});
		expect(await runPlayer(job(), { launch })).toBe(0);
		const saved = result();
		expect(saved.mode).toBe("video");
		expect(saved.video).toMatch(/run-tour-\d{8}-\d{4}\.webm$/);
		expect(saved.video?.startsWith(dir)).toBe(true);
		expect(statSync(saved.video as string).mode & 0o777).toBe(0o600);
		expect(existsSync(join(dir, "rec"))).toBe(false);
	});

	test("a walkthrough run drops the recording", async () => {
		const launch = launchWith(async (send) => {
			await send({ kind: "done" });
		});
		await runPlayer(job(), { launch });
		const saved = result();
		expect(saved.mode).toBe("walkthrough");
		expect(saved.video).toBeUndefined();
		expect(readdirSync(dir).some((name) => name.endsWith(".webm"))).toBe(false);
		expect(existsSync(join(dir, "rec"))).toBe(false);
	});

	test("a message from a foreign origin cannot end the run", async () => {
		const launch = launchWith(async (send) => {
			await send({ kind: "done" }, false);
			await send({ kind: "error", message: "forged" }, false);
			await send({ kind: "stopped" });
		});
		await runPlayer(job(), { launch });
		expect(result().outcome).toBe("stopped");
	});

	test("reports a failed video move as an error result and keeps the raw file", async () => {
		const blocker = join(dir, "blocker");
		writeFileSync(blocker, "");
		const launch = launchWith(async (send) => {
			await send({ kind: "done" });
		});
		const code = await runPlayer(
			job({ video: true, out: join(blocker, "out.webm") }),
			{ launch },
		);
		expect(code).toBe(1);
		const saved = result();
		expect(saved.outcome).toBe("error");
		expect(saved.error).toContain("could not save the video");
		expect(saved.video).toBeUndefined();
		expect(existsSync(join(dir, "rec", "raw.webm"))).toBe(true);
	});

	test("two runs in one minute keep both videos", async () => {
		const run = async () => {
			const launch = launchWith(async (send) => {
				await send({ kind: "done" });
			});
			await runPlayer(job({ video: true }), { launch });
			return result().video;
		};
		const first = await run();
		const second = await run();
		expect(second).not.toBe(first);
		expect(existsSync(first as string)).toBe(true);
	});

	test("a human choice of video with no recording written ends as an error", async () => {
		const launch = launchWith(async (send) => {
			await send({ kind: "choice", mode: "video", narration: "captions", voice: "af_heart" });
			await send({ kind: "done" });
		}, false);
		expect(await runPlayer(job(), { launch })).toBe(1);
		const saved = result();
		expect(saved.outcome).toBe("error");
		expect(saved.error).toContain("no video was written");
		expect(saved.video).toBeUndefined();
	});

	test("a --video job with no recording written ends as an error", async () => {
		const launch = launchWith(async (send) => {
			await send({ kind: "done" });
		}, false);
		expect(await runPlayer(job({ video: true }), { launch })).toBe(1);
		expect(result().outcome).toBe("error");
	});

	test("a walkthrough without a recording still ends done", async () => {
		const launch = launchWith(async (send) => {
			await send({ kind: "done" });
		}, false);
		expect(await runPlayer(job(), { launch })).toBe(0);
		expect(result().outcome).toBe("done");
	});

	test("tells the page not to offer video when the session cannot record", async () => {
		const evaluated: string[] = [];
		const launch = launchWith(
			async (send) => {
				await send({ kind: "done" });
			},
			false,
			false,
			evaluated,
		);
		await runPlayer(job(), { launch });
		expect(JSON.stringify(evaluated)).toContain("noVideo");
	});
});
