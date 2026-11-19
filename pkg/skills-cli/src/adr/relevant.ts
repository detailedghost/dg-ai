import { say } from "../spec/shared";
import { hitOf, splitJson } from "./args";
import { repoRoot, requireInitialized } from "./paths";
import { loadRecords, matchCovers } from "./records";

export function relevantCommand(args: string[]): number {
	const root = repoRoot();
	requireInitialized(root);
	const { json, rest } = splitJson(args, "relevant <files...> [--json]");
	const hits = matchCovers(loadRecords(root), rest, root).map(hitOf);
	if (json) say(`${JSON.stringify(hits)}\n`);
	else for (const hit of hits) say(`${hit.number}\t${hit.title}\t${hit.path}\n`);
	return 0;
}
