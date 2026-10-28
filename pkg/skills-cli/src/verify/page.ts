import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mergeAxe, type AxeReport } from "./axe";
import { reportPath, sidesFor } from "./capture";
import {
	STATES,
	THEMES,
	VIEWPORTS,
	type ShotRecord,
	type SideName,
} from "./capture-model";
import type { VerifyItem, VerifyManifest } from "./manifest";
import type { TestReport } from "./tests-run";
import {
	readDecisions,
	readReload,
	statusReport,
	type Action,
	type VerifyPaths,
} from "./verdict";

export interface ReviewShot {
	side: SideName;
	role: string;
	viewport: string;
	width: number;
	height: number;
	theme: string;
	state: string;
	src: string;
	engine: "http" | "playwright";
	menuFound: boolean;
	scrolled: boolean;
}

export interface ReviewItem {
	id: string;
	title: string;
	owner: string;
	beforeRef?: string;
	afterRef?: string;
	route?: string;
	hasTarget: boolean;
	decision?: { action: Action; note: string };
	shots: ReviewShot[];
	axe: AxeReport;
	tests: TestReport;
}

export interface ReviewModel {
	name: string;
	stackUrl: string;
	token: string;
	status: string;
	allApproved: boolean;
	claimed: boolean;
	httpEngine: boolean;
	error?: string;
	items: ReviewItem[];
	tests: TestReport;
}

const EMPTY_AXE: AxeReport = {
	tool: "dg-axe-summary",
	engine: "local-static",
	violations: [],
	passes: [],
};

const NOT_RUN: TestReport = {
	status: "not-run",
	summary: "No test results supplied.",
	exitCode: null,
};

