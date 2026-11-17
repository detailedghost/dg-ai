import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { type Browser, chromium, type Page } from "playwright-core";
import { pwExtBanner } from "@/lib/features/pw-ext-banner";

setDefaultTimeout(60_000);

const candidate = process.env.PW_E2E === "1" ? (process.env.DG_BROWSER ?? chromium.executablePath()) : null;
const executablePath = candidate && existsSync(candidate) ? candidate : null;

const APP_SHELL = `<!doctype html>
<style>
body{margin:0;font:14px sans-serif}
#top{position:fixed;top:0;left:0;right:0;height:48px;display:flex;align-items:center;gap:8px;padding:0 12px;background:#0f6cbd;z-index:1000}
#search{width:320px;height:28px}
#shell{height:100vh;display:flex;flex-direction:column;padding-top:48px;box-sizing:border-box}
#bar{position:sticky;top:48px;height:40px;background:#ddd}
#list{flex:1;overflow:auto}
#list div{height:40px}
</style>
<header id="top"><button id="menu">Menu</button><input id="search" placeholder="Search"></header>
<div id="shell"><div id="bar"><button id="reply">Reply</button></div><div id="list">${"<div>Message</div>".repeat(60)}</div></div>`;

async function layout(page: Page) {
	return page.evaluate(() => {
		const rect = (selector: string) => {
			const box = document.querySelector(selector)?.getBoundingClientRect();
			return box ? [box.x, box.y, box.width, box.height] : null;
		};
		const style = (element: Element) => {
			const computed = getComputedStyle(element);
			return ["margin", "padding", "transform", "zoom", "height", "overflow", "position", "top"].map((name) =>
				computed.getPropertyValue(name),
			);
		};
		return {
			html: style(document.documentElement),
			body: style(document.body),
			rects: ["#top", "#search", "#shell", "#bar", "#list"].map(rect),
			scroll: [document.documentElement.scrollHeight, document.documentElement.scrollWidth, innerHeight, innerWidth],
			attributes: [document.documentElement.getAttribute("style"), document.body.getAttribute("style")],
		};
	});
}

async function hitAt(page: Page, selector: string) {
	const box = await page.locator(selector).boundingBox();
	if (!box) throw new Error(`no box for ${selector}`);
	return page.evaluate(
		({ x, y }) => {
			const hit = document.elementFromPoint(x, y);
			return hit ? hit.id || hit.localName : null;
		},
		{ x: box.x + box.width / 2, y: box.y + box.height / 2 },
	);
}

describe.skipIf(!executablePath)("agent banner in a real page with a fixed header and a 100vh app shell", () => {
	let browser: Browser;
	let page: Page;

	beforeAll(async () => {
		browser = await chromium.launch({ executablePath: executablePath as string, args: ["--no-sandbox"] });
	});
	afterAll(async () => {
		await browser?.close();
	});
	beforeEach(async () => {
		page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
		await page.setContent(APP_SHELL);
		await page.evaluate(() => {
			const sent: unknown[] = [];
			Object.defineProperty(window, "__sent", { value: sent });
			Object.defineProperty(window, "chrome", {
				configurable: true,
				value: { runtime: { sendMessage: async (message: unknown) => void sent.push(message) } },
			});
			const attach = Element.prototype.attachShadow;
			Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit) {
				return attach.call(this, { ...init, mode: "open" });
			};
		});
	});

	const show = (title: string) => page.evaluate(`(${pwExtBanner.toString()})(true, ${JSON.stringify(title)})`);

	test("keeps the fixed header search, the sticky bar and the page layout clear and unchanged", async () => {
		const before = await layout(page);
		await show("claude-code · 3f9a");
		expect(await page.locator("dg-agent-banner button").isVisible()).toBe(true);
		expect(await hitAt(page, "#search")).toBe("search");
		expect(await hitAt(page, "#menu")).toBe("menu");
		expect(await hitAt(page, "#reply")).toBe("reply");
		expect(await layout(page)).toEqual(before);
		await page.locator("#search").click();
		expect(await page.evaluate(() => document.activeElement?.id)).toBe("search");
	});

	test("sits in the bottom-left corner inside the viewport", async () => {
		await show("x".repeat(40));
		const box = await page.locator("dg-agent-banner").boundingBox();
		expect(box).not.toBeNull();
		const { x, y, width, height } = box as { x: number; y: number; width: number; height: number };
		expect(x).toBe(12);
		expect(y + height).toBe(720 - 12);
		expect(width).toBeLessThanOrEqual(440);
		expect(height).toBeLessThan(48);
		expect(await hitAt(page, "dg-agent-banner button")).toBe("dg-agent-banner");
	});

	test("keeps Stop inside a narrow viewport", async () => {
		await page.setViewportSize({ width: 320, height: 640 });
		await show("claude-code · 3f9a");
		const stop = await page.locator("dg-agent-banner button").boundingBox();
		expect(stop).not.toBeNull();
		const { x, width } = stop as { x: number; width: number };
		expect(x).toBeGreaterThanOrEqual(0);
		expect(x + width).toBeLessThanOrEqual(320);
	});

	test("a trusted Stop click sends Stop and restores the page layout exactly", async () => {
		const before = await layout(page);
		await show("claude-code · 3f9a");
		await page.locator("dg-agent-banner button").click();
		expect(await page.evaluate(() => (window as unknown as { __sent: unknown[] }).__sent)).toEqual([
			{ type: "dg-pw-ext:stop" },
		]);
		expect(await page.locator("dg-agent-banner").count()).toBe(0);
		expect(await layout(page)).toEqual(before);
	});
});
