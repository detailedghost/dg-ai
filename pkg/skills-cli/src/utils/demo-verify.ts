/**
 * Drives an already-validated TourScript through a real, throwaway-profile browser
 * with the built dg-ai-extension loaded, and reports what a human would otherwise hit
 * first: a selector that doesn't resolve, a click that leaves the page with no
 * `navigate` recorded, or a step that lands somewhere other than its authored
 * `navigate`. Clicks through the extension's own rendered tour like a user would
 * (consent card, "Next step", "Done") rather than re-deriving its page-routing rules,
 * so findings can't drift from what actually plays (see slice 6 brief).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { partitionTourSteps, type TourScript } from "@dg/common";
import { type CdpPageHandle, DemoVerifyHarness } from "./cdp-harness";
import { addDemoMarker } from "./demo-marker";
import { extensionDest, repoRoot } from "./lib";

export type Finding =
	| { step: number; kind: "selector-unresolved"; selector: string }
	| { step: number; kind: "unrecorded-navigation"; url: string }
	| { step: number; kind: "page-mismatch"; expected: string; actual: string }
	| { step: number; kind: "plan-unreadable"; message: string }
	| { step: number; kind: "harness-error"; message: string };

export type VerifyResult = { ok: boolean; findings: Finding[] };

/** The built extension to load: this dev checkout's own build takes priority — verify
 *  exists to catch a plan against the *current* source, and a stale staged install
 *  would silently pass a plan the just-edited extension actually breaks — falling back
 *  to the staged install (what `install`/`launch` already stage to) outside a checkout. */
export function resolveExtensionDir(): string {
	const dev = join(repoRoot(), "pkg", "extension", ".output", "chrome-mv3");
	if (existsSync(join(dev, "manifest.json"))) return dev;
	const staged = extensionDest("chrome").copyPath;
	if (existsSync(join(staged, "manifest.json"))) return staged;
	throw new Error(
		`no built dg-ai-extension found (looked in ${dev} and ${staged}) — run \`install\`, or ` +
			"`bun run build` under pkg/extension, first",
	);
}

/** How long an idle "nothing rendered yet" streak is tolerated before giving up —
 *  covers extension init plus waitForEl's own ~1.5s poll for an unresolved selector. */
const OVERLAY_IDLE_TIMEOUT_MS = 10000;
const OVERLAY_POLL_MS = 200;
const STEP_SETTLE_MS = 700;

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function absoluteUrl(url: string, base: string): string {
	return new URL(url, base).href;
}

/** Fragments are our own marker's business, not a real page difference. */
function normalizeUrl(url: string): string {
	return url.replace(/#.*$/, "");
}

export async function verifyScript(script: TourScript): Promise<VerifyResult> {
	const extensionDir = resolveExtensionDir();
	const manifestName = JSON.parse(
		readFileSync(join(extensionDir, "manifest.json"), "utf8"),
	).name as string;
	const harness = await DemoVerifyHarness.launch(extensionDir);
	try {
		await harness.confirmExtensionLoaded(manifestName);
		const page = await harness.openPage(addDemoMarker(script.startUrl, script));
		try {
			return await walkTour(page, script);
		} finally {
			page.dispose();
		}
	} finally {
		await harness.close();
	}
}

async function walkTour(
	page: CdpPageHandle,
	script: TourScript,
): Promise<VerifyResult> {
	const steps = partitionTourSteps(script).tutorial;
	const navigateTargets = new Set(
		steps.flatMap((s) =>
			s.navigate
				? [normalizeUrl(absoluteUrl(s.navigate, script.startUrl))]
				: [],
		),
	);
	const findings: Finding[] = [];
	const checkedSelector = new Set<number>();
	const checkedPageMismatch = new Set<number>();
	const reportedNav = new Set<number>();

	let idleWaits = 0;
	const maxIdleWaits = Math.ceil(OVERLAY_IDLE_TIMEOUT_MS / OVERLAY_POLL_MS);

	for (let iterations = 0; iterations < steps.length * 4 + 10; iterations++) {
		const overlay = await page.readTourOverlay();

		if (overlay.kind === "none") {
			if (++idleWaits > maxIdleWaits) {
				findings.push({
					step: 0,
					kind: "harness-error",
					message: "tour overlay never rendered",
				});
				break;
			}
			await wait(OVERLAY_POLL_MS);
			continue;
		}
		idleWaits = 0;

		if (overlay.kind === "consent") {
			await page.clickThroughTour();
			await wait(300);
			continue;
		}
		if (overlay.kind === "done") break;

		const i = overlay.index;
		const step = steps[i];
		if (!step) break;

		if (step.selector && !checkedSelector.has(i)) {
			checkedSelector.add(i);
			if (!(await page.selectorResolves(step.selector))) {
				findings.push({
					step: i + 1,
					kind: "selector-unresolved",
					selector: step.selector,
				});
			}
		}
		if (step.navigate && !checkedPageMismatch.has(i)) {
			checkedPageMismatch.add(i);
			const expected = absoluteUrl(step.navigate, script.startUrl);
			const actual = await page.locationHref();
			if (normalizeUrl(actual) !== normalizeUrl(expected)) {
				findings.push({ step: i + 1, kind: "page-mismatch", expected, actual });
			}
		}

		/**
		 * A click-driven navigation the tour didn't author a `navigate` for gets
		 * corrected ("bounced back") by the tour itself, often within a single
		 * localhost round trip — faster than two `locationHref()` reads spaced
		 * apart would ever catch. Draining the frameNavigated log can't miss it.
		 */
		page.drainNavigations();
		const clicked = await page.clickThroughTour();
		if (!clicked) break;
		await wait(STEP_SETTLE_MS);
		const unaccountedFor = page
			.drainNavigations()
			.find((url) => !navigateTargets.has(normalizeUrl(url)));
		if (unaccountedFor && !reportedNav.has(i)) {
			reportedNav.add(i);
			findings.push({
				step: i + 1,
				kind: "unrecorded-navigation",
				url: unaccountedFor,
			});
		}
	}

	return { ok: findings.length === 0, findings };
}
