import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PlayerJob, SETUP_NEEDS_PERSON, SetupRefusedError } from "../src/demo/player-job";
import { type PlayerSession, runPlayer } from "../src/demo/player-process";
import type { DemoResult } from "../src/demo/result";

type Handler = (source: unknown, msg: unknown) => Promise<unknown>;

type FakeOptions = {
	onGoto?(
		send: (msg: unknown, frameUrl?: string) => Promise<unknown>,
		context: EventEmitter,
	): void | Promise<void>;
	gotoError?: Error;
	videoFile?: string;
};

const START_URL = "https://example.test/";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dg-run-outcomes-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fakeSession(options: FakeOptions = {}) {
	const context = new EventEmitter() as EventEmitter & {
		pages(): unknown[];
		newPage(): Promise<unknown>;
		close(): Promise<void>;
	};
	let handler: Handler | undefined;
	const closed: string[] = [];
	const pageClosed: Array<() => void> = [];
	const mainFrame = { url: () => START_URL };
	const page = {
		mainFrame: () => mainFrame,
		exposeBinding: async (_name: string, fn: Handler) => {
			handler = fn;
		},
		addInitScript: async () => undefined,
		route: async () => undefined,
		on: () => undefined,
		isClosed: () => false,
		once: (event: string, fn: () => void) => {
			if (event === "close") pageClosed.push(fn);
		},
		evaluate: async () => undefined,
		goto: async () => {
			if (options.gotoError) throw options.gotoError;
			await options.onGoto?.(
				(msg, frameUrl) =>
					(handler as Handler)(
						{ frame: frameUrl ? { url: () => frameUrl } : mainFrame, page },
						msg,
					),
				context,
			);
		},
		video: () =>
			options.videoFile ? { path: async () => options.videoFile as string } : null,
	};
	context.pages = () => [page];
	context.newPage = async () => page;
	context.close = async () => {
		closed.push("context");
		context.emit("close");
	};
	const session: PlayerSession = {
		context: context as never,
		close: async () => void closed.push("session"),
	};
	return { session, page, closed, closePage: () => pageClosed.forEach((fn) => fn()) };
}

const job = (over: Partial<PlayerJob> = {}): PlayerJob => ({
	slug: "run-tour",
	planPath: join(dir, "run-tour.demo.md"),
	dir,
	video: false,
	startUrl: START_URL,
	script: {
		title: "Run Tour",
		startUrl: START_URL,
		steps: [
			{ title: "One", body: "a" },
			{ title: "Two", body: "b" },
		],
	},
	...over,
});

const readResult = (): DemoResult =>
	JSON.parse(readFileSync(join(dir, "run-tour.result.json"), "utf8"));

describe("runPlayer outcome mapping", () => {
	test("closing the tour page ends the run as stopped", async () => {
		const fake = fakeSession({ onGoto: () => void setTimeout(() => fake.closePage(), 0) });
		const code = await runPlayer(job(), { launch: async () => fake.session });
		expect(code).toBe(0);
		expect(readResult().outcome).toBe("stopped");
	});

	test("done writes outcome done, the step count and returns 0", async () => {
		const fake = fakeSession({ onGoto: (send) => void send({ kind: "done" }) });
		const code = await runPlayer(job(), { launch: async () => fake.session });
		expect(code).toBe(0);
		const result = readResult();
		expect(result.outcome).toBe("done");
		expect(result.steps).toBe(2);
		expect(result.mode).toBe("walkthrough");
		expect(result.plan).toBe(job().planPath);
		expect(result.video).toBeUndefined();
		expect(fake.closed).toEqual(["context", "session"]);
	});

	test("stopped writes outcome stopped and returns 0", async () => {
		const fake = fakeSession({ onGoto: (send) => void send({ kind: "stopped" }) });
		const code = await runPlayer(job(), { launch: async () => fake.session });
		expect(code).toBe(0);
		expect(readResult().outcome).toBe("stopped");
	});

	test("a setup refusal from the launcher returns its exit code 2", async () => {
		const code = await runPlayer(job(), {
			launch: async () => {
				throw new SetupRefusedError();
			},
		});
		expect(code).toBe(2);
		const result = readResult();
		expect(result.outcome).toBe("error");
		expect(result.error).toBe(SETUP_NEEDS_PERSON);
	});

	test("an error message from the page writes outcome error and returns 1", async () => {
		const fake = fakeSession({
			onGoto: (send) => void send({ kind: "error", message: "page blew up" }),
		});
		const code = await runPlayer(job(), { launch: async () => fake.session });
		expect(code).toBe(1);
		expect(readResult()).toMatchObject({ outcome: "error", error: "page blew up" });
	});

	test("the context closing mid-run maps to stopped", async () => {
		const fake = fakeSession({
			onGoto: (_send, context) => void setTimeout(() => context.emit("close"), 20),
		});
		const code = await runPlayer(job(), { launch: async () => fake.session });
		expect(code).toBe(0);
		expect(readResult().outcome).toBe("stopped");
	});

	test("the --timeout expiring maps to stopped and closes the session", async () => {
		const fake = fakeSession();
		const code = await runPlayer(job({ timeoutMin: 0.0005 }), {
			launch: async () => fake.session,
		});
		expect(code).toBe(0);
		expect(readResult().outcome).toBe("stopped");
		expect(fake.closed).toEqual(["context", "session"]);
	});

	test("a choice message for video mode is reflected in the result mode", async () => {
		const fake = fakeSession({
			onGoto: async (send) => {
				await send({ kind: "choice", mode: "video", narration: "captions" });
				await send({ kind: "done" });
			},
		});
		await runPlayer(job(), { launch: async () => fake.session });
		expect(readResult().mode).toBe("video");
	});
});

