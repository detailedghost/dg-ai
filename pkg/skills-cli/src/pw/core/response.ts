import { randomBytes } from "node:crypto";
import path from "node:path";
import type { Locator, Page } from "playwright-core";
import type { ConsoleEntry } from "./events";
import { ensurePrivateDir, writePrivate } from "./files";

export type PageHeader = {
	url: string;
	title: string;
	errors: number;
	warnings: number;
};

export type SnapshotLink = { path: string; bytes: number; lines: number };

export type Parts = {
	error?: string;
	result?: string;
	code?: string;
	page?: PageHeader;
	snapshot?: SnapshotLink;
	events?: ConsoleEntry[];
	notices?: string[];
	modal?: string[];
};

export type RenderOptions = { raw: boolean; codegen: boolean };

export const DEFAULT_DEPTH = 6;
const REF_RESTORE_DEPTH = 1;
const EVENT_PREVIEW = 3;
const EVENT_TEXT_MAX = 200;

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const snapshotLine = (link: SnapshotLink): string =>
	`[Snapshot](${link.path}) ${formatBytes(link.bytes)}, ${link.lines} ${link.lines === 1 ? "line" : "lines"}`;

function pageLines(header: PageHeader): string[] {
	const lines = [`- Page URL: ${header.url}`];
	if (header.title) lines.push(`- Page Title: ${header.title}`);
	if (header.errors > 0 || header.warnings > 0) {
		lines.push(
			`- Console: ${header.errors} errors, ${header.warnings} warnings`,
		);
	}
	return lines;
}

export function eventLines(
	entries: ConsoleEntry[],
	notices: string[] = [],
): string[] {
	if (entries.length === 0) return [...notices];
	const counts = new Map<string, number>();
	for (const entry of entries)
		counts.set(entry.type, (counts.get(entry.type) ?? 0) + 1);
	const breakdown = [...counts]
		.map(([type, count]) => `${count} ${type}`)
		.join(", ");
	const lines = [`- Console: ${entries.length} new (${breakdown})`];
	for (const entry of entries.slice(0, EVENT_PREVIEW)) {
		const text = (entry.text.split("\n")[0] ?? "").slice(0, EVENT_TEXT_MAX);
		lines.push(`  - [${entry.type}] ${text}`);
	}
	if (entries.length > EVENT_PREVIEW)
		lines.push(`  - ... ${entries.length - EVENT_PREVIEW} more`);
	return [...lines, ...notices];
}

export function render(parts: Parts, options: RenderOptions): string {
	if (options.raw)
		return [parts.error, parts.result].filter(Boolean).join("\n");
	const sections: [string, string[]][] = [
		["Error", parts.error ? [parts.error] : []],
		["Result", parts.result ? [parts.result] : []],
		[
			"Ran Playwright code",
			options.codegen && parts.code ? ["```js", parts.code, "```"] : [],
		],
		["Page", parts.page ? pageLines(parts.page) : []],
		["Snapshot", parts.snapshot ? [snapshotLine(parts.snapshot)] : []],
		["Events", eventLines(parts.events ?? [], parts.notices)],
		["Modal state", parts.modal ?? []],
	];
	return sections
		.filter(([, lines]) => lines.length > 0)
		.map(([title, lines]) => [`### ${title}`, ...lines].join("\n"))
		.join("\n");
}

export function timestampedName(prefix: string, ext: string): string {
	return `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}.${ext}`;
}

export function resolveOutput(outputDir: string, name: string): string {
	const file = path.isAbsolute(name) ? name : path.join(outputDir, name);
	ensurePrivateDir(path.dirname(file));
	return file;
}

export async function pageHeader(
	page: Page,
	totals: { errors: number; warnings: number },
): Promise<PageHeader> {
	const title = await page.title().catch(() => "");
	return { url: page.url(), title, ...totals };
}

export type SnapshotOptions = {
	depth?: number;
	filename?: string;
	scope?: Pick<Locator, "ariaSnapshot">;
};

async function restoreRefs(page: Page): Promise<void> {
	await page.ariaSnapshot({ mode: "ai", depth: REF_RESTORE_DEPTH });
}

export async function writeSnapshot(
	page: Page,
	outputDir: string,
	options: SnapshotOptions,
): Promise<SnapshotLink> {
	const body = await (options.scope ?? page).ariaSnapshot({
		mode: "ai",
		depth: options.depth,
	});
	if (options.scope) await restoreRefs(page);
	const file = resolveOutput(
		outputDir,
		options.filename ?? timestampedName("page", "yml"),
	);
	writePrivate(file, `${body}\n`);
	return {
		path: file,
		bytes: Buffer.byteLength(body) + 1,
		lines: body.split("\n").length,
	};
}
