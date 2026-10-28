import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bareAgent, isRecord } from "@dg/common";
import { qualifiedAgent } from "../proxy/packaged-personas";
import { frontmatterOf, parseYaml } from "../spec/frontmatter";
import { sliceLayers } from "../spec/lint-waves";
import {
	sectionLines,
	type SliceBlock,
	sliceBlocks,
} from "../spec/sections";
import {
	abspath,
	needFile,
	readText,
	records,
	SpecError,
} from "../spec/shared";
import { resolveSkillAsset } from "../utils/skill-assets";
import {
	loadTiers,
	type ResolvedAgent,
	resolveAgent,
	type Runtime,
	type Tier,
} from "../tiers";

const PROGRAM = "dg-skills assign";
const RUNTIMES: readonly Runtime[] = ["claude", "codex", "grok"];
const USAGE =
	"usage: dg-skills assign resolve <plan.md> --layer N [--runtime claude|codex|grok] [--scratch <file>] [--wave <scratch-dir>]\n";
const REMINDER =
	"Workflow return contract: you run unattended under a forced schema. Map intent into the return object instead of acting on it: [SPEC]/[TEST] ambiguity goes in deferrals[], [NOTE-DURABLE]/[NOTE-SCRATCH] go in notes.durable[]/notes.scratch[], every file you touch goes in the changed-file list. Never call AskUserQuestion unless this template says so.";
const TEMPLATE_FILES = {
	red: "qa-writer-red.md",
	yellow: "slice-engineering.md",
	green: "qa-writer-green.md",
	wave: "wave.md",
	correction: "correction.md",
	proxy: "slice-engineering-proxy.md",
} as const;
const ROLES = ["qa-writer", "wave", "security"] as const;

interface Stage {
	agentType: string;
	model: string | null;
	effort: string;
}

interface Options {
	plan: string;
	layer: number;
	runtime: Runtime;
	scratch: string;
	wave: string;
}

interface Pin {
	tier?: Tier;
	effort?: string;
}

class Refusal extends Error {}

function parseOptions(argv: string[]): Options | undefined {
	const [verb, ...rest] = argv;
	if (verb !== "resolve") return undefined;
	const values = new Map<string, string>();
	let plan = "";
	for (let i = 0; i < rest.length; i += 1) {
		const arg = rest[i] as string;
		if (arg.startsWith("--")) {
			const value = rest[i + 1];
			if (value === undefined) throw new SpecError(`${arg} requires a value`);
			values.set(arg, value);
			i += 1;
		} else if (plan === "") plan = arg;
		else throw new SpecError(`unexpected argument: ${arg}`);
	}
	const layer = values.get("--layer");
	if (plan === "" || layer === undefined || !/^\d+$/.test(layer)) return undefined;
	const runtime = (values.get("--runtime") ?? "claude") as Runtime;
	if (!RUNTIMES.includes(runtime))
		throw new SpecError(`--runtime must be one of ${RUNTIMES.join(", ")}`);
	return {
		plan,
		layer: Number(layer),
		runtime,
		scratch: values.get("--scratch") ?? "",
		wave: values.get("--wave") ?? "",
	};
}

function stageFor(
	name: string,
	runtime: Runtime,
	override: { effort?: string; tier?: Tier } = {},
): Stage {
	let resolved: ResolvedAgent;
	try {
		resolved = resolveAgent(bareAgent(name), { runtime, ...override });
	} catch (error) {
		throw new Refusal(error instanceof Error ? error.message : String(error));
	}
	return {
		agentType: qualifiedAgent(name),
		model: resolved.model,
		effort: resolved.effort,
	};
}

function executionPin(lines: string[]): Pin {
	const pin: Pin = {};
	for (const line of sectionLines(lines, "Execution")) {
		const match = /^\s*(?:[-*]\s*)?(model|effort):\s*[`"']?([A-Za-z]+)/.exec(line);
		if (match?.[1] === "model") {
			const tier = match[2] as Tier;
			if (!Object.hasOwn(loadTiers().tiers, tier))
				throw new Refusal(`## Execution model "${match[2]}" is not a tier`);
			pin.tier = tier;
		} else if (match) pin.effort = match[2];
	}
	return pin;
}

const isTesting = (block: SliceBlock) => block.section.startsWith("## Testing");

function briefOf(blocks: SliceBlock[]): string {
	return blocks
		.filter((block) => !isTesting(block))
		.map((block) => [block.section, "", ...block.lines].join("\n"))
		.join("\n\n");
}

