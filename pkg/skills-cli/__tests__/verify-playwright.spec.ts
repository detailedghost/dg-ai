import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { pngSize } from "../src/verify/capture-model";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { readVerdicts, verifyPaths, writeBoard } from "../src/verify/board";
import { openPlaywrightCapturer, resolveVerifyBrowser, verifyBrowserAvailable } from "../src/verify/playwright-capturer";
import { startVerifyServer } from "../src/verify/serve";

setDefaultTimeout(60_000);

const browser = verifyBrowserAvailable();

describe("playwright capture", () => {
	test.skipIf(!browser)("screenshots the fixture at mobile width when a CDP Chromium is present", async () => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch() {
				return new Response(
					`<!doctype html><html lang="en" data-theme="light" data-scrolled="false"><head><title>After</title></head><body><h1>After home</h1><button type="button" data-verify-menu aria-expanded="false">Open menu</button><div style="height:2400px">spacer</div></body></html>`,
					{ headers: { "Content-Type": "text/html; charset=utf-8" } },
				);
			},
		});
		const capturer = await openPlaywrightCapturer({ noSandbox: true });
		try {
			const shot = await capturer.shot({
				url: `http://127.0.0.1:${server.port}/`,
				headers: { "x-seed-role": "admin" },
				cookies: [],
				width: 390,
				height: 844,
				theme: "light",
				state: "default",
				menuSelector: "[data-verify-menu]",
			});
			expect(shot.engine).toBe("playwright");
			expect(pngSize(shot.png)).toEqual({ width: 390, height: 844 });
			expect(shot.html).toContain("After home");
		} finally {
			await capturer.close();
			server.stop(true);
		}
	});
});

describe("review board in a browser", () => {
	test.skipIf(!browser)("an approve click saves the verdict through the CSP and the same-origin check", async () => {
		const dir = mkdtempSync(join(tmpdir(), "dg-verify-board-click-"));
		const paths = verifyPaths(dir);
		writeBoard(paths, {
			name: "click",
			sections: [{ id: "home-r1", title: "Home", images: [{ label: "desktop · home", before: "missing", after: "missing" }] }],
			pending: [],
		});
		const server = await startVerifyServer({ name: "click", paths, port: 0 });
		const pw = await chromium.launch({ executablePath: resolveVerifyBrowser(), args: ["--no-sandbox"] });
		try {
			const page = await pw.newPage();
			const errors: string[] = [];
			page.on("pageerror", (error) => errors.push(String(error)));
			await page.goto(`http://127.0.0.1:${server.port}/#home-r1`);
			await page.waitForSelector("#approve svg");
			await page.click("#approve");
			await page.waitForFunction(() => location.hash === "#overview");
			expect(readVerdicts(paths)["home-r1"]).toMatchObject({ status: "approved", note: "" });
			expect(errors).toEqual([]);
		} finally {
			await pw.close();
			server.stop();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test.skipIf(!browser)("a version round switches by key, filters by theme, refreshes live, and saves the pick", async () => {
		const dir = mkdtempSync(join(tmpdir(), "dg-verify-board-variant-"));
		const paths = verifyPaths(dir);
		const image = (label: string) => ({ label, before: "missing", after: "missing" });
		const board = {
			name: "pick",
			sections: [
				{
					id: "nav-r1",
					title: "Nav",
					images: [],
					variants: [
						{ key: "A", label: "Tabs", images: [image("desktop · light · tabs")] },
						{ key: "B", label: "Rail", images: [image("desktop · light · rail")] },
					],
				},
			],
			pending: [],
		};
		writeBoard(paths, board);
		const server = await startVerifyServer({ name: "pick", paths, port: 0 });
		const pw = await chromium.launch({ executablePath: resolveVerifyBrowser(), args: ["--no-sandbox"] });
		try {
			const page = await pw.newPage();
			const errors: string[] = [];
			page.on("pageerror", (error) => errors.push(String(error)));
			await page.addInitScript(() => localStorage.setItem("verify-mode", "light"));
			await page.goto(`http://127.0.0.1:${server.port}/#nav-r1`);
			await page.waitForSelector("#approve svg");
			expect(await page.textContent("#v-label")).toBe("A · Tabs");
			expect(await page.isHidden("#prev")).toBe(true);
			await page.keyboard.press("2");
			expect(await page.textContent("#v-label")).toBe("B · Rail");
			expect(await page.evaluate(() => location.hash)).toBe("#nav-r1:B");
			expect(await page.textContent("#shots h3")).toBe("desktop · light · rail");
			await page.click("#shot-mode");
			expect(await page.textContent("#shots")).toContain("No dark screenshots for this round");
			await page.click("#mode");
			writeBoard(paths, { ...board, sections: [{ ...board.sections[0], title: "Nav bar" }] });
			await page.waitForFunction(() => document.getElementById("sec-title")?.textContent === "Nav bar", undefined, {
				timeout: 15_000,
			});
			expect(await page.textContent("#v-label")).toBe("B · Rail");
			await page.click("#approve");
			await page.waitForFunction(() => location.hash === "#overview");
			expect(readVerdicts(paths)["nav-r1"]).toMatchObject({ status: "approved", note: "", variant: "B" });
			expect(errors).toEqual([]);
		} finally {
			await pw.close();
			server.stop();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
