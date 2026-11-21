import { die, say } from "../spec/shared";
import { hitOf, splitJson } from "./args";
import { repoRoot, requireInitialized } from "./paths";
import { loadRecords, matchCovers } from "./records";

export function relevantCommand(args: string[]): number {
	const usage = "relevant <files...> [--json]";
	const { json, rest } = splitJson(args, usage);
	const files = rest.filter((file) => file.trim() !== "");
	if (files.length === 0) die(`usage: dg adr ${usage}`);
	const root = repoRoot();
	requireInitialized(root);
	const hits = matchCovers(loadRecords(root), files, root).map(hitOf);
	if (json) say(`${JSON.stringify(hits)}\n`);
	else for (const hit of hits) say(`${hit.number}\t${hit.title}\t${hit.path}\n`);
	return 0;
}
