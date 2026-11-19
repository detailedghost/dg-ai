import { die, say } from "../spec/shared";
import { type Hit, hitOf, splitJson } from "./args";
import { repoRoot, requireInitialized } from "./paths";
import { type AdrRecord, loadRecords } from "./records";

const TITLE_WEIGHT = 3;

function occurrences(text: string, word: string): number {
	return text.split(word).length - 1;
}

function scoreOf(record: AdrRecord, words: string[]): number {
	const title = record.title.toLowerCase();
	const body = `${record.adrText ?? ""}\n${record.decisionText ?? ""}`.toLowerCase();
	return words.reduce((sum, word) => sum + TITLE_WEIGHT * occurrences(title, word) + occurrences(body, word), 0);
}

export function findCommand(args: string[]): number {
	const { json, rest } = splitJson(args, "find <words...> [--json]");
	const words = rest.map((word) => word.toLowerCase()).filter((word) => word !== "");
	if (words.length === 0) die("usage: dg-skills adr find <words...> [--json]");
	const root = repoRoot();
	requireInitialized(root);
	const hits: Array<Hit & { score: number }> = loadRecords(root)
		.map((record) => ({ ...hitOf(record), score: scoreOf(record, words) }))
		.filter((hit) => hit.score > 0)
		.sort((a, b) => b.score - a.score || a.number.localeCompare(b.number));
	if (json) say(`${JSON.stringify(hits)}\n`);
	else for (const hit of hits) say(`${hit.number}\t${hit.title}\t${hit.path}\n`);
	return 0;
}
