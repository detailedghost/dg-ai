import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { die } from "../spec/shared";
import { splitDocument } from "../utils/frontmatter";
import { README_FILE, refuseSymlink, TOC_FILE } from "./paths";
import { type AdrRecord, loadRecords } from "./records";
import { missingMarkerMessage, TOC_MARKER } from "./templates";

export const NO_RULES = "No agent rules.";

export interface RenderedIndexes {
	toc: string;
	readme: string;
}

function compare(a: string, b: string): number {
	if (a < b) return -1;
	return a > b ? 1 : 0;
}

function pipes(text: string): string {
	return text.replaceAll("|", "\\|");
}

function backslashes(text: string): string {
	return text.replaceAll("\\", "\\\\");
}

function brackets(text: string): string {
	return text.replace(/[[\]]/g, "\\$&");
}

function cell(text: string): string {
	return pipes(backslashes(text));
}

function linkText(text: string): string {
	return brackets(backslashes(text));
}

function codeSpan(text: string): string {
	const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
	const fence = "`".repeat(longest + 1);
	const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
	return `${fence}${pad}${text}${pad}${fence}`;
}

function ruleSummary(record: AdrRecord): string {
	const body = splitDocument(record.decisionText ?? "").body;
	const rule = body.split("\n").find((line) => /^\s*[-*] \S/.test(line));
	return rule === undefined ? NO_RULES : rule.replace(/^\s*[-*] /, "").trim();
}

function renderToc(records: AdrRecord[]): string {
	const topics = [...new Set(records.map((record) => record.topic))].sort(compare);
	return topics
		.map((topic) => {
			const lines = records
				.filter((record) => record.topic === topic)
				.map((record) => `- [${record.number} — ${linkText(record.title)}](${record.key}.md)`);
			return `### ${topic}\n\n${lines.join("\n")}\n`;
		})
		.join("\n");
}

function renderReadme(records: AdrRecord[]): string {
	const rows = records.map(
		(record) =>
			`| ${record.number} | [${brackets(cell(record.title))}](${record.key}.md) | ${cell(record.topic)} | ${cell(ruleSummary(record))} | ${pipes(record.covers.map(codeSpan).join(", "))} |`,
	);
	return ["| Number | Title | Topic | Rule summary | Covers |", "| --- | --- | --- | --- | --- |", ...rows, ""].join("\n");
}

export function renderIndexes(records: AdrRecord[]): RenderedIndexes {
	const sorted = [...records].sort((a, b) => compare(a.number, b.number) || compare(a.key, b.key));
	return { toc: renderToc(sorted), readme: renderReadme(sorted) };
}

export function indexTail(body: string): string {
	return `\n${body === "" ? "" : `\n${body}`}`;
}

function replaceBelowMarker(path: string, body: string): void {
	refuseSymlink(path);
	const text = readFileSync(path, "utf8");
	const at = text.indexOf(TOC_MARKER);
	if (at < 0) die(missingMarkerMessage(path));
	const next = `${text.slice(0, at + TOC_MARKER.length)}${indexTail(body)}`;
	if (next === text) return;
	const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
	try {
		writeFileSync(temp, next, { flag: "wx" });
		renameSync(temp, path);
	} finally {
		rmSync(temp, { force: true });
	}
}

export function writeIndexes(root: string): void {
	const { toc, readme } = renderIndexes(loadRecords(root));
	replaceBelowMarker(join(root, TOC_FILE), toc);
	replaceBelowMarker(join(root, README_FILE), readme);
}