export function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function readJson<T>(file: string): T | undefined {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function readReport(dir: string, id: string): TestReport {
	const report = readJson<TestReport>(reportPath(dir, id));
	if (!report) return NOT_RUN;
	if (
		(report.status !== "passed" && report.status !== "failed" && report.status !== "not-run") ||
		typeof report.summary !== "string"
	)
		throw new Error(`test report ${id} is invalid`);
	return report;
}

function shotSrc(record: ShotRecord): string {
	return `/shots/${record.itemId}/${record.side}/${record.role}/${record.viewport}/${record.theme}/${record.state}.png`;
}

function loadShots(paths: VerifyPaths, item: VerifyItem): ReviewShot[] {
	const shots: ReviewShot[] = [];
	for (const side of sidesFor(item)) {
		for (const role of item.roles) {
			for (const viewport of VIEWPORTS) {
				for (const theme of THEMES) {
					for (const state of STATES) {
						const file = join(
							paths.shotsDir,
							item.id,
							side,
							role.id,
							viewport.id,
							theme,
							`${state}.json`,
						);
						const record = readJson<ShotRecord>(file);
						if (!record) continue;
						shots.push({
							side,
							role: role.id,
							viewport: viewport.id,
							width: record.width,
							height: record.height,
							theme,
							state,
							src: shotSrc(record),
							engine: record.engine,
							menuFound: record.menuFound,
							scrolled: record.scrolled,
						});
					}
				}
			}
		}
	}
	return shots;
}

export function loadReview(paths: VerifyPaths, manifest: VerifyManifest, error?: string): ReviewModel {
	const decisions = readDecisions(paths);
	const report = statusReport(paths, manifest);
	const sessionTests = readReport(paths.dir, "session");
	const items = manifest.items.map((item) => {
		const shots = loadShots(paths, item);
		const itemTests = readReport(paths.dir, item.id);
		const decision = decisions[item.id];
		return {
			id: item.id,
			title: item.title,
			owner: item.owner,
			beforeRef: item.beforeRef,
			afterRef: item.afterRef,
			route: item.route,
			hasTarget: item.targetUrl !== undefined,
			decision: decision ? { action: decision.action, note: decision.note } : undefined,
			shots,
			axe: mergeAxe(shots.map((shot) => readShotAxe(paths, item.id, shot))),
			tests: itemTests.status === "not-run" ? sessionTests : itemTests,
		};
	});
	return {
		name: manifest.name,
		stackUrl: manifest.stackUrl,
		token: String(readReload(paths)),
		status: report.status,
		allApproved: report.allApproved,
		claimed: report.claimed,
		httpEngine: items.some((item) => item.shots.some((shot) => shot.engine === "http")),
		error,
		items,
		tests: sessionTests,
	};
}

function readShotAxe(paths: VerifyPaths, itemId: string, shot: ReviewShot): AxeReport {
	const file = join(
		paths.shotsDir,
		itemId,
		shot.side,
		shot.role,
		shot.viewport,
		shot.theme,
		`${shot.state}.json`,
	);
	const record = readJson<ShotRecord>(file);
	return record?.axe ?? EMPTY_AXE;
}

function caption(shot: ReviewShot): string {
	const notes = [`${shot.role}`, `${shot.viewport} ${shot.width}×${shot.height}`, shot.theme, shot.state];
	if (shot.state === "menu" && !shot.menuFound) notes.push("menu not found");
	if (shot.state === "scrolled" && !shot.scrolled) notes.push("page did not scroll");
	if (shot.engine === "http") notes.push("html fetch");
	return notes.join(" · ");
}

function figures(shots: ReviewShot[], side: SideName): string {
	const rows = shots.filter((shot) => shot.side === side);
	if (rows.length === 0) return "<p>No captures.</p>";
	return rows
		.map(
			(shot) => `<figure>
<img src="${escapeHtml(shot.src)}" alt="${escapeHtml(caption(shot))}">
<figcaption>${escapeHtml(caption(shot))}</figcaption>
</figure>`,
		)
		.join("");
}

function column(title: string, side: SideName, item: ReviewItem, body: string): string {
	const count = item.shots.filter((shot) => shot.side === side).length;
	return `<section data-side="${side}" data-shot-count="${count}"><h3>${title}</h3>${body}</section>`;
}

function axeBlock(item: ReviewItem): string {
	const items = item.axe.violations
		.map(
			(violation) =>
				`<li data-axe-id="${escapeHtml(violation.id)}">${escapeHtml(violation.id)}: ${escapeHtml(violation.help)}</li>`,
		)
		.join("");
	const list = items.length > 0 ? `<ul>${items}</ul>` : "<p>No violations in the captured HTML.</p>";
	return `<section data-axe data-axe-passes="${item.axe.passes.length}" data-axe-violations="${item.axe.violations.length}"><h3>Accessibility</h3><p>Local static check using axe rule ids.</p>${list}</section>`;
}

function testsBlock(item: ReviewItem): string {
	return `<section data-tests data-tests-status="${item.tests.status}"><h3>Tests</h3><pre>${escapeHtml(item.tests.summary)}</pre></section>`;
}

function picker(item: ReviewItem, claimed: boolean): string {
	const current = item.decision
		? `<p data-decision="${item.decision.action}">${escapeHtml(item.decision.action)}${item.decision.note ? `: ${escapeHtml(item.decision.note)}` : ""}</p>`
		: `<p data-decision="pending">pending</p>`;
	if (claimed) return current;
	return `${current}<form action="/decision" method="post">
<input type="hidden" name="itemId" value="${escapeHtml(item.id)}">
<label>Note <textarea name="note"></textarea></label>
<p data-note-error></p>
<button type="submit" name="action" value="approve">Approve</button>
<button type="submit" name="action" value="reject">Reject</button>
<button type="submit" name="action" value="tweak">Tweak</button>
</form>`;
}

function article(item: ReviewItem, claimed: boolean): string {
	const refs = `${item.beforeRef ?? "before"} → ${item.afterRef ?? "after"}`;
	const target = item.hasTarget
		? figures(item.shots, "target")
		: "<p>No prototype target for this item.</p>";
	return `<article data-item="${escapeHtml(item.id)}">
<h2>${escapeHtml(item.title)}</h2>
<p>Owner <span data-owner>${escapeHtml(item.owner)}</span></p>
<p data-refs>${escapeHtml(refs)}</p>
<div class="cols">
${column("Before", "before", item, figures(item.shots, "before"))}
${column("After", "after", item, figures(item.shots, "after"))}
${column("Target", "target", item, target)}
</div>
${testsBlock(item)}
${axeBlock(item)}
${picker(item, claimed)}
</article>`;
}

/** Render the review document. The script and stylesheet are separate responses. */
export function renderReview(model: ReviewModel): string {
	const banner = model.httpEngine
		? `<p class="banner">These images came from the HTTP engine. They record page HTML, not a desktop or mobile bitmap.</p>`
		: "";
	const error = model.error ? `<p class="error">${escapeHtml(model.error)}</p>` : "";
	const articles = model.items.map((item) => article(item, model.claimed)).join("");
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Verify ${escapeHtml(model.name)}</title>
<link rel="stylesheet" href="/verify.css">
</head>
<body>
<main id="app">
<h1>Verify ${escapeHtml(model.name)}</h1>
<p data-overall="${escapeHtml(model.status)}" data-all-approved="${model.allApproved ? "true" : "false"}">Status: ${escapeHtml(model.status)}</p>
<p><a href="${escapeHtml(model.stackUrl)}">Open the local stack</a></p>
${banner}${error}${articles}
</main>
<script src="/verify.js"></script>
</body>
</html>
`;
}
