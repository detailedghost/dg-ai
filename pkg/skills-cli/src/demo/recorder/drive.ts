import {
	partitionTourSteps,
	resolveFill,
	type TourChapter,
	type TourScript,
	type TourStep,
} from "@dg/common";
import type { Page } from "playwright-core";
import {
	arrowSide,
	captionOnTop,
	clearOverlays,
	hideChapter,
	showCaption,
	showChapter,
	showFocus,
	THEME,
} from "./overlays";

export type DriveOptions = {
	env: Record<string, string | undefined>;
	/** Hold after a step's action, in ms. A dry run passes 0. */
	hold(step: TourStep, index: number): number;
	/** False for a dry run: no chapter cards, captions, outline or arrow. */
	overlays: boolean;
	typeDelayMs?: number;
	selectorTimeoutMs?: number;
	chapterMs?: number;
	leadMs?: number;
	pause?(ms: number): Promise<void>;
	/** Clock for offsets; the player counts from the start of the recording. */
	now?(): number;
};

/** `startMs` is when the first frame worth keeping begins; `offsets` are when each step's caption shows. */
export type DriveResult = { steps: number; startMs: number; offsets: number[] };

export class StepError extends Error {
	constructor(
		readonly index: number,
		message: string,
	) {
		super(`step ${index + 1}: ${message}`);
	}
}

const DEFAULTS = {
	typeDelayMs: 55,
	selectorTimeoutMs: 15_000,
	chapterMs: 2_600,
	leadMs: 600,
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The intro card: the authored one, or eyebrow "Demo" with the plan title. */
export function introChapter(script: TourScript): TourChapter | undefined {
	if (script.intro) return script.intro;
	if (!script.title) return undefined;
	return { eyebrow: "Demo", title: script.title, detail: "" };
}

/** Steps to play, each marked with whether it came from an included setup. */
export function playbackSteps(script: TourScript): { step: TourStep; setup: boolean }[] {
	const { tutorial } = partitionTourSteps(script);
	const setupCount = script.setup?.includeInTour ? script.setup.steps.length : 0;
	return tutorial.map((step, i) => ({ step, setup: i < setupCount }));
}

async function chapter(page: Page, card: TourChapter | undefined, ms: number, pause: (ms: number) => Promise<void>) {
	if (!card) return;
	await showChapter(page, card);
	await pause(ms);
	await hideChapter(page);
}

/** Drive a tour through the real UI, with recorder overlays unless this is a dry run. */
export async function recordTour(
	page: Page,
	script: TourScript,
	options: DriveOptions,
): Promise<DriveResult> {
	const o = { ...DEFAULTS, ...options };
	const pause = options.pause ?? sleep;
	const now = options.now ?? Date.now;
	const viewport = page.viewportSize() ?? { width: 1440, height: 810 };
	const offsets: number[] = [];

	await page.goto(script.startUrl, { waitUntil: "load" });
	const startMs = now();
	if (o.overlays) await chapter(page, introChapter(script), o.chapterMs, pause);

	const steps = playbackSteps(script);
	for (const [index, { step, setup }] of steps.entries()) {
		if (step.navigate) await page.goto(step.navigate, { waitUntil: "load" });
		const accent = setup ? THEME.setupAccent : THEME.accent;
		const target = step.selector ? page.locator(step.selector).first() : null;
		let box = null;
		if (target) {
			try {
				await target.waitFor({ state: "visible", timeout: o.selectorTimeoutMs });
			} catch {
				throw new StepError(
					index,
					`selector ${step.selector} did not resolve in ${o.selectorTimeoutMs / 1000}s`,
				);
			}
			await target.scrollIntoViewIfNeeded();
			box = await target.boundingBox();
		}
		offsets.push(now());
		if (o.overlays) {
			await showCaption(page, {
				eyebrow: step.title ?? `Step ${index + 1}`,
				body: step.body,
				accent,
				top: captionOnTop(box, viewport),
			});
			if (box) await showFocus(page, { box, side: arrowSide(box, viewport), accent });
		}
		if (step.action && target) {
			if (o.overlays) await pause(o.leadMs);
			if (step.action.do === "click") {
				await target.click();
				await page.waitForLoadState("load");
			} else {
				const text = resolveFill(step.action.value, o.env);
				await target.click();
				await target.pressSequentially(text, { delay: o.overlays ? o.typeDelayMs : 0 });
			}
		}
		await pause(o.hold(step, index));
	}

	if (o.overlays) {
		await clearOverlays(page);
		await chapter(page, script.outro, o.chapterMs, pause);
	}
	return { steps: steps.length, startMs, offsets };
}
