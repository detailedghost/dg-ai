import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sharedOptions } from "./options";

export interface SizeReport {
	totalBytes: number;
	packages: Record<string, number>;
}

interface Metafile {
	outputs: Record<string, { inputs: Record<string, { bytesInOutput: number }> }>;
}

const AWS_SCOPES = new Set(["@aws-sdk", "@smithy", "@aws-crypto"]);
const FIRST_PARTY = "dg";

export function writeBuildInfo(lib: string, info: { version: string; sha: string }): void {
	writeFileSync(join(lib, "build.json"), `${JSON.stringify(info)}\n`);
}

function packageOf(path: string): string {
	const marker = path.lastIndexOf("node_modules/");
	if (marker === -1) return FIRST_PARTY;
	const [first, second] = path.slice(marker + "node_modules/".length).split("/");
	if (!first?.startsWith("@")) return first ?? FIRST_PARTY;
	return AWS_SCOPES.has(first) ? "aws-sdk" : `${first}/${second}`;
}

export function sizeReportFrom(metafile: Metafile): SizeReport {
	const bytes = new Map<string, number>();
	for (const output of Object.values(metafile.outputs)) {
		for (const [path, { bytesInOutput }] of Object.entries(output.inputs)) {
			const name = packageOf(path.replaceAll("\\", "/"));
			bytes.set(name, (bytes.get(name) ?? 0) + bytesInOutput);
		}
	}
	const rows = [...bytes].sort(([, left], [, right]) => right - left);
	return { totalBytes: rows.reduce((sum, [, size]) => sum + size, 0), packages: Object.fromEntries(rows) };
}

export function parseReportFlag(argv: string[]): string | undefined {
	for (const [index, arg] of argv.entries()) {
		if (arg === "--report") return argv[index + 1];
		if (arg.startsWith("--report=")) return arg.slice("--report=".length);
	}
	return undefined;
}

/** Bundles the launcher in memory and writes the per-package size report to `file`. */
export async function buildReport(file: string): Promise<SizeReport> {
	const { options } = await sharedOptions();
	const result = await Bun.build({ ...options, metafile: true, naming: { chunk: "chunks/[name]-[hash].js" } });
	if (!result.success || !result.metafile) throw new AggregateError(result.logs, "Size report build failed.");
	const report = sizeReportFrom(result.metafile);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
	return report;
}

if (import.meta.main) {
	const file = parseReportFlag(Bun.argv.slice(2));
	if (!file) throw new Error("usage: bun pkg/launcher/build/report.ts --report <file>");
	await buildReport(file);
}
