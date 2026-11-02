import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wslChromiumArgs } from "@dg/common/node";
import { pickLaunch } from "../pw/core/browser";
import type { TourScript } from "../utils/plan-format";
import {
	type TourPage,
	type VerifyResult,
	walkTour,
} from "../utils/demo-verify";
import { createBridge, tourOrigins, trustedSource } from "./bridge";
import { playerScript } from "./player-asset";

export type VerifySession = { page: TourPage; close(): Promise<void> };

export type VerifyLocalDeps = {
	open(script: TourScript): Promise<VerifySession>;
};

const VIEWPORT = { width: 1280, height: 720 };

export const STATE_PROBE = "JSON.stringify(window.__dgTour ? window.__dgTour.state() : { kind: 'none' })";
const ADVANCE = "window.__dgTour ? window.__dgTour.advance() : false";

type EvalPage = {
	evaluate(expression: string): Promise<unknown>;
	url(): string;
};

export function tourPageFor(
	page: EvalPage,
	drainNavigations: () => string[],
): TourPage {
	return {
		async readTourOverlay() {
			const probed = JSON.parse(String(await page.evaluate(STATE_PROBE))) as
				| { kind: "none" | "done" }
				| { kind: "step"; index: number; total: number }
				| { kind: "ended"; outcome: string; error?: string };
			if (probed.kind === "ended")
				throw new Error(
					probed.outcome === "error"
						? `the tour failed: ${probed.error ?? "unknown error"}`
						: "the tour stopped early",
				);
			return probed;
		},
		async clickThroughTour() {
			return Boolean(await page.evaluate(ADVANCE));
		},
		async selectorResolves(selector) {
			return Boolean(
				await page.evaluate(
					`(() => { try { return document.querySelector(${JSON.stringify(selector)}) !== null; } catch { return false; } })()`,
				),
			);
		},
		async locationHref() {
			return page.url();
		},
		drainNavigations,
	};
}

export async function openLocalSession(
	script: TourScript,
): Promise<VerifySession> {
	const { chromium } = await import("playwright-core");
	const pick = pickLaunch();
	const browser = await chromium.launch({
		headless: true,
		...("channel" in pick
			? { channel: pick.channel }
			: { executablePath: pick.executablePath }),
		args: wslChromiumArgs(),
	});
	const dir = mkdtempSync(join(tmpdir(), "dg-verify-"));
	const close = async (): Promise<void> => {
		await browser.close().catch(() => undefined);
		rmSync(dir, { recursive: true, force: true });
	};
	try {
		const context = await browser.newContext({ viewport: VIEWPORT });
		const page = await context.newPage();
		const bridge = createBridge({
			job: { dir, planPath: join(dir, "plan.md"), slug: "verify", video: false },
		});
		const origins = tourOrigins(script);
		const navigations: string[] = [];
		page.on("framenavigated", (frame) => {
			if (frame === page.mainFrame()) navigations.push(frame.url());
		});
		await page.exposeBinding("__dgDemoBridge", (source, msg: unknown) =>
			trustedSource(source, origins) ? bridge.handle(msg) : undefined,
		);
		await page.addInitScript(playerScript());
		const tour = `window.__dgTour.run(${JSON.stringify({ ...script, mode: "walkthrough" })}, { mode: "walkthrough" })`;
		page.on("domcontentloaded", () => {
			if (!trustedSource({ frame: page.mainFrame(), page }, origins)) return;
			void page.evaluate(tour).catch(() => undefined);
		});
		await page.goto(script.startUrl);
		const tourPage = tourPageFor(page, () =>
			navigations.splice(0, navigations.length),
		);
		return { page: tourPage, close };
	} catch (error) {
		await close();
		throw error;
	}
}

const harnessError = (error: unknown): VerifyResult => ({
	ok: false,
	findings: [
		{
			step: 0,
			kind: "harness-error",
			message: error instanceof Error ? error.message : String(error),
		},
	],
});

export async function verifyLocal(
	script: TourScript,
	deps: VerifyLocalDeps = { open: openLocalSession },
): Promise<VerifyResult> {
	let session: VerifySession;
	try {
		session = await deps.open(script);
	} catch (error) {
		return harnessError(error);
	}
	try {
		return await walkTour(session.page, script);
	} catch (error) {
		return harnessError(error);
	} finally {
		await session.close().catch(() => undefined);
	}
}
