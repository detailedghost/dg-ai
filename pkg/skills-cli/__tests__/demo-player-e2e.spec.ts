import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TourScript } from "@dg/common";
import { chromium } from "playwright-core";
import type { PlayerJob } from "../src/demo/player-job";
import { type PlayerSession, runPlayer } from "../src/demo/player-process";
import type { DemoResult } from "../src/demo/result";
import { OVERLAY_IDS } from "../src/demo/recorder/overlays";
import { findInstalledChromium } from "../src/utils/find-browser";

setDefaultTimeout(180_000);

const executablePath = process.env.PW_E2E === "1" ? findInstalledChromium() : null;

describe("runPlayer against a local login", () => {
	let dir: string;
	let server: ReturnType<typeof Bun.serve>;
	const received: string[] = [];

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "dg-player-e2e-"));
		server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(req) {
				const url = new URL(req.url);
				if (url.pathname === "/login" && req.method === "POST") {
					received.push(String((await req.formData()).get("password")));
					return new Response(null, {
						status: 303,
						headers: { Location: "/home", "Set-Cookie": "sid=1; Path=/" },
					});
				}
				const signedIn = req.headers.get("cookie")?.includes("sid=1");
				const html =
					url.pathname === "/home"
						? '<!doctype html><title>Home</title><h1 id="welcome">Welcome</h1>'
						: signedIn
							? '<!doctype html><title>Start</title><h1 id="start">Signed in</h1>'
							: '<!doctype html><title>Sign in</title><form method="post" action="/login"><input id="pass" name="password" type="password"><button id="go" type="submit">Sign in</button></form>';
				return new Response(html, { headers: { "Content-Type": "text/html" } });
			},
		});
	});
	afterAll(() => {
		server.stop(true);
		rmSync(dir, { recursive: true, force: true });
	});

	const sessionOf = (): { session: PlayerSession; browser: Promise<import("playwright-core").Browser> } => {
		const browser = chromium.launch({ executablePath: executablePath as string, args: ["--no-sandbox"] });
		const session: PlayerSession = {
			open: async (record, state) => {
				const launched = await browser;
				return launched.newContext({
					viewport: { width: 1440, height: 810 },
					...(state ? { storageState: state } : {}),
					...(record ? { recordVideo: { dir: join(dir, "rec"), size: { width: 1440, height: 810 } } } : {}),
				});
			},
			close: async () => void (await (await browser).close()),
		};
		return { session, browser };
	};

	const job = (script: TourScript): PlayerJob => ({
		slug: "e2e-tour",
		planPath: join(dir, "e2e-tour.demo.md"),
		dir,
		startUrl: script.startUrl,
		script,
		timeoutMin: 2,
	});

	test.skipIf(!executablePath)(
		"waits for a person to type an unset password in setup, then records the signed-in tour",
		async () => {
			delete process.env.DEMO_E2E_PW;
			const base = `http://127.0.0.1:${server.port}`;
			const script: TourScript = {
				title: "E2E Tour",
				startUrl: `${base}/`,
				setup: {
					includeInTour: false,
					steps: [
						{ title: "Password", body: "Sign in.", selector: "#pass", action: { do: "fill", value: "$DEMO_E2E_PW" } },
						{ title: "Signed in", body: "Home.", selector: "#welcome" },
					],
				},
				steps: [{ title: "Start", body: "You are signed in.", selector: "#start", advance: 300 }],
			};
			const { session, browser } = sessionOf();
			let prompted = false;
			const person = setInterval(async () => {
				const contexts = (await browser).contexts();
				for (const context of contexts)
					for (const page of context.pages()) {
						const caption = await page
							.locator(`#${OVERLAY_IDS.caption}`)
							.innerText({ timeout: 200 })
							.catch(() => "");
						if (!caption.includes("Type it here, then continue.") || prompted) continue;
						prompted = true;
						await page.fill("#pass", "typed-by-person").catch(() => undefined);
						await page.click("#go").catch(() => undefined);
					}
			}, 300);
			try {
				const code = await runPlayer(job(script), { launch: async () => session });
				expect(code).toBe(0);
			} finally {
				clearInterval(person);
			}
			expect(prompted).toBe(true);
			expect(received).toContain("typed-by-person");
			const result = JSON.parse(readFileSync(join(dir, "e2e-tour.result.json"), "utf8")) as DemoResult;
			expect(result).toMatchObject({ outcome: "done", mode: "video" });
			expect(result.video).toMatch(/\.(mp4|webm)$/);
			expect(existsSync(result.video as string)).toBe(true);
			expect(JSON.stringify(result)).not.toContain("typed-by-person");
			expect(readdirSync(dir).some((name) => name === "rec")).toBe(false);
		},
	);
});
