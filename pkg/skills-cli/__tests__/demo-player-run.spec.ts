import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TourScript } from "@dg/common";
import { SETUP_NEEDS_PERSON, SetupRefusedError } from "../src/demo/player-job";
import type { PlayerJob } from "../src/demo/player-job";
import { runPlayer } from "../src/demo/player-process";
import type { DemoResult } from "../src/demo/result";
import { fakeBrowser, fakeEncode } from "./demo-run-fakes";
import { isolatedHome, releaseFetch } from "./demo-run-fixtures";

const START = "https://example.test/";

let dir: string;
let log: ReturnType<typeof spyOn>;
let error: ReturnType<typeof spyOn>;
let home: ReturnType<typeof isolatedHome>;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dg-player-run-"));
	home = isolatedHome();
	log = spyOn(console, "log").mockImplementation(() => undefined);
	error = spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
	log.mockRestore();
	error.mockRestore();
	home.restore();
	delete process.env.DEMO_PW;
	rmSync(dir, { recursive: true, force: true });
	rmSync(home.dir, { recursive: true, force: true });
});

const script = (over: Partial<TourScript> = {}): TourScript => ({
	startUrl: START,
	steps: [
		{ title: "One", body: "first", advance: 0 },
		{ title: "Two", body: "second", advance: 0 },
	],
	...over,
});

const job = (over: Partial<PlayerJob> = {}): PlayerJob => ({
	slug: "run-tour",
	planPath: join(dir, "run-tour.demo.md"),
	dir,
	startUrl: START,
	script: script(),
	...over,
});

const result = (): DemoResult => JSON.parse(readFileSync(join(dir, "run-tour.result.json"), "utf8"));
const logged = (): string => log.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n");

describe("runPlayer recording", () => {
	test("encodes the recording to a private MP4 and removes the raw files", async () => {
		const browser = fakeBrowser({ dir });
		const encode = fakeEncode();
		expect(await runPlayer(job(), { launch: browser.launch, encode: encode.deps })).toBe(0);
		const saved = result();
		expect(saved).toMatchObject({ outcome: "done", mode: "video", encoded: true, audio: "none", steps: 2 });
		expect(saved.video).toMatch(/run-tour-\d{8}-\d{4}\.mp4$/);
		expect(statSync(saved.video as string).mode & 0o777).toBe(0o600);
		expect(existsSync(join(dir, "rec"))).toBe(false);
		expect(browser.opens).toEqual([{ record: true, state: undefined }]);
	});

	test("writes to --out and leaves its mode alone", async () => {
		const out = join(dir, "nested", "mine.mp4");
		const code = await runPlayer(job({ out }), {
			launch: fakeBrowser({ dir }).launch,
			encode: fakeEncode().deps,
		});
		expect(code).toBe(0);
		expect(result().video).toBe(out);
		expect(readFileSync(out, "utf8")).toBe("mp4");
	});

	test("two runs in one minute keep both videos", async () => {
		const run = async () => {
			await runPlayer(job(), { launch: fakeBrowser({ dir }).launch, encode: fakeEncode().deps });
			return result().video as string;
		};
		const first = await run();
		const second = await run();
		expect(second).not.toBe(first);
		expect(existsSync(first)).toBe(true);
	});

	test("keeps a private webm and says so when ffmpeg is missing", async () => {
		const code = await runPlayer(job(), {
			launch: fakeBrowser({ dir }).launch,
			encode: fakeEncode(false).deps,
		});
		expect(code).toBe(0);
		const saved = result();
		expect(saved).toMatchObject({ outcome: "done", encoded: false, audio: "none" });
		expect(saved.video).toMatch(/run-tour-\d{8}-\d{4}\.webm$/);
		expect(readFileSync(saved.video as string, "utf8")).toBe("webm");
		expect(statSync(saved.video as string).mode & 0o777).toBe(0o600);
		expect(logged()).toContain(
			"demo run-tour: ffmpeg not found; kept the raw webm. Install ffmpeg to get an MP4.",
		);
	});

	test("records the lead-in offset of the first caption", async () => {
		await runPlayer(job(), { launch: fakeBrowser({ dir }).launch, encode: fakeEncode().deps });
		expect(typeof result().startOffsetMs).toBe("number");
	});

	test("ends as an error when the browser wrote no video", async () => {
		const code = await runPlayer(job(), {
			launch: fakeBrowser({ dir, noVideo: true }).launch,
			encode: fakeEncode().deps,
		});
		expect(code).toBe(1);
		expect(result()).toMatchObject({ outcome: "error", encoded: false });
		expect(result().error).toContain("no video was written");
	});

	test("keeps the raw recording when the encoder fails", async () => {
		const encode = fakeEncode();
		const failing = {
			which: encode.deps.which,
			run: () => ({ status: 1, stdout: "", stderr: "bad input" }),
		};
		const code = await runPlayer(job(), { launch: fakeBrowser({ dir }).launch, encode: failing });
		expect(code).toBe(1);
		expect(result().error).toContain("could not save the video");
		expect(existsSync(join(dir, "rec"))).toBe(true);
	});

	test("creates the job dir when it does not exist yet", async () => {
		const nested = join(dir, "nested", "deeper");
		await runPlayer(job({ dir: nested }), {
			launch: async () => {
				throw new Error("x");
			},
		});
		expect(existsSync(join(nested, "run-tour.result.json"))).toBe(true);
	});
});

