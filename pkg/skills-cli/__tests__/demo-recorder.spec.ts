import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TourScript } from "@dg/common";
import { chromium, type Page } from "playwright-core";
import { contextOptions } from "../src/demo/player-process";
import type { PlayerJob } from "../src/demo/player-job";
import { MissingEnvError } from "@dg/common";
import { introChapter, playbackSteps, recordTour, StepError } from "../src/demo/recorder/drive";
import { arrowSide, captionOnTop, OVERLAY_IDS } from "../src/demo/recorder/overlays";
import { findInstalledChromium } from "../src/utils/find-browser";

setDefaultTimeout(90_000);

const VIEW = { width: 1440, height: 810 };

describe("arrowSide", () => {
	test("points from the left when there is room", () => {
		expect(arrowSide({ x: 600, y: 300, width: 100, height: 40 }, VIEW)).toBe("left");
	});

	test("points from the right for a target at the left edge", () => {
		expect(arrowSide({ x: 10, y: 300, width: 100, height: 40 }, VIEW)).toBe("right");
	});

	test("points from above for a full-width target", () => {
		expect(arrowSide({ x: 0, y: 400, width: 1440, height: 40 }, VIEW)).toBe("top");
	});

	test("points from below for a full-width target at the top", () => {
		expect(arrowSide({ x: 0, y: 0, width: 1440, height: 40 }, VIEW)).toBe("bottom");
	});
});

describe("captionOnTop", () => {
	test("keeps the caption at the bottom with no target", () => {
		expect(captionOnTop(null, VIEW)).toBe(false);
	});

	test("moves the caption up for a target near the bottom", () => {
		expect(captionOnTop({ x: 0, y: 700, width: 100, height: 40 }, VIEW)).toBe(true);
		expect(captionOnTop({ x: 0, y: 100, width: 100, height: 40 }, VIEW)).toBe(false);
	});
});

describe("introChapter and playbackSteps", () => {
	const base: TourScript = { startUrl: "https://app.example", steps: [{ body: "a" }] };

	test("defaults the intro to the plan title", () => {
		expect(introChapter({ ...base, title: "Dash" })).toEqual({ eyebrow: "Demo", title: "Dash", detail: "" });
		expect(introChapter(base)).toBeUndefined();
	});

	test("marks included setup steps for the setup accent", () => {
		const script: TourScript = { ...base, setup: { includeInTour: true, steps: [{ body: "s" }] } };
		expect(playbackSteps(script).map((s) => s.setup)).toEqual([true, false]);
		expect(playbackSteps({ ...script, setup: { includeInTour: false, steps: [{ body: "s" }] } })).toHaveLength(1);
	});
});

const browser = process.env.PW_E2E === "1" ? findInstalledChromium() : null;

const STRICT = { "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'" };

function fixture() {
	const received: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/login" && req.method === "POST") {
				received.push(String((await req.formData()).get("password")));
				return new Response(null, { status: 303, headers: { Location: "/home" } });
			}
			const html =
				url.pathname === "/home"
					? '<!doctype html><title>Home</title><h1 id="welcome">Welcome</h1><div style="height:560px"></div><button id="low">Low</button>'
					: '<!doctype html><title>Sign in</title><form method="post" action="/login"><label>Username <input id="user" name="user"></label><label>Password <input id="pass" name="password" type="password"></label><button id="go" type="submit">Sign in</button></form>';
			return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", ...STRICT } });
		},
	});
	return { server, received, url: `http://127.0.0.1:${server.port}` };
}

type Snapshot = { caption: boolean; focus: boolean; arrow: boolean; rec: boolean; shadow: boolean };

const snapshot = (page: Page): Promise<Snapshot> =>
	page.evaluate((ids) => {
		const text = document.documentElement.innerText;
		return {
			caption: Boolean(document.getElementById(ids.caption)),
			focus: Boolean(document.getElementById(ids.focus)),
			arrow: Boolean(document.getElementById(ids.arrow)),
			rec: /\bREC\b/.test(text),
			shadow: [...document.querySelectorAll("*")].some((el) => el.shadowRoot),
		};
	}, OVERLAY_IDS);

