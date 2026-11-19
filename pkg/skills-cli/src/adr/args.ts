import { die } from "../spec/shared";
import type { AdrRecord } from "./records";

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