describe("runPlayer failures and stops", () => {
	test("names the step and selector when a target never appears", async () => {
		const browser = fakeBrowser({ dir, missing: ["#gone"] });
		const code = await runPlayer(
			job({ script: script({ steps: [{ body: "a", advance: 0 }, { body: "b", selector: "#gone" }] }) }),
			{ launch: browser.launch, encode: fakeEncode().deps },
		);
		expect(code).toBe(1);
		expect(result()).toMatchObject({ outcome: "error" });
		expect(result().error).toBe("step 2: selector #gone did not resolve in 15s");
		expect(browser.log.at(-1)).toBe("session closed");
	});

	test("a launch failure writes the result and prints the reason", async () => {
		const code = await runPlayer(job(), {
			launch: async () => {
				throw new Error("ProcessSingleton: the profile is already in use");
			},
		});
		expect(code).toBe(1);
		expect(result()).toMatchObject({ outcome: "error", encoded: false, audio: "none" });
		expect(logged()).toContain("the profile is already in use");
	});

	test("a setup refusal from the launcher exits 2", async () => {
		const code = await runPlayer(job(), {
			launch: async () => {
				throw new SetupRefusedError();
			},
		});
		expect(code).toBe(2);
		expect(result().error).toBe(SETUP_NEEDS_PERSON);
	});

	test("the timeout stops the run and closes the browser", async () => {
		const browser = fakeBrowser({ dir, hang: true });
		const code = await runPlayer(job({ timeoutMin: 0.001 }), {
			launch: browser.launch,
			encode: fakeEncode().deps,
		});
		expect(code).toBe(0);
		expect(result()).toMatchObject({ outcome: "stopped", encoded: false });
		expect(result().video).toBeUndefined();
		expect(browser.log).toContain("session closed");
	});

	test("closing the browser mid-run ends as stopped", async () => {
		const browser = fakeBrowser({ dir, hang: true });
		setTimeout(() => browser.closeBrowser(), 20);
		const code = await runPlayer(job(), { launch: browser.launch, encode: fakeEncode().deps });
		expect(code).toBe(0);
		expect(result().outcome).toBe("stopped");
	});
});

describe("runPlayer credentials", () => {
	const login = (value: string): TourScript =>
		script({
			steps: [{ title: "Password", body: "Type it.", selector: "#pass", action: { do: "fill", value }, advance: 0 }],
		});

	test("refuses an unset variable in a recorded step before opening a browser", async () => {
		delete process.env.DEMO_PW;
		const browser = fakeBrowser({ dir });
		const code = await runPlayer(job({ script: login("$DEMO_PW") }), { launch: browser.launch });
		expect(code).toBe(2);
		expect(error).toHaveBeenCalledWith("demo: set $DEMO_PW or move the login to ## Setup");
		expect(browser.opens).toEqual([]);
		expect(result()).toMatchObject({ outcome: "error", error: "demo: set $DEMO_PW or move the login to ## Setup" });
	});

	test("types the variable's value and writes it nowhere", async () => {
		process.env.DEMO_PW = "s3cret-pw-value";
		const browser = fakeBrowser({ dir });
		const code = await runPlayer(job({ script: login("$DEMO_PW") }), {
			launch: browser.launch,
			encode: fakeEncode().deps,
		});
		expect(code).toBe(0);
		expect(browser.locators.get("#pass")?.typed).toEqual(["s3cret-pw-value"]);
		const everything = [
			readFileSync(join(dir, "run-tour.result.json"), "utf8"),
			logged(),
			error.mock.calls.join(" "),
			readdirSync(dir).join(" "),
		].join("\n");
		expect(everything).not.toContain("s3cret-pw-value");
	});
});

