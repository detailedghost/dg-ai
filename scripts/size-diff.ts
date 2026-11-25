import { readFileSync } from "node:fs";
import type { SizeReport } from "../pkg/launcher/build/report";

const readReport = (path: string) => JSON.parse(readFileSync(path, "utf8")) as SizeReport;

export function grownModules(base: SizeReport, head: SizeReport): Array<{ name: string; delta: number; bytes: number }> {
	return Object.entries(head.packages)
		.map(([name, bytes]) => ({ name, bytes, delta: bytes - (base.packages[name] ?? 0) }))
		.filter(({ delta }) => delta > 0)
		.sort((left, right) => right.delta - left.delta);
}

if (import.meta.main) {
	const [basePath, headPath] = Bun.argv.slice(2);
	if (!basePath || !headPath) {
		console.error("usage: bun scripts/size-diff.ts <base-report> <head-report>");
		process.exit(2);
	}
	for (const { name, delta, bytes } of grownModules(readReport(basePath), readReport(headPath))) {
		console.log(`${name} +${delta.toLocaleString("en-US")} B (${bytes.toLocaleString("en-US")} B)`);
	}
}