describe("recordTour in a real browser", () => {
	test.skipIf(!browser)(
		"records a strict-CSP login with captions, outline and arrow, and no REC element",
		async () => {
			const site = fixture();
			const dir = mkdtempSync(join(tmpdir(), "dg-recorder-"));
			const launched = await chromium.launch({ executablePath: browser as string, args: ["--no-sandbox"] });
			try {
				const job = { dir } as PlayerJob;
				const context = await launched.newContext({ viewport: VIEW, ...contextOptions(job, true) });
				const page = await context.newPage();
				const seen: Snapshot[] = [];
				const script: TourScript = {
					title: "Sign in",
					startUrl: `${site.url}/`,
					intro: { eyebrow: "Getting started", title: "Sign in", detail: "Real login" },
					outro: { eyebrow: "Wrap-up", title: "Done", detail: "Bye" },
					steps: [
						{ selector: "#user", title: "Username", body: "Type your username.", action: { do: "fill", value: "dante" } },
						{ selector: "#pass", title: "Password", body: "Type your password.", action: { do: "fill", value: "$DEMO_PW" } },
						{ selector: "#go", title: "Sign in", body: "Sign in.", action: { do: "click" } },
						{ selector: "#low", title: "Low button", body: "Near the bottom." },
					],
				};
				const result = await recordTour(page, script, {
					env: { DEMO_PW: "s3cret-pw" },
					overlays: true,
					hold: () => 50,
					chapterMs: 50,
					leadMs: 10,
					typeDelayMs: 5,
					pause: async (ms) => {
						if (await page.locator(`#${OVERLAY_IDS.caption}`).count()) seen.push(await snapshot(page));
						await new Promise((r) => setTimeout(r, ms));
					},
				});
				await context.close();

				expect(result.steps).toBe(4);
				expect(result.offsets).toHaveLength(4);
				expect(site.received).toEqual(["s3cret-pw"]);
				expect(seen.length).toBeGreaterThan(0);
				expect(seen.some((s) => s.caption && s.focus && s.arrow)).toBe(true);
				expect(seen.every((s) => !s.rec && !s.shadow)).toBe(true);
				expect(readdirSync(join(dir, "rec")).some((f) => f.endsWith(".webm"))).toBe(true);
			} finally {
				await launched.close();
				site.server.stop(true);
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);

	test.skipIf(!browser)("names the step and selector when a target never appears", async () => {
		const site = fixture();
		const launched = await chromium.launch({ executablePath: browser as string, args: ["--no-sandbox"] });
		try {
			const page = await (await launched.newContext({ viewport: VIEW })).newPage();
			const error = await recordTour(
				page,
				{ startUrl: `${site.url}/`, steps: [{ body: "a" }, { selector: "#missing", body: "b" }] },
				{ env: {}, overlays: false, hold: () => 0, selectorTimeoutMs: 300 },
			).catch((e: unknown) => e);
			expect(error).toBeInstanceOf(StepError);
			expect((error as Error).message).toBe("step 2: selector #missing did not resolve in 0.3s");
		} finally {
			await launched.close();
			site.server.stop(true);
		}
	});

	test.skipIf(!browser)("throws MissingEnvError for an unset variable, or hands the field to onMissingEnv", async () => {
		const site = fixture();
		const launched = await chromium.launch({ executablePath: browser as string, args: ["--no-sandbox"] });
		try {
			const page = await (await launched.newContext({ viewport: VIEW })).newPage();
			const script: TourScript = {
				startUrl: `${site.url}/`,
				steps: [
					{ selector: "#pass", body: "Type it.", action: { do: "fill", value: "$DEMO_PW" } },
					{ selector: "#go", body: "Go.", action: { do: "click" } },
				],
			};
			const base = { env: {}, overlays: false, hold: () => 0, selectorTimeoutMs: 2000 };
			const error = await recordTour(page, script, base).catch((e: unknown) => e);
			expect(error).toBeInstanceOf(MissingEnvError);
			expect((error as MissingEnvError).variable).toBe("DEMO_PW");
			expect(site.received).toEqual([]);

			const asked: number[] = [];
			await recordTour(page, script, {
				...base,
				onMissingEnv: async ({ target, index }) => {
					asked.push(index);
					await target.fill("typed-by-person");
				},
			});
			expect(asked).toEqual([0]);
			expect(site.received).toEqual(["typed-by-person"]);
		} finally {
			await launched.close();
			site.server.stop(true);
		}
	});
});

describe("recordTour typing failures", () => {
	test("reports a failed fill without the typed text", async () => {
		const target = {
			waitFor: async () => undefined,
			scrollIntoViewIfNeeded: async () => undefined,
			boundingBox: async () => null,
			click: async () => undefined,
			pressSequentially: async (text: string) => {
				throw new Error(`call log: typing "${text}" failed`);
			},
		};
		const page = {
			viewportSize: () => VIEW,
			goto: async () => null,
			locator: () => ({ first: () => target }),
		} as unknown as Page;
		const error = await recordTour(
			page,
			{ startUrl: "https://app.example/", steps: [{ selector: "#pw", body: "b", action: { do: "fill", value: "$PW" } }] },
			{ env: { PW: "s3cret-pw" }, overlays: false, hold: () => 0 },
		).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(StepError);
		expect((error as Error).message).toBe("step 1: could not type into #pw");
		expect(String((error as Error).stack)).not.toContain("s3cret-pw");
	});
});
