import { existsSync } from "node:fs";
import path from "node:path";
import { wslChromiumArgs } from "@dg/common/node";
import type { BrowserContext, BrowserType } from "playwright-core";
import { MIN_BUN } from "./bun-version";
import { downloadedChromium } from "./downloaded";
import type { BrowserName, SessionRecord } from "./registry";
import { closeWindowsBrowser } from "./windows";

export type LaunchSpec = Omit<SessionRecord, "pid" | "startedAt"> & {
	storageState?: string;
	executablePath?: string;
};

export type SystemChannel = "chrome" | "msedge";

export type LaunchPick =
	| { channel: SystemChannel }
	| { executablePath: string };

export type LaunchSeams = {
	system(channel: SystemChannel): boolean;
	downloaded(): string | null;
};

export class BrowserMissingError extends Error {
	readonly exitCode = 3;

	constructor() {
		super(
			"No browser found. Ask the user, then run: dg-skills pw install-browser (downloads about 150 MB)",
		);
	}
}

const CHANNEL_PATHS: Record<
	SystemChannel,
	Partial<Record<NodeJS.Platform, string>>
> = {
	chrome: {
		linux: "/opt/google/chrome/chrome",
		darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		win32: "\\Google\\Chrome\\Application\\chrome.exe",
	},
	msedge: {
		linux: "/opt/microsoft/msedge/msedge",
		darwin: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
		win32: "\\Microsoft\\Edge\\Application\\msedge.exe",
	},
};

function windowsPrefixes(): string[] {
	const drive = process.env["HOMEDRIVE"];
	return [
		process.env["LOCALAPPDATA"],
		process.env["PROGRAMFILES"],
		process.env["PROGRAMFILES(X86)"],
		drive && `${drive}\\Program Files`,
		drive && `${drive}\\Program Files (x86)`,
	].filter((prefix): prefix is string => Boolean(prefix));
}

function channelExecutables(channel: SystemChannel): string[] {
	const location = CHANNEL_PATHS[channel][process.platform];
	if (!location) return [];
	if (process.platform !== "win32") return [location];
	return windowsPrefixes().map((prefix) => path.join(prefix, location));
}

export function systemBrowserPresent(
	channel: SystemChannel,
	exists: (file: string) => boolean = existsSync,
): boolean {
	return channelExecutables(channel).some((file) => exists(file));
}

const DEFAULT_SEAMS: LaunchSeams = {
	system: systemBrowserPresent,
	downloaded: () => downloadedChromium()?.executablePath ?? null,
};

export function pickLaunch(seams: LaunchSeams = DEFAULT_SEAMS): LaunchPick {
	for (const channel of ["chrome", "msedge"] as const)
		if (seams.system(channel)) return { channel };
	const executablePath = seams.downloaded();
	if (executablePath) return { executablePath };
	throw new BrowserMissingError();
}

export type BrowserHandle = {
	context: BrowserContext;
	closed: Promise<void>;
	close(): Promise<void>;
};

const ACTION_TIMEOUT_MS = 5_000;
const NAVIGATION_TIMEOUT_MS = 60_000;
const CDP_CONNECT_TIMEOUT_MS = 15_000;

async function engine(
	browser: BrowserName,
): Promise<{ type: BrowserType; channel?: string }> {
	const { chromium, firefox, webkit } = await import("playwright-core");
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

function finish(
	context: BrowserContext,
	closed: Promise<void>,
	close: () => Promise<void>,
): BrowserHandle {
	context.setDefaultTimeout(ACTION_TIMEOUT_MS);
	context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
	return { context, closed, close };
}

async function connectCdp(spec: LaunchSpec): Promise<BrowserHandle> {
	if (!spec.cdpUrl) throw new Error("CDP session needs a cdpUrl");
	const { chromium } = await import("playwright-core");
	const browser = await chromium
		.connectOverCDP(spec.cdpUrl, { timeout: CDP_CONNECT_TIMEOUT_MS })
		.catch((error: unknown) => {
			if (Bun.semver.order(Bun.version, MIN_BUN) >= 0) throw error;
			const detail =
				error instanceof Error ? error.message.split("\n")[0] : String(error);
			throw new Error(
				`${detail}\nBun ${Bun.version} cannot finish a CDP WebSocket upgrade. Use Bun ${MIN_BUN} or newer.`,
			);
		});
	const context = browser.contexts()[0] ?? (await browser.newContext());
	if (context.pages().length === 0) await context.newPage();
	const closed = new Promise<void>((resolve) =>
		browser.once("disconnected", () => resolve()),
	);

	const close = async (): Promise<void> => {
		if (spec.winPid === undefined || !spec.profileDir) return browser.close();
		const session = await browser.newBrowserCDPSession().catch(() => undefined);
		await session?.send("Browser.close").catch(() => undefined);
		const exit = await closeWindowsBrowser(spec.profileDir);
		if (exit.forced > 0)
			console.error(
				`Windows browser ignored Browser.close; force-stopped ${exit.forced} process(es)`,
			);
		if (exit.remaining > 0)
			console.error(
				`${exit.remaining} Windows browser process(es) still use ${spec.profileDir}`,
			);
	};
	return finish(context, closed, close);
}

export async function start(spec: LaunchSpec): Promise<BrowserHandle> {
	if (spec.mode === "cdp") return connectCdp(spec);
	const { type, channel } = await engine(spec.browser);
	const chromiumBased = ["chrome", "chromium", "msedge"].includes(spec.browser);
	const launchOptions = {
		headless: spec.headless,
		...(channel ? { channel } : {}),
		...(spec.executablePath ? { executablePath: spec.executablePath } : {}),
		...(chromiumBased ? { args: wslChromiumArgs() } : {}),
	};
	const viewport = spec.headless ? {} : { viewport: null };

	let context: BrowserContext;
	let closeBrowser: () => Promise<void>;
	if (spec.profileDir) {
		context = await type.launchPersistentContext(spec.profileDir, {
			...launchOptions,
			...viewport,
		});
		closeBrowser = () => context.close();
	} else {
		const browser = await type.launch(launchOptions);
		try {
			context = await browser.newContext({
				...viewport,
				...(spec.storageState ? { storageState: spec.storageState } : {}),
			});
			await context.newPage();
		} catch (error) {
			await browser.close().catch(() => undefined);
			throw error;
		}
		closeBrowser = () => browser.close();
	}

	const closed = new Promise<void>((resolve) =>
		context.once("close", () => resolve()),
	);
	return finish(context, closed, closeBrowser);
}
