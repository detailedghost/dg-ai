import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { axeSummary, mergeAxe } from "./axe";
import type { BoardImage, Section, VerifyPaths } from "./board";
import {
	STATES,
	THEMES,
	VIEWPORTS,
	type Capturer,
	type ShotRecord,
	type SideName,
} from "./capture-model";
import type { VerifyItem, VerifyManifest } from "./manifest";
import { runDeclaredTests, type TestReport } from "./tests-run";

export interface CaptureTarget {
	itemId: string;
	sectionId: string;
}

export interface CapturedItem {
	item: VerifyItem;
	sectionId: string;
	records: ShotRecord[];
	tests: TestReport;
}

export function sidesFor(item: VerifyItem): SideName[] {
	const sides: SideName[] = ["before", "after"];
	if (item.targetUrl) sides.push("target");
	return sides;
}

function sideUrl(item: VerifyItem, side: SideName): string {
	if (side === "before") return item.beforeUrl;
	if (side === "after") return item.afterUrl;
	if (!item.targetUrl) throw new Error(`${item.id} has no prototype target`);
	return item.targetUrl;
}

/** Capture each target item at every viewport, theme, and state into the target's section folder. */
export async function captureSession(options: {
	manifest: VerifyManifest;
	paths: VerifyPaths;
	capturer: Capturer;
	cwd: string;
	targets: readonly CaptureTarget[];
}): Promise<CapturedItem[]> {
	const items = options.targets.map((target) => {
		const item = options.manifest.items.find((entry) => entry.id === target.itemId);
		if (!item) throw new Error(`unknown item ${JSON.stringify(target.itemId)}`);
		return { item, sectionId: target.sectionId };
	});
	const sessionTests = await runDeclaredTests(options.manifest.tests, options.cwd);
	const captured: CapturedItem[] = [];
	for (const { item, sectionId } of items) {
		const root = join(options.paths.shotsDir, sectionId);
		rmSync(root, { recursive: true, force: true });
		const itemTests = await runDeclaredTests(item.tests, options.cwd);
		const records: ShotRecord[] = [];
		for (const side of sidesFor(item)) {
			for (const role of item.roles) {
				for (const viewport of VIEWPORTS) {
					for (const theme of THEMES) {
						for (const state of STATES) {
							const url = sideUrl(item, side);
							let shot;
							try {
								shot = await options.capturer.shot({
									url,
									headers: role.headers,
									cookies: role.cookies,
									width: viewport.width,
									height: viewport.height,
									theme,
									state,
									menuSelector: item.menuSelector,
								});
							} catch (error) {
								const message = error instanceof Error ? error.message : String(error);
								throw new Error(`${item.id} ${side} ${role.id} ${viewport.id} ${theme} ${state}: ${message}`);
							}
							const dir = join(root, side, role.id, viewport.id, theme);
							mkdirSync(dir, { recursive: true });
							writeFileSync(join(dir, `${state}.png`), shot.png);
							records.push({
								itemId: item.id,
								side,
								role: role.id,
								viewport: viewport.id,
								width: viewport.width,
								height: viewport.height,
								theme,
								state,
								url,
								finalUrl: shot.finalUrl,
								engine: shot.engine,
								menuFound: shot.menuFound,
								scrolled: shot.scrolled,
								src: `/shots/${sectionId}/${side}/${role.id}/${viewport.id}/${theme}/${state}.png`,
								axe: axeSummary(shot.html),
							});
						}
					}
				}
			}
		}
		captured.push({ item, sectionId, records, tests: itemTests.status === "not-run" ? sessionTests : itemTests });
	}
	return captured;
}

function imageLabel(record: ShotRecord): string {
	const parts = [record.viewport, record.role, record.theme, record.state];
	if (record.state === "menu" && !record.menuFound) parts.push("menu not found");
	if (record.state === "scrolled" && !record.scrolled) parts.push("page did not scroll");
	if (record.engine === "http") parts.push("html fetch");
	return parts.join(" · ");
}

/** Pair captured shots into board images and fold the after side's checks into the section. */
export function sectionFromCapture(
	captured: CapturedItem,
	round: { round: number; follows?: string; summary?: string },
): Section {
	const { item, records } = captured;
	const key = (record: ShotRecord) => `${record.role}/${record.viewport}/${record.theme}/${record.state}`;
	const afters = records.filter((record) => record.side === "after");
	const images = afters.map((after) => {
		const match = (side: SideName) => records.find((record) => record.side === side && key(record) === key(after));
		const image: BoardImage = { label: imageLabel(after), before: match("before")?.src ?? "missing", after: after.src };
		const target = match("target");
		if (target) image.target = target.src;
		return image;
	});
	const axe = mergeAxe(afters.map((record) => record.axe));
	const section: Section = {
		id: captured.sectionId,
		title: item.title,
		round: round.round,
		item: item.id,
		checks: {
			tests: { status: captured.tests.status, summary: captured.tests.summary },
			axe: { violations: axe.violations.map((violation) => violation.id), passes: axe.passes.length },
		},
		images,
	};
	if (round.summary) section.summary = round.summary;
	if (round.follows) section.follows = round.follows;
	if (item.afterRef) section.branch = item.afterRef;
	if (item.what) section.what_changed = item.what;
	return section;
}
