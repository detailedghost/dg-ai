#!/usr/bin/env bun
/** Raw, gzip, zstd and release-patch size of each compiled dg, checked against lean-budgets.json. */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const ROOT = resolve(import.meta.dir, "..");
export const TARGETS = [
	"linux-x64",
	"linux-x64-baseline",
	"linux-arm64",
	"darwin-x64",
	"darwin-arm64",
	"windows-x64",
	"windows-x64-baseline",
	"windows-arm64",
];
const ASSET = new RegExp(`^dg-(${TARGETS.join("|")})(?:\\.exe)?$`);
const FIELDS = ["rawBytes", "zstdBytes", "patchBytes"] as const;

type Field = (typeof FIELDS)[number];
type Measurement = { rawBytes: number; gzipBytes: number; zstdBytes: number; patchBytes: number | null };
type Budgets = { size: Record<string, Record<Field, number>> };

const USAGE = "usage: bun scripts/lean-size.ts --dist <dir> [--previous <dir>] [--budgets <file>] [--gate] [--json <file>]";

function usageError(detail: string): never {
	console.error(`${detail}\n${USAGE}`);
	process.exit(2);
}

function zstdSize(args: string[]): number {
	const proc = Bun.spawnSync(["zstd", "-19", "-T1", "--long=27", "-q", "-c", ...args], { stderr: "pipe" });
	if (proc.exitCode !== 0) usageError(`zstd ${args.join(" ")} failed: ${proc.stderr.toString().trim() || `exit ${proc.exitCode}`}`);
	return proc.stdout.length;
}

export function measure(file: string, previous?: string): Measurement {
	return {
		rawBytes: statSync(file).size,
		gzipBytes: Bun.gzipSync(readFileSync(file), { level: 9 }).length,
		zstdBytes: zstdSize([file]),
		patchBytes: previous ? zstdSize([`--patch-from=${previous}`, file]) : null,
	};
}

export function binaries(dir: string): Record<string, string> {
	const found: Record<string, string> = {};
	for (const name of readdirSync(dir)) {
		const target = ASSET.exec(name)?.[1];
		if (target && statSync(join(dir, name)).isFile()) found[target] = join(dir, name);
	}
	return found;
}

export function evaluate(budgets: Budgets, measured: Record<string, Measurement>): string[] {
	const failures: string[] = [];
	for (const [target, now] of Object.entries(measured)) {
		const budget = budgets.size[target];
		if (!budget) {
			failures.push(`no budget for ${target}: add size["${target}"] to lean-budgets.json`);
			continue;
		}
		for (const field of FIELDS) {
			const value = now[field];
			if (value !== null && value > budget[field]) {
				failures.push(`${target} ${field} ${value} is over budget ${budget[field]} by ${value - budget[field]}`);
			}
		}
	}
	return failures;
}

function readBudgets(file: string): Budgets {
	const parsed = JSON.parse(readFileSync(file, "utf8")) as Budgets;
	const entries = Object.entries(parsed?.size ?? {});
	const valid = entries.every(([, budget]) => FIELDS.every((field) => Number.isFinite(budget?.[field])));
	if (!parsed?.size || !valid) {
		usageError(`${file}: lean-budgets must be { size: { <target>: { rawBytes, zstdBytes, patchBytes } } } with numbers`);
	}
	return parsed;
}

function main() {
	const { values } = parseArgs({
		args: Bun.argv.slice(2),
		options: {
			dist: { type: "string" },
			previous: { type: "string" },
			budgets: { type: "string", default: join(ROOT, "scripts", "lean-budgets.json") },
			gate: { type: "boolean", default: false },
			json: { type: "string" },
		},
	});
	if (!values.dist) usageError("--dist is required");
	const current = binaries(resolve(values.dist));
	if (Object.keys(current).length === 0) usageError(`${values.dist} has no dg-<target> binary`);
	const prior = values.previous ? binaries(resolve(values.previous)) : {};

	const measured: Record<string, Measurement> = {};
	for (const target of Object.keys(current).sort()) {
		measured[target] = measure(current[target], prior[target]);
		const m = measured[target];
		const patch = m.patchBytes === null ? "n/a" : String(m.patchBytes);
		console.log(`${target}: raw ${m.rawBytes} gzip ${m.gzipBytes} zstd ${m.zstdBytes} patch ${patch}`);
	}
	if (values.json) writeFileSync(values.json, `${JSON.stringify({ size: measured }, null, 2)}\n`);

	const budgets = readBudgets(values.budgets);
	const failures = evaluate(budgets, measured);
	for (const failure of failures) console.error(`lean-size: ${failure}`);
	if (values.gate && failures.length > 0) process.exit(1);
}

if (import.meta.main) main();
