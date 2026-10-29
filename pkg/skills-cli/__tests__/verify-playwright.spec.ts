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

	test.skipIf(!browser)("the tab title, favicon, and desktop alert report waiting rounds, and more versions saves", async () => {
		const dir = mkdtempSync(join(tmpdir(), "dg-verify-board-tab-"));
		const paths = verifyPaths(dir);
		const image = (label: string) => ({ label, before: "missing", after: "missing" });
		const nav = {
			id: "nav-r1",
			title: "Nav",
			round: 1,
			images: [],
			variants: [
				{ key: "A", images: [image("desktop · light · a")] },
				{ key: "B", images: [image("desktop · light · b")] },
			],
		};
		const board = { name: "tab", title: "Settings polish", sections: [nav, { id: "home-r1", title: "Home", round: 1, images: [image("desktop · light · home")] }], pending: [] };
		writeBoard(paths, board);
		const server = await startVerifyServer({ name: "tab", paths, port: 0 });
		const pw = await chromium.launch({ executablePath: resolveVerifyBrowser(), args: ["--no-sandbox"] });
		try {
			const page = await pw.newPage();
			const errors: string[] = [];
			page.on("pageerror", (error) => errors.push(String(error)));
			page.on("console", (message) => {
				if (message.text().includes("Content Security Policy")) errors.push(message.text());
			});
			await page.addInitScript(() => {
				localStorage.setItem("verify-mode", "light");
				const shown: { title: string; body: string }[] = [];
				Object.assign(window, { shown });
				class FakeNotification {
					static permission = "default";
					static requestPermission = async () => {
						FakeNotification.permission = "granted";
						return "granted";
					};
					onclick: (() => void) | null = null;
					constructor(title: string, options: { body: string }) {
						shown.push({ title, body: options.body });
					}
					close() {}
				}
				Object.assign(window, { Notification: FakeNotification });
			});
			await page.goto(`http://127.0.0.1:${server.port}/#nav-r1`);
			await page.waitForSelector("#notify svg");
			expect(await page.title()).toBe("(2) Nav r1 · Settings polish");
			expect(await page.textContent("aside h1")).toBe("Settings polish");
			expect(await page.getAttribute("#favicon", "href")).toStartWith("data:image/png;base64,");
			expect(await page.textContent(".shot-note-btn")).toBe("Note on this");

			expect(await page.evaluate(() => Boolean(document.getElementById("notify")?.closest("#toc .attention")))).toBe(true);
			await page.click("#notify");
			expect(await page.getAttribute("#notify", "aria-pressed")).toBe("true");
			expect(await page.evaluate(() => localStorage.getItem("verify-notify"))).toBe("1");
			await page.evaluate(() => Object.defineProperty(document, "hidden", { configurable: true, get: () => true }));
			writeBoard(paths, { ...board, sections: [...board.sections, { id: "forms-r1", title: "Forms", round: 1, images: [image("desktop · light · forms")] }] });
			await page.waitForFunction(() => document.title.includes("● New round"), undefined, { timeout: 15_000 });
			expect(await page.title()).toBe("(3) ● New round · Forms r1 · Settings polish");
			expect(await page.evaluate(() => (window as unknown as { shown: unknown[] }).shown)).toEqual([
				{ title: "Settings polish: a round is ready", body: "Forms" },
			]);
			await page.evaluate(() => {
				Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
				document.dispatchEvent(new Event("visibilitychange"));
			});
			expect(await page.title()).toBe("(3) Forms r1 · Settings polish");

			await page.goto(`http://127.0.0.1:${server.port}/#nav-r1`);
			await page.reload();
			await page.waitForSelector("#v-more svg");
			await page.click("#v-more");
			await page.waitForFunction(() => location.hash === "#home-r1");
			expect(readVerdicts(paths)["nav-r1"]).toMatchObject({ status: "more", note: "" });
			expect(readVerdicts(paths)["nav-r1"]?.variant).toBeUndefined();
			expect(await page.title()).toBe("(2) Home r1 · Settings polish");
			expect(errors).toEqual([]);
		} finally {
			await pw.close();
			server.stop();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test.skipIf(!browser)("compare modes, the compact nav, and the multi-line note work under the CSP", async () => {
		const dir = mkdtempSync(join(tmpdir(), "dg-verify-board-compare-"));
		const paths = verifyPaths(dir);
		writeBoard(paths, {
			name: "cmp",
			sections: [
				{
					id: "a-r1",
					title: "A",
					images: [
						{ label: "desktop · light · both", before: "/shots/a/before.png", after: "/shots/a/after.png" },
						{ label: "desktop · light · new", before: "missing", after: "/shots/a/new.png" },
					],
				},
			],
			pending: [],
		});
		const server = await startVerifyServer({ name: "cmp", paths, port: 0 });
		const pw = await chromium.launch({ executablePath: resolveVerifyBrowser(), args: ["--no-sandbox"] });
		try {
			const page = await pw.newPage();
			const errors: string[] = [];
			page.on("pageerror", (error) => errors.push(String(error)));
			page.on("console", (message) => {
				if (message.text().includes("Content Security Policy")) errors.push(message.text());
			});
			await page.addInitScript(() => localStorage.setItem("verify-mode", "light"));
			await page.goto(`http://127.0.0.1:${server.port}/#a-r1`);
			await page.waitForSelector("#cmp-btn svg");
			const pick = async (mode: string) => {
				await page.click("#cmp-btn");
				await page.click(`#cmp-menu [data-c="${mode}"]`);
			};
			for (const mode of ["slider", "fade", "flip", "diff"]) {
				await pick(mode);
				expect(await page.locator(`figure.cmp-${mode}`).count()).toBe(1);
				expect(await page.locator(".shot").nth(1).locator("figure").count()).toBe(2);
			}
			await pick("slider");
			await page.fill(".cmp-slider input[type=range]", "20");
			expect(await page.evaluate(() => (document.querySelector(".cmp-stage") as HTMLElement).style.getPropertyValue("--pos"))).toBe("20%");
			await pick("flip");
			await page.click(".cmp-flip-btn");
			expect(await page.getAttribute(".cmp-stage", "class")).toContain("show-before");
			expect(await page.evaluate(() => localStorage.getItem("verify-compare"))).toBe("flip");
			await pick("side");
			expect(await page.locator(".cmp").count()).toBe(0);

			await page.evaluate(() => localStorage.setItem("verify-nav-w", "500"));
			await page.reload();
			await page.waitForSelector("#nav-compact svg");
			await page.click("#nav-compact");
			expect(await page.evaluate(() => document.documentElement.classList.contains("nav-compact"))).toBe(true);
			expect(Math.round(await page.evaluate(() => document.querySelector("aside")?.getBoundingClientRect().width ?? 0))).toBe(76);
			await page.click("#nav-compact");
			expect(await page.evaluate(() => [document.documentElement.style.getPropertyValue("--nav-w"), localStorage.getItem("verify-nav-w")])).toEqual(["", null]);

			await page.click("#note-btn");
			await page.type("#note", "one");
			await page.keyboard.press("Shift+Enter");
			await page.type("#note", "two");
			await page.keyboard.press("Enter");
			expect(await page.inputValue("#note")).toBe("one\ntwo");
			expect(readVerdicts(paths)).toEqual({});
			expect(errors).toEqual([]);
		} finally {
			await pw.close();
			server.stop();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test.skipIf(!browser)("a screenshot note saves with the verdict and only the first waiting item animates", async () => {
		const dir = mkdtempSync(join(tmpdir(), "dg-verify-board-shotnote-"));
		const paths = verifyPaths(dir);
		const round = (id: string) => ({ id, title: id, images: [{ label: "desktop · light · a", before: "missing", after: "missing" }] });
		writeBoard(paths, {
			name: "notes",
			sections: [round("a-r1"), round("b-r1"), round("c-r1")],
			pending: [
				{ key: "d", title: "D" },
				{ key: "e", title: "E" },
			],
		});
		const server = await startVerifyServer({ name: "notes", paths, port: 0 });
		const pw = await chromium.launch({ executablePath: resolveVerifyBrowser(), args: ["--no-sandbox"] });
		try {
			const page = await pw.newPage();
			const errors: string[] = [];
			page.on("pageerror", (error) => errors.push(String(error)));
			await page.addInitScript(() => localStorage.setItem("verify-mode", "light"));
			await page.goto(`http://127.0.0.1:${server.port}/#a-r1`);
			await page.waitForSelector(".shot-note-btn svg");
			const animated = (selector: string) =>
				page.evaluate((sel) => [...document.querySelectorAll(sel)].map((node) => node.classList.contains("calm")), selector);
			expect(await animated("#toc .orb:not(.orb-count)")).toEqual([false, true, true]);
			expect(await animated("#toc .dot.working")).toEqual([false, true]);
			await page.click(".shot-note-btn");
			await page.fill(".shot-note input", "Header clips");
			expect(await page.getAttribute("#approve", "class")).toContain("with-note");
			await page.click("#approve");
			await page.waitForFunction(() => location.hash === "#b-r1");
			expect(readVerdicts(paths)["a-r1"]).toMatchObject({
				status: "approved",
				note: "[desktop · light · a] Header clips",
				mainNote: "",
				shotNotes: { "desktop · light · a": "Header clips" },
			});
			expect(await animated("#toc .orb:not(.orb-count)")).toEqual([false, true]);
			await page.goto(`http://127.0.0.1:${server.port}/#a-r1`);
			await page.reload();
			await page.waitForSelector("#decided-pill:not([hidden])");
			expect(await page.textContent(".shot-note blockquote")).toBe("Header clips");
			await page.click("#change");
			expect(await page.inputValue(".shot-note input")).toBe("Header clips");
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
