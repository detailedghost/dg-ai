import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { NARRATION_ASSET_BASE } from "@dg/common";
import { chromium } from "playwright-core";
import { contextOptions } from "../src/demo/player-process";
import type { PlayerJob } from "../src/demo/player-job";
import { resolveVerifyBrowser, verifyBrowserAvailable } from "../src/verify/playwright-capturer";

setDefaultTimeout(60_000);

const job = (video: boolean): PlayerJob => ({
	slug: "s",
	planPath: "/tmp/none",
	dir: "/tmp/none",
	video,
	startUrl: "https://example.test/",
	script: { title: "t", startUrl: "https://example.test/", steps: [] },
});

describe("contextOptions", () => {
	test.each([[true], [false]])("bypasses the page CSP with video %p", (video) => {
		expect(contextOptions(job(video), true)).toMatchObject({ bypassCSP: true });
		expect(contextOptions(job(video), false)).toMatchObject({ bypassCSP: true });
	});

	test("records video into the job dir only when asked", () => {
		expect(contextOptions(job(true), true)).toHaveProperty("recordVideo");
		expect(contextOptions(job(true), false)).not.toHaveProperty("recordVideo");
	});
});

const browser = process.env.PW_E2E === "1" && verifyBrowserAvailable();

describe("contextOptions in a real browser", () => {
	test.skipIf(!browser)("loads the narration script on a strict-CSP page", async () => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () =>
				new Response("<!doctype html><title>Sign in</title><h1>Sign in</h1>", {
					headers: {
						"Content-Type": "text/html; charset=utf-8",
						"Content-Security-Policy": "default-src 'self'; script-src 'self'",
					},
				}),
		});
		const launched = await chromium.launch({
			executablePath: resolveVerifyBrowser(),
			args: ["--no-sandbox"],
		});
		try {
			const context = await launched.newContext(contextOptions(job(false), false));
			await context.route(`${NARRATION_ASSET_BASE}**`, (route) =>
				route.fulfill({ contentType: "text/javascript", body: "window.__narration = true;" }),
			);
			const page = await context.newPage();
			await page.goto(`http://127.0.0.1:${server.port}/`);
			await page.addScriptTag({ url: `${NARRATION_ASSET_BASE}kokoro.js` });
			expect(await page.evaluate(() => (window as { __narration?: boolean }).__narration)).toBe(true);
		} finally {
			await launched.close();
			server.stop(true);
		}
	});
});
