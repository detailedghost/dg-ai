import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { die } from "../spec/shared";
import { splitDocument } from "../utils/frontmatter";
import { README_FILE, TOC_FILE } from "./paths";
import { type AdrRecord, loadRecords } from "./records";
import { TOC_MARKER } from "./templates";

export const NO_RULES = "No agent rules.";

export interface RenderedIndexes {
	toc: string;
	readme: string;
}

function cell(text: string): string {
	return text.replaceAll("|", "\\|");
}

function ruleSummary(record: AdrRecord): string {
	const body = splitDocument(record.decisionText ?? "").body;
	const rule = body.split("\n").find((line) => /^\s*[-*] \S/.test(line));
	return rule === undefined ? NO_RULES : rule.replace(/^\s*[-*] /, "").trim();
}

function renderToc(records: AdrRecord[]): string {
	const topics = [...new Set(records.map((record) => record.topic))].sort((a, b) => a.localeCompare(b));
	return topics
		.map((topic) => {
			const lines = records
				.filter((record) => record.topic === topic)
				.map((record) => `- [${record.number} — ${record.title}](${record.key}.md)`);
			return `### ${topic}\n\n${lines.join("\n")}\n`;
		})
		.join("\n");
}

function renderReadme(records: AdrRecord[]): string {
	const rows = records.map(
		(record) =>
			`| ${record.number} | [${cell(record.title)}](${record.key}.md) | ${cell(record.topic)} | ${cell(ruleSummary(record))} | ${cell(record.covers.map((glob) => `\`${glob}\``).join(", "))} |`,
	);
	return ["| Number | Title | Topic | Rule summary | Covers |", "| --- | --- | --- | --- | --- |", ...rows, ""].join("\n");
}

export function renderIndexes(records: AdrRecord[]): RenderedIndexes {
	const sorted = [...records].sort((a, b) => a.number.localeCompare(b.number) || a.key.localeCompare(b.key));
	return { toc: renderToc(sorted), readme: renderReadme(sorted) };
}

export function indexTail(body: string): string {
	return `\n${body === "" ? "" : `\n${body}`}`;
}

function replaceBelowMarker(path: string, body: string): void {
	const text = readFileSync(path, "utf8");
	const at = text.indexOf(TOC_MARKER);
	if (at < 0) die(`${path} has no ${TOC_MARKER} marker. Add the marker line where the index should start.`);
	const next = `${text.slice(0, at + TOC_MARKER.length)}${indexTail(body)}`;
	if (next !== text) writeFileSync(path, next);
}

export async function writeIndexes(root: string): Promise<void> {
	const { toc, readme } = renderIndexes(await loadRecords(root));
	replaceBelowMarker(join(root, TOC_FILE), toc);
	replaceBelowMarker(join(root, README_FILE), readme);
}