describe("runPlayer setup", () => {
	const withSetup = (value: string): TourScript =>
		script({
			setup: {
				includeInTour: false,
				steps: [
					{ title: "Password", body: "Sign in.", selector: "#pass", action: { do: "fill", value } },
					{ title: "Home", body: "Landed.", selector: "#home" },
				],
			},
		});

	test("signs in on an unrecorded context, then records with its storage state", async () => {
		process.env.DEMO_PW = "pw";
		const browser = fakeBrowser({ dir });
		const code = await runPlayer(job({ script: withSetup("$DEMO_PW") }), {
			launch: browser.launch,
			encode: fakeEncode().deps,
		});
		expect(code).toBe(0);
		expect(browser.opens.map((call) => call.record)).toEqual([false, true]);
		expect(browser.opens[1]?.state).toEqual({ cookies: [{ name: "sid" }], origins: [] });
		expect(browser.log.indexOf("close setup")).toBeLessThan(browser.log.lastIndexOf("goto https://example.test/"));
		expect(browser.locators.get("#pass")?.typed).toEqual(["pw"]);
	});

	test("asks a person to type an unset variable and does not type it", async () => {
		delete process.env.DEMO_PW;
		const browser = fakeBrowser({ dir, visible: { "#home": false } });
		const code = await runPlayer(job({ script: withSetup("$DEMO_PW") }), {
			launch: browser.launch,
			encode: fakeEncode().deps,
		});
		expect(code).toBe(0);
		const field = browser.locators.get("#pass");
		expect(field?.focused).toBe(1);
		expect(field?.typed).toEqual([]);
		expect(JSON.stringify(browser.evaluated)).toContain("Type it here, then continue.");
		expect(result().outcome).toBe("done");
	});
});

describe("runPlayer narration", () => {
	const clip = { sampleRate: 24_000, pcm: new Float32Array(2_400) };
	const narrated = () => job({ narration: true });

	test("muxes the voice into the MP4 and removes the WAV", async () => {
		const encode = fakeEncode();
		let spoken: string[] = [];
		const code = await runPlayer(narrated(), {
			launch: fakeBrowser({ dir }).launch,
			encode: encode.deps,
			fetch: releaseFetch(),
			synthesize: async (_context, texts) => {
				spoken = texts;
				return texts.map(() => clip);
			},
		});
		expect(code).toBe(0);
		expect(spoken).toEqual(["first", "second"]);
		expect(result()).toMatchObject({ encoded: true, audio: "muxed" });
		const ffmpeg = encode.commands.find((cmd) => cmd[0]?.endsWith("ffmpeg")) ?? [];
		expect(ffmpeg).toContain(join(dir, "voice.wav"));
		expect(existsSync(join(dir, "voice.wav"))).toBe(false);
	});

	test("keeps a sidecar WAV beside the webm when ffmpeg is missing", async () => {
		await runPlayer(narrated(), {
			launch: fakeBrowser({ dir }).launch,
			encode: fakeEncode(false).deps,
			fetch: releaseFetch(),
			synthesize: async (_context, texts) => texts.map(() => clip),
		});
		const saved = result();
		expect(saved).toMatchObject({ encoded: false, audio: "sidecar" });
		expect(existsSync((saved.video as string).replace(/\.webm$/, ".wav"))).toBe(true);
	});

	test("records captions only and prints one line when the assets cannot download", async () => {
		const offline = (async () => {
			throw new TypeError("fetch failed");
		}) as unknown as typeof fetch;
		const code = await runPlayer(narrated(), {
			launch: fakeBrowser({ dir }).launch,
			encode: fakeEncode().deps,
			fetch: offline,
		});
		expect(code).toBe(0);
		expect(logged()).toContain("narration assets are not downloaded; running captions-only");
		expect(result()).toMatchObject({ outcome: "done", audio: "none" });
	});

	test("records captions only when the voice engine fails", async () => {
		const code = await runPlayer(narrated(), {
			launch: fakeBrowser({ dir }).launch,
			encode: fakeEncode().deps,
			fetch: releaseFetch(),
			synthesize: async () => {
				throw new Error("wasm crashed");
			},
		});
		expect(code).toBe(0);
		expect(logged()).toContain("narration failed (wasm crashed); recorded without voice");
		expect(result().audio).toBe("none");
	});

	test("does not fetch assets without --narration", async () => {
		let fetched = 0;
		await runPlayer(job(), {
			launch: fakeBrowser({ dir }).launch,
			encode: fakeEncode().deps,
			fetch: (async () => void fetched++) as unknown as typeof fetch,
		});
		expect(fetched).toBe(0);
	});
});
