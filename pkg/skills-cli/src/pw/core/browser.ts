import { type BrowserContext, type BrowserType, chromium, firefox, webkit } from "playwright-core";
import type { BrowserName, SessionRecord } from "./registry";
import { closeWindowsBrowser } from "./windows";

export type LaunchSpec = Omit<SessionRecord, "pid" | "startedAt"> & { storageState?: string };

export type BrowserHandle = {
	context: BrowserContext;
	closed: Promise<void>;
	close(): Promise<void>;
};

const ACTION_TIMEOUT_MS = 5_000;
const NAVIGATION_TIMEOUT_MS = 60_000;
const CDP_CONNECT_TIMEOUT_MS = 15_000;
const MIN_BUN_FOR_CDP = "1.4.0";

function engine(browser: BrowserName): { type: BrowserType; channel?: string } {
	switch (browser) {
		case "chrome":
		case "msedge":
			return { type: chromium, channel: browser };
		case "chromium":
			return { type: chromium };
		case "firefox":
			return { type: firefox };
		case "webkit":
			return { type: webkit };
	}
}

function finish(context: BrowserContext, closed: Promise<void>, close: () => Promise<void>): BrowserHandle {
	context.setDefaultTimeout(ACTION_TIMEOUT_MS);
	context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
	return { context, closed, close };
}

async function connectCdp(spec: LaunchSpec): Promise<BrowserHandle> {
	if (!spec.cdpUrl) throw new Error("CDP session needs a cdpUrl");
	const browser = await chromium
		.connectOverCDP(spec.cdpUrl, { timeout: CDP_CONNECT_TIMEOUT_MS })
		.catch((error: unknown) => {
			if (Bun.semver.order(Bun.version, MIN_BUN_FOR_CDP) >= 0) throw error;
			const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
			throw new Error(
				`${detail}\nBun ${Bun.version} cannot finish a CDP WebSocket upgrade. Use Bun ${MIN_BUN_FOR_CDP} or newer.`,
			);
		});
	const context = browser.contexts()[0] ?? (await browser.newContext());
	if (context.pages().length === 0) await context.newPage();
	const closed = new Promise<void>((resolve) => browser.once("disconnected", () => resolve()));

	const close = async (): Promise<void> => {
		if (spec.winPid === undefined || !spec.profileDir) return browser.close();
		const session = await browser.newBrowserCDPSession().catch(() => undefined);
		await session?.send("Browser.close").catch(() => undefined);
		const exit = await closeWindowsBrowser(spec.profileDir);
		if (exit.forced > 0)
			console.error(`Windows browser ignored Browser.close; force-stopped ${exit.forced} process(es)`);
		if (exit.remaining > 0) console.error(`${exit.remaining} Windows browser process(es) still use ${spec.profileDir}`);
	};
	return finish(context, closed, close);
}

export async function start(spec: LaunchSpec): Promise<BrowserHandle> {
	if (spec.mode === "cdp") return connectCdp(spec);
	const { type, channel } = engine(spec.browser);
	const launchOptions = { headless: spec.headless, ...(channel ? { channel } : {}) };
	const viewport = spec.headless ? {} : { viewport: null };

	let context: BrowserContext;
	let closeBrowser: () => Promise<void>;
	if (spec.profileDir) {
		context = await type.launchPersistentContext(spec.profileDir, { ...launchOptions, ...viewport });
		closeBrowser = () => context.close();
	} else {
		const browser = await type.launch(launchOptions);
		context = await browser.newContext({
			...viewport,
			...(spec.storageState ? { storageState: spec.storageState } : {}),
		});
		await context.newPage();
		closeBrowser = () => browser.close();
	}

	const closed = new Promise<void>((resolve) => context.once("close", () => resolve()));
	return finish(context, closed, closeBrowser);
}
