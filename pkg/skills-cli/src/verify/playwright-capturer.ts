import { resolveBrowserBinary, sandboxDisabled } from "../utils/cdp-harness";
import {
	menuIsOpen,
	pageMarkedScrolled,
	withCaptureQuery,
	type Capturer,
	type CaptureRequest,
	type CaptureShot,
} from "./capture-model";

const STABLE_BROWSERS = ["google-chrome", "google-chrome-stable"];

/** Prefer the CDP harness browsers, then Chrome stable, which can screenshot without an extension. */
export function resolveVerifyBrowser(): string {
	try {
		return resolveBrowserBinary();
	} catch {
		for (const name of STABLE_BROWSERS) {
			const found = Bun.which(name);
			if (found) return found;
		}
		throw new Error(
			"verify capture needs a Chromium-family browser on PATH, or pass --engine=http. Set DG_VERIFY_BROWSER to a binary.",
		);
	}
}

/** True when a screenshot browser is on PATH. Missing browsers skip, they do not fail. */
export function verifyBrowserAvailable(): boolean {
	try {
		resolveVerifyBrowser();
		return true;
	} catch {
		return false;
	}
}

/** Launch playwright-core against a local Chromium and screenshot one viewport at a time. */
export async function openPlaywrightCapturer(options?: {
	noSandbox?: boolean;
	executablePath?: string;
}): Promise<Capturer> {
	const { chromium } = await import("playwright-core");
	const executablePath = options?.executablePath ?? resolveVerifyBrowser();
	const noSandbox = options?.noSandbox ?? sandboxDisabled();
	const browser = await chromium.launch({
		executablePath,
		headless: true,
		args: [
			"--disable-dev-shm-usage",
			...(noSandbox ? ["--no-sandbox", "--disable-gpu"] : []),
		],
	});
	return {
		async shot(request: CaptureRequest): Promise<CaptureShot> {
			const context = await browser.newContext({
				viewport: { width: request.width, height: request.height },
				deviceScaleFactor: 1,
				colorScheme: request.theme,
				extraHTTPHeaders: request.headers,
				ignoreHTTPSErrors: true,
			});
			try {
				if (request.cookies.length > 0) {
					const pageUrl = new URL(request.url);
					await context.addCookies(
						request.cookies.map((cookie) => ({
							name: cookie.name,
							value: cookie.value,
							url: `${pageUrl.protocol}//${pageUrl.host}`,
						})),
					);
				}
				const page = await context.newPage();
				const target = withCaptureQuery(request.url, request.theme, request.state);
				await page.goto(target, { waitUntil: "domcontentloaded", timeout: 10_000 });
				const landed = new URL(page.url());
				const host = landed.hostname.replace(/^\[|\]$/g, "");
				if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1")
					throw new Error(`verify refused a navigation to ${page.url()}`);
				let menuFound = false;
				if (request.state === "scrolled")
					await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
				if (request.state === "menu") {
					const control = page.locator(request.menuSelector).first();
					if ((await control.count()) > 0) {
						await control.click();
						menuFound = true;
					}
				}
				const png = new Uint8Array(await page.screenshot({ type: "png", fullPage: false }));
				const html = await page.content();
				const scrollY = await page.evaluate(() => window.scrollY);
				return {
					png,
					html,
					finalUrl: page.url(),
					menuFound: request.state === "menu" && (menuFound || menuIsOpen(html)),
					scrolled: request.state === "scrolled" && (scrollY > 0 || pageMarkedScrolled(html)),
					engine: "playwright",
				};
			} finally {
				await context.close();
			}
		},
		async close() {
			await browser.close();
		},
	};
}
