import { die, say } from "../spec/shared";
import { repoRoot, requireInitialized } from "./paths";
import { type AdrRecord, loadRecords, matchCovers } from "./records";

export interface Hit {
	number: string;
	title: string;
	path: string;
	adrPath: string;
}

export function splitJson(args: string[], usage: string): { json: boolean; rest: string[] } {
	const rest = args.filter((arg) => arg !== "--json");
	if (rest.some((arg) => arg.startsWith("--"))) die(`usage: dg-skills adr ${usage}`);
	if (rest.length === 0) die(`usage: dg-skills adr ${usage}`);
	return { json: rest.length !== args.length, rest };
}

export function hitOf(record: AdrRecord): Hit {
	return { number: record.number, title: record.title, path: record.decisionPath, adrPath: record.adrPath };
}

export async function relevantCommand(args: string[]): Promise<number> {
	const root = repoRoot();
	requireInitialized(root);
	const { json, rest } = splitJson(args, "relevant <files...> [--json]");
	const hits = matchCovers(await loadRecords(root), rest, root).map(hitOf);
	if (json) say(`${JSON.stringify(hits)}\n`);
	else for (const hit of hits) say(`${hit.number}\t${hit.title}\t${hit.path}\n`);
	return 0;
}
