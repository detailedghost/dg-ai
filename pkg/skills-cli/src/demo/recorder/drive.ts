import {
	envReference,
	partitionTourSteps,
	resolveFill,
	type TourChapter,
	type TourScript,
	type TourStep,
} from "@dg/common";
import type { Locator, Page } from "playwright-core";
import {
	arrowSide,
	captionOnTop,
	clearOverlays,
	hideChapter,
	OVERLAY_IDS,
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
	/** Called instead of throwing when a fill names an unset env variable; the handler leaves the field filled. */
	onMissingEnv?(prompt: MissingEnvPrompt): Promise<{ navigated: boolean }>;
	/** Called for a step skipped because the page moved on during a person's sign-in. */
	onSkippedStep?(index: number): void;
	skippedStepMs?: number;
};

export type MissingEnvPrompt = {
	page: Page;
	target: Locator;
	step: TourStep;
	index: number;
	next: TourStep | undefined;
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

export class PasswordFieldError extends StepError {
	constructor(
		index: number,
		readonly variable: string,
	) {
		super(index, `$${variable} can only be typed into a password field`);
	}
}

export const VIEWPORT = { width: 1440, height: 810 };

const DEFAULTS = {
	typeDelayMs: 55,
	selectorTimeoutMs: 15_000,
	chapterMs: 2_600,
	leadMs: 600,
	skippedStepMs: 2_000,
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

const isPasswordField = (target: Locator): Promise<boolean> =>
	target.evaluate((el) => el instanceof HTMLInputElement && el.type === "password");

const hasCaption = (page: Page): Promise<boolean> =>
	page.evaluate((id) => document.getElementById(id) !== null, OVERLAY_IDS.caption);

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
	const viewport = page.viewportSize() ?? VIEWPORT;
	const offsets: number[] = [];
	let signedInByPerson = false;

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
			const timeout = signedInByPerson ? o.skippedStepMs : o.selectorTimeoutMs;
			try {
				await target.waitFor({ state: "visible", timeout });
			} catch {
				if (signedInByPerson) {
					o.onSkippedStep?.(index);
					continue;
				}
				throw new StepError(
					index,
					`selector ${step.selector} did not resolve in ${o.selectorTimeoutMs / 1000}s`,
				);
			}
			await target.scrollIntoViewIfNeeded();
			box = await target.boundingBox();
		}
		offsets.push(now());
		const caption = {
			eyebrow: step.title ?? `Step ${index + 1}`,
			body: step.body,
			accent,
			top: captionOnTop(box, viewport),
		};
		if (o.overlays) {
			await showCaption(page, caption);
			if (box) await showFocus(page, { box, side: arrowSide(box, viewport), accent });
		}
		if (step.action && target) {
			if (o.overlays) await pause(o.leadMs);
			if (step.action.do === "click") {
				await target.click();
				await page.waitForLoadState("load");
				if (o.overlays && !(await hasCaption(page))) await showCaption(page, caption);
			} else {
				const name = envReference(step.action.value);
				if (name && !(await isPasswordField(target)))
					throw new PasswordFieldError(index, name);
				if (name && !o.env[name] && o.onMissingEnv) {
					const person = await o.onMissingEnv({ page, target, step, index, next: steps[index + 1]?.step });
					signedInByPerson ||= person.navigated;
				} else {
					const text = resolveFill(step.action.value, o.env);
					await target.click();
					try {
						await target.fill("");
						await target.pressSequentially(text, { delay: o.overlays ? o.typeDelayMs : 0 });
					} catch {
						throw new StepError(index, `could not type into ${step.selector}`);
					}
				}
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
