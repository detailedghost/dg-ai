import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ALIASES, flatRows, GROUPS, resolveRoute } from "../pkg/dg/src/flat";

export const GENERATED_DIR = join(import.meta.dir, "..", "native", "src", "Dg.Routing", "Generated", "obj");

export interface RouteRecord {
	word: string;
	program: string;
	command: string[];
}

export function routeRecords(): RouteRecord[] {
	const words = [...flatRows().map((row) => row.name), ...Object.keys(GROUPS), ...Object.keys(ALIASES)];
	return words.flatMap((word) => {
		const route = resolveRoute(word);
		return route ? [{ word, program: route.program, command: [...route.command] }] : [];
	});
}

const literal = (text: string): string => JSON.stringify(text);

export function routeTableSource(records: readonly RouteRecord[]): string {
	const rows = records.map(
		({ word, program, command }) =>
			`        [${literal(word)}] = new(${literal(program)}, [${command.map(literal).join(", ")}]),`,
	);
	return [
		"using System.Collections.Frozen;",
		"",
		"namespace Dg.Routing;",
		"",
		"internal static class RouteTable",
		"{",
		"    internal static readonly FrozenDictionary<string, FlatTarget> Flat = new Dictionary<string, FlatTarget>",
		"    {",
		...rows,
		"    }.ToFrozenDictionary(StringComparer.Ordinal);",
		"}",
		"",
	].join("\n");
}

if (import.meta.main) {
	const records = routeRecords();
	mkdirSync(GENERATED_DIR, { recursive: true });
	const source = join(GENERATED_DIR, "RouteTable.g.cs");
	const json = join(GENERATED_DIR, "routes.json");
	writeFileSync(source, routeTableSource(records));
	writeFileSync(json, `${JSON.stringify(records, null, "\t")}\n`);
	console.log(`wrote ${source} (${records.length} routes)`);
}