describe("runPlayer bridge trust", () => {
	test("a message from a subframe is ignored", async () => {
		const fake = fakeSession({
			onGoto: (send) => void send({ kind: "done" }, "https://example.test/frame"),
		});
		await runPlayer(job({ timeoutMin: 0.0005 }), { launch: async () => fake.session });
		expect(readResult().outcome).toBe("stopped");
	});
});

describe("runPlayer failures", () => {
	test("a goto failure is written as an error result and the session closes", async () => {
		const fake = fakeSession({ gotoError: new Error("net::ERR_FAILED") });
		const code = await runPlayer(job(), { launch: async () => fake.session });
		expect(code).toBe(1);
		expect(readResult()).toMatchObject({ outcome: "error", error: "net::ERR_FAILED" });
		expect(fake.closed).toEqual(["context", "session"]);
	});

	test("a launch failure still writes the result", async () => {
		const code = await runPlayer(job(), {
			launch: async () => {
				throw new Error("no browser");
			},
		});
		expect(code).toBe(1);
		expect(readResult()).toMatchObject({ outcome: "error", error: "no browser" });
	});

	test("a launch failure such as a locked profile is also printed on stdout", async () => {
		const lines: string[] = [];
		const original = console.log;
		console.log = (...args: unknown[]) => void lines.push(args.join(" "));
		try {
			await runPlayer(job(), {
				launch: async () => {
					throw new Error("ProcessSingleton: the profile is already in use");
				},
			});
		} finally {
			console.log = original;
		}
		expect(lines.join("\n")).toContain("the profile is already in use");
	});

	test("the result file is written into a job dir that did not exist before", async () => {
		const nested = join(dir, "nested", "deeper");
		await runPlayer(job({ dir: nested }), {
			launch: async () => {
				throw new Error("x");
			},
		});
		expect(existsSync(join(nested, "run-tour.result.json"))).toBe(true);
	});
});

describe("runPlayer video handling", () => {
	function recorded() {
		const rec = join(dir, "rec");
		mkdirSync(rec, { recursive: true });
		const file = join(rec, "raw.webm");
		writeFileSync(file, "webm-bytes");
		return file;
	}

	test("moves the recording to a stamped webm and removes the rec dir", async () => {
		const fake = fakeSession({
			videoFile: recorded(),
			onGoto: (send) => void send({ kind: "done" }),
		});
		await runPlayer(job({ video: true }), { launch: async () => fake.session });
		const result = readResult();
		expect(result.mode).toBe("video");
		const names = readdirSync(dir);
		const webm = names.find((name) => /^run-tour-\d{8}-\d{4}\.webm$/.test(name));
		expect(webm).toBeDefined();
		expect(result.video).toBe(join(dir, webm as string));
		expect(readFileSync(result.video as string, "utf8")).toBe("webm-bytes");
		expect(names).not.toContain("rec");
	});

	test("job.out overrides the stamped name", async () => {
		const out = join(dir, "custom", "mine.webm");
		const fake = fakeSession({
			videoFile: recorded(),
			onGoto: (send) => void send({ kind: "done" }),
		});
		await runPlayer(job({ video: true, out }), { launch: async () => fake.session });
		expect(readResult().video).toBe(out);
		expect(readFileSync(out, "utf8")).toBe("webm-bytes");
	});
});

describe("runPlayer hooks.onProgress", () => {
	test("receives the live page and the step index from a progress message", async () => {
		const seen: Array<{ page: unknown; index: number }> = [];
		const fake = fakeSession({
			onGoto: async (send) => {
				await send({ kind: "progress", index: 1 });
				await send({ kind: "done" });
			},
		});
		await runPlayer(job(), {
			launch: async () => fake.session,
			onProgress: (page, index) => void seen.push({ page, index }),
		});
		expect(seen).toEqual([{ page: fake.page, index: 1 }]);
	});

	test("a progress message without a hook is harmless", async () => {
		const fake = fakeSession({
			onGoto: async (send) => {
				await send({ kind: "progress", index: 0 });
				await send({ kind: "done" });
			},
		});
		expect(await runPlayer(job(), { launch: async () => fake.session })).toBe(0);
	});
});
