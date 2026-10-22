import { existsSync, statSync } from "node:fs";
import { buildReport } from "./report";

export const USAGE = `Usage: sniff [path]

Inventory what a repo needs before it can run and print JSON:
{repo, total, gaps, counts, requirements[]}. Secret and config rows carry
names, types and locations only, never values. Scans the working directory
when no path is given; arguments after the path are ignored.

Exit status: 0 on success, 1 when the path is missing or not a directory.
`;

/** Print the inventory for argv[0] (default "."); legacy root errors exit 1 with no stdout. */
export function main(argv: string[]): number {
	const target = argv[0] ?? ".";
	if (target === "--help" || target === "-h") {
		process.stdout.write(USAGE);
		return 0;
	}
	if (!existsSync(target)) {
		process.stderr.write(`sniff: no such path: ${target}\n`);
		return 1;
	}
	if (!statSync(target).isDirectory()) {
		process.stderr.write(`sniff: not a directory: ${target}\n`);
		return 1;
	}
	process.stdout.write(`${JSON.stringify(buildReport(target), null, 2)}\n`);
	return 0;
}
