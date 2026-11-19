import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { frontOf } from "../utils/frontmatter";
import { DEFAULT_LEVEL, isLevel, type Level } from "./levels";
import { ADR_DIR, DECISION_DIR, README_FILE, recordFiles } from "./paths";

export interface AdrRecord {
	number: string;
	key: string;
	title: string;
	status: string;
	date: string;
	topic: string;
	level: string;
	covers: string[];
	adrPath: string;
	decisionPath: string;
	adrText: string | null;
	decisionText: string | null;
}

function readOrNull(path: string): string | null {
	return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function headerLine(text: string, key: string): string {
	const match = text.match(new RegExp(`^${key}:[ \\t]*(.*)$`, "m"));
	return match?.[1]?.trim() ?? "";
}

function coversOf(text: string | null): string[] {
	if (text === null) return [];
	const { covers } = frontOf(text);
	return Array.isArray(covers) ? covers.filter((entry): entry is string => typeof entry === "string") : [];
}

export function loadRecords(root: string): AdrRecord[] {
	const keys = new Set(
		[ADR_DIR, DECISION_DIR].flatMap((dir) => recordFiles(root, dir).map((name) => name.slice(0, -3))),
	);
	return [...keys].sort().map((key) => {
		const adrPath = join(root, ADR_DIR, `${key}.md`);
		const decisionPath = join(root, DECISION_DIR, `${key}.md`);
		const adrText = readOrNull(adrPath);
		const decisionText = readOrNull(decisionPath);
		const text = adrText ?? "";
		return {
			number: key.slice(0, 4),
			key,
			title: text.match(/^# (.+)$/m)?.[1]?.trim() ?? key.slice(5),
			status: headerLine(text, "Status"),
			date: headerLine(text, "Date"),
			topic: headerLine(text, "Topic"),
			level: headerLine(text, "Level"),
			covers: coversOf(decisionText),
			adrPath,
			decisionPath,
			adrText,
			decisionText,
		};
	});
}

export function repoLevel(root: string): Level {
	const text = readOrNull(join(root, README_FILE));
	if (text === null) return DEFAULT_LEVEL;
	const { level } = frontOf(text);
	return typeof level === "string" && isLevel(level) ? level : DEFAULT_LEVEL;
}

export function normalizePath(path: string, root: string): string {
	return relative(root, resolve(root, path.replaceAll("\\", "/"))).replaceAll("\\", "/");
}

export function matchCovers(records: AdrRecord[], paths: string[], root: string): AdrRecord[] {
	const normalized = paths.map((path) => normalizePath(path, root));
	return records.filter((record) =>
		record.covers.some((pattern) => {
			const glob = new Bun.Glob(pattern);
			return normalized.some((path) => glob.match(path));
		}),
	);
}
