import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { main } from "../src/assign";

export interface SliceSpec {
	id: number;
	primary?: string;
	complexity?: string;
	model?: string;
	effort?: string;
	qa?: string[];
	proxy?: string;
	dependsOn?: number[];
}

export interface PlanSpec {
	profile?: string;
	slices: SliceSpec[];
}

function sliceYaml(slice: SliceSpec): string {
	const agents = [
		slice.primary === undefined ? "" : `      primary: ${slice.primary}\n`,
		slice.complexity === undefined ? "" : `      complexity: ${slice.complexity}\n`,
		slice.model === undefined ? "" : `      model: ${slice.model}\n`,
		slice.effort === undefined ? "" : `      effort: ${slice.effort}\n`,
		slice.proxy === undefined ? "" : `      proxy: ${slice.proxy}\n`,
		slice.qa === undefined ? "" : `      qa: [${slice.qa.join(", ")}]\n`,
	].join("");
	return `  - id: ${slice.id}
    name: "Slice ${slice.id}"
    depends_on: ${JSON.stringify(slice.dependsOn ?? [])}
    files: ["src/s${slice.id}/**"]
${agents === "" ? "" : `    agents:\n${agents}`}`;
}

export function planText(spec: PlanSpec): string {
	const body = spec.slices
		.map((slice) => `### Slice ${slice.id} — Slice ${slice.id}\n- [ ] Build\n`)
		.join("\n");
	return `---
feature: "Builder fixture"
status: draft
${spec.profile === undefined ? "" : `execution:\n  profile: ${spec.profile}\n`}slices:
${spec.slices.map(sliceYaml).join("\n")}
---

# Builder fixture

## Engineering

${body}`;
}

export function writePlan(dir: string, spec: PlanSpec, name = "plan.md"): string {
	const path = join(dir, name);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, planText(spec));
	return path;
}

export interface AssignRun {
	status: number;
	out: string;
	err: string;
}

export async function runAssign(argv: string[]): Promise<AssignRun> {
	let out = "";
	let err = "";
	const stdout = process.stdout.write.bind(process.stdout);
	const stderr = process.stderr.write.bind(process.stderr);
	process.stdout.write = ((chunk: string | Uint8Array) => {
		out += String(chunk);
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array) => {
		err += String(chunk);
		return true;
	}) as typeof process.stderr.write;
	try {
		const status = await main(argv);
		return { status, out, err };
	} finally {
		process.stdout.write = stdout;
		process.stderr.write = stderr;
	}
}

export interface Stage {
	agentType: string;
	model: string | null;
	effort: string;
}

export interface BakedSlice {
	id: number;
	primary: Stage;
	qa: Stage[];
	proxyFlags?: string;
	dependsOn?: number[];
}

export interface BakedArgs {
	slices: BakedSlice[];
	roles: Record<string, Stage>;
	profile?: string;
	maxCorrectionRounds?: number;
}

export async function resolveArgs(argv: string[]): Promise<BakedArgs> {
	const result = await runAssign(["resolve", ...argv]);
	expectOk(result);
	return JSON.parse(result.out) as BakedArgs;
}

function expectOk(result: AssignRun): void {
	if (result.status !== 0 || result.err !== "")
		throw new Error(`assign resolve failed (${result.status}): ${result.err}`);
}
