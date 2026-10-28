import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { axeSummary } from "./axe";
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
import { ensureSession, type VerifyPaths } from "./verdict";

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

export function reportPath(dir: string, id: string): string {
	return join(dir, "reports", `${id}.json`);
}

function writeReport(dir: string, id: string, report: TestReport): void {
	const file = reportPath(dir, id);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(report)}\n`);
}

export function clearItemShots(paths: VerifyPaths, itemId: string): void {
	rmSync(join(paths.shotsDir, itemId), { recursive: true, force: true });
}

/** Capture every requested item at both viewports, both themes, and the three states. */
export async function captureSession(options: {
	manifest: VerifyManifest;
	paths: VerifyPaths;
	capturer: Capturer;
	cwd: string;
	items?: readonly string[];
}): Promise<{ shots: number }> {
	const wanted = new Set(options.items ?? options.manifest.items.map((item) => item.id));
	for (const id of wanted) {
		if (!options.manifest.items.some((item) => item.id === id))
			throw new Error(`unknown item ${JSON.stringify(id)}`);
	}
	ensureSession(options.paths);
	let shots = 0;
	const sessionTests = await runDeclaredTests(options.manifest.tests, options.cwd);
	writeReport(options.paths.dir, "session", sessionTests);
	for (const item of options.manifest.items) {
		if (!wanted.has(item.id)) continue;
		clearItemShots(options.paths, item.id);
		const itemTests = await runDeclaredTests(item.tests, options.cwd);
		writeReport(options.paths.dir, item.id, itemTests);
		for (const side of sidesFor(item)) {
			for (const role of item.roles) {
				for (const viewport of VIEWPORTS) {
					for (const theme of THEMES) {
						for (const state of STATES) {
							const url = sideUrl(item, side);
							let captured;
							try {
								captured = await options.capturer.shot({
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
								throw new Error(
									`${item.id} ${side} ${role.id} ${viewport.id} ${theme} ${state}: ${message}`,
								);
							}
							const record: ShotRecord = {
								itemId: item.id,
								side,
								role: role.id,
								viewport: viewport.id,
								width: viewport.width,
								height: viewport.height,
								theme,
								state,
								url,
								finalUrl: captured.finalUrl,
								engine: captured.engine,
								menuFound: captured.menuFound,
								scrolled: captured.scrolled,
								axe: axeSummary(captured.html),
							};
							const dir = join(
								options.paths.shotsDir,
								item.id,
								side,
								role.id,
								viewport.id,
								theme,
							);
							mkdirSync(dir, { recursive: true });
							writeFileSync(join(dir, `${state}.png`), captured.png);
							writeFileSync(join(dir, `${state}.json`), `${JSON.stringify(record)}\n`);
							shots += 1;
						}
					}
				}
			}
		}
	}
	return { shots };
}