function testingCriteria(blocks: SliceBlock[]): string {
	const flat = blocks.find(isTesting);
	if (flat) return flat.lines.join("\n");
	const own = blocks.flatMap((block) => block.lines);
	const at = own.findIndex((line) => line.startsWith("#### Testing Criteria"));
	if (at < 0) return "";
	const end = own.findIndex(
		(line, i) => i > at && /^#{1,4} /.test(line),
	);
	return own.slice(at, end < 0 ? undefined : end).join("\n");
}

function agentsOf(slice: Record<string, unknown>): Record<string, unknown> {
	return isRecord(slice.agents) ? slice.agents : {};
}

function templatesFor(proxied: boolean): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, file] of Object.entries(TEMPLATE_FILES)) {
		if (key === "proxy" && !proxied) continue;
		const path = resolveSkillAsset("sdlc", `references/templates/${file}`);
		out[key] = `${REMINDER}\n\n${readFileSync(path, "utf8")}`;
	}
	return out;
}

function sorted(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sorted);
	if (!isRecord(value)) return value;
	return Object.fromEntries(
		Object.keys(value)
			.sort()
			.map((key) => [key, sorted(value[key])]),
	);
}

async function waveArgs(options: Options): Promise<Record<string, unknown>> {
	needFile(options.plan);
	const text = await readText(options.plan);
	const parsed = parseYaml(frontmatterOf(text));
	if (!parsed.ok || !isRecord(parsed.value) || !Array.isArray(parsed.value.slices))
		throw new Refusal(`no slices[] in the frontmatter: ${options.plan}`);
	const data = parsed.value;
	const layers = sliceLayers(data);
	const lines = records(text);
	const pin = executionPin(lines);
	const members = (data.slices as unknown[])
		.filter(isRecord)
		.filter((slice) => layers.get(String(slice.id)) === options.layer);
	if (members.length === 0)
		throw new Refusal(`layer ${options.layer} holds no slices`);
	const slices = members.map((slice) => {
		const agents = agentsOf(slice);
		const primary = agents.primary;
		if (typeof primary !== "string" || primary === "")
			throw new Refusal(
				`slice ${String(slice.id)} has no agents.primary; run /dg:assign`,
			);
		const effort =
			pin.effort ??
			(typeof agents.effort === "string" ? agents.effort : undefined);
		const number = String(slice.id);
		const blocks = /^\d+$/.test(number) ? sliceBlocks(lines, number) : [];
		const qa = Array.isArray(agents.qa) ? agents.qa.map(String) : [];
		return {
			id: slice.id,
			name: typeof slice.name === "string" ? slice.name : "",
			primary: stageFor(primary, options.runtime, { effort, tier: pin.tier }),
			qa: qa.map((name) => stageFor(name, options.runtime)),
			...(typeof agents.proxy === "string" ? { proxyBackend: agents.proxy } : {}),
			brief: briefOf(blocks),
			testingCriteria: testingCriteria(blocks),
		};
	});
	return sorted({
		slices,
		roles: Object.fromEntries(
			ROLES.map((role) => [
				role,
				role === "qa-writer"
					? stageFor(
							role,
							options.runtime,
							pin.tier === "fable" ? { effort: pin.effort } : pin,
						)
					: stageFor(role, options.runtime),
			]),
		),
		specPath: abspath(options.plan),
		scratchPath: options.scratch,
		templates: templatesFor(slices.some((slice) => "proxyBackend" in slice)),
	}) as Record<string, unknown>;
}

function bake(runner: string, args: Record<string, unknown>): string {
	const end = runner.indexOf("\n};\n", runner.indexOf("export const meta"));
	const at = end + "\n};\n".length;
	return `${runner.slice(0, at)}const WAVE_ARGS = ${JSON.stringify(args, null, 2)};\n${runner.slice(at)}`;
}

export async function main(argv: string[]): Promise<number> {
	try {
		const options = parseOptions(argv);
		if (!options) {
			process.stdout.write(USAGE);
			return 2;
		}
		const args = await waveArgs(options);
		if (options.wave === "") {
			process.stdout.write(`${JSON.stringify(args, null, 2)}\n`);
			return 0;
		}
		const runner = readFileSync(
			resolveSkillAsset("sdlc", "references/templates/slice-wave.workflow.js"),
			"utf8",
		);
		mkdirSync(options.wave, { recursive: true });
		const file = join(options.wave, `slice-wave.layer${options.layer}.workflow.js`);
		writeFileSync(file, bake(runner, args));
		process.stdout.write(`${file}\n`);
		return 0;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`${PROGRAM}: ${message}\n`);
		if (error instanceof SpecError) return error.status;
		return 1;
	}
}
