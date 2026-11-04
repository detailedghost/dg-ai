import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { isRecord } from "@dg/common";
import { shellCommand } from "@dg/common/node";
import { frontmatterOf, parseYaml } from "../spec/frontmatter";
import { branchSubjects, sliceCommitted } from "../spec/git";
import { sliceFiles, sliceLayers } from "../spec/lint-waves";
import { type SliceBlock, sliceBlocks } from "../spec/sections";
import {
	abspath,
	needFile,
	readText,
	records,
	SpecError,
} from "../spec/shared";
import { RUNTIMES, type Runtime } from "../tiers";
import { resolveSkillAsset } from "../utils/skill-assets";
import { type ResolvedStage, resolveStages } from "./stages";

const PROGRAM = "dg-skills assign";
const USAGE =
	"usage: dg-skills assign resolve <plan.md> [--layer N | --slices <id,id>] [--runtime claude|codex|grok] [--scratch <file>] [--wave <scratch-dir>] [--cwd <dir>]\n";
const REMINDER =
	"Workflow return contract: you run unattended under a forced schema. Map intent into the return object instead of acting on it: [SPEC]/[TEST] ambiguity that needs a decision goes in deferrals[] as SPEC or TEST; a change the orchestrator should see but need not decide (for example an assertion you changed) goes in deferrals[] as CONFIRM, which never blocks; do not edit the spec or report unticked checkboxes, the orchestrator ticks them; [NOTE-DURABLE]/[NOTE-SCRATCH] go in notes.durable[]/notes.scratch[], every file you touch goes in the changed-file list. Never call AskUserQuestion: it cannot pause a workflow, and this rule overrides any template that says to ask or pause. Put every unresolved question in deferrals[] and stop that part of the work.";
const TEMPLATE_FILES = {
	red: "qa-writer-red.md",
	yellow: "slice-engineering.md",
	green: "qa-writer-green.md",
	wave: "wave.md",
	correction: "correction.md",
	proxy: "slice-engineering-proxy.md",
} as const;
const ENVELOPE_HEAD =
	"Slice {SLICE_ID} context\nSpec: {SPEC_PATH}\nScratchpad: {SCRATCH_PATH}\n\nSlice brief:\n{SLICE_BRIEF}\n\nTesting criteria:\n{TESTING_CRITERIA}";
const ENVELOPE_TAIL: Record<string, string> = {
	yellow: "\n\nTest files:\n{CHANGED_FILES}",
	green: "\n\nImplementation files:\n{CHANGED_FILES}",
	wave: "\n\nFiles to review:\n{CHANGED_FILES}",
	correction:
		"\n\nChanged files:\n{CHANGED_FILES}\n\nFindings to address:\n{FINDINGS}",
};
const ROLES = ["qa-writer", "wave", "security"] as const;

interface Selection {
	layer?: number;
	slices?: string[];
}

interface Options {
	plan: string;
	selection: Selection;
	runtime: Runtime;
	scratch: string;
	wave: string;
	cwd: string;
}

interface Chosen {
	members: Record<string, unknown>[];
	name: string;
}

class Refusal extends Error {}

function gitTopLevel(): string {
	const result = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"]);
	const top = result.stdout.toString().trim();
	return result.exitCode === 0 && top !== "" ? top : process.cwd();
}

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
	const ids = values.get("--slices");
	if (layer !== undefined && ids !== undefined)
		throw new SpecError("--layer and --slices cannot be combined");
	if (plan === "") return undefined;
	if (layer !== undefined && !/^\d+$/.test(layer)) return undefined;
	if (ids !== undefined && !/^[^,\s]+(,[^,\s]+)*$/.test(ids)) return undefined;
	const runtime = (values.get("--runtime") ?? "claude") as Runtime;
	if (!RUNTIMES.includes(runtime))
		throw new SpecError(`--runtime must be one of ${RUNTIMES.join(", ")}`);
	return {
		plan,
		selection: {
			...(layer === undefined ? {} : { layer: Number(layer) }),
			...(ids === undefined ? {} : { slices: ids.split(",") }),
		},
		runtime,
		scratch: values.get("--scratch") ?? "",
		wave: values.get("--wave") ?? "",
		cwd: values.get("--cwd") ?? gitTopLevel(),
	};
}

const isTesting = (block: SliceBlock) => block.section.startsWith("## Testing");

const CRITERIA_HEADING = "#### Testing Criteria";

function withoutCriteria(lines: string[]): string[] {
	const at = lines.findIndex((line) => line.startsWith(CRITERIA_HEADING));
	if (at < 0) return lines;
	const end = lines.findIndex((line, i) => i > at && /^#{1,4} /.test(line));
	return [...lines.slice(0, at), ...(end < 0 ? [] : lines.slice(end))];
}

function briefOf(blocks: SliceBlock[]): string {
	return blocks
		.filter((block) => !isTesting(block))
		.map((block) =>
			[block.section, "", ...withoutCriteria(block.lines)].join("\n"),
		)
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

function templatesFor(proxied: boolean, cwd: string): Record<string, string> {
	const directive = `Working directory: ${cwd}. Run every command from it and edit files only under it, never in another checkout. You may read the spec, the scratchpad and referenced assets wherever they live.`;
	const out: Record<string, string> = {};
	for (const [key, file] of Object.entries(TEMPLATE_FILES)) {
		if (key === "proxy" && !proxied) continue;
		const path = resolveSkillAsset("sdlc", `references/templates/${file}`);
		const envelope =
			key === "proxy" ? "" : `${ENVELOPE_HEAD}${ENVELOPE_TAIL[key] ?? ""}\n\n`;
		const body = readFileSync(path, "utf8").replaceAll(
			"<repo working directory>",
			() => shellCommand([cwd]),
		);
		out[key] = `${REMINDER}\n\n${directive}\n\n${envelope}${body}`;
	}
	return out;
}

function skillInstructions(names: string[]): string {
	return names
		.map((name) => {
			const text = readFileSync(resolveSkillAsset(name, "SKILL.md"), "utf8");
			return `## Skill instructions: ${name}\n\n${text.replace(/^---\n[\s\S]*?\n---\n/, "").trim()}`;
		})
		.join("\n\n");
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

const bakedStage = ({ agentType, model, effort }: ResolvedStage) => ({
	agentType,
	model,
	effort,
});

async function choose(
	options: Options,
	slices: Record<string, unknown>[],
	layers: Map<string, number>,
): Promise<Chosen | null> {
	const { layer, slices: ids } = options.selection;
	if (layer !== undefined) {
		const members = slices.filter(
			(slice) => layers.get(String(slice.id)) === layer,
		);
		if (members.length === 0)
			throw new Refusal(`layer ${layer} holds no slices`);
		return { members, name: `layer${layer}` };
	}
	if (ids !== undefined) {
		for (const id of ids)
			if (!slices.some((slice) => String(slice.id) === id))
				throw new Refusal(`slice ${id} is not in ${options.plan}`);
		const members = slices.filter((slice) => ids.includes(String(slice.id)));
		return { members, name: `s${members.map((slice) => safeId(slice.id)).join("-")}` };
	}
	const subjects = await branchSubjects(options.cwd);
	const members = slices.filter(
		(slice) => !sliceCommitted(subjects, String(slice.id)),
	);
	return members.length === 0 ? null : { members, name: "pending" };
}

function safeId(id: unknown): string {
	return String(id).replace(/[^A-Za-z0-9_-]/g, "_");
}

async function waveArgs(
	options: Options,
): Promise<{ args: Record<string, unknown>; name: string } | null> {
	needFile(options.plan);
	const text = await readText(options.plan);
	const parsed = parseYaml(frontmatterOf(text));
	if (!parsed.ok || !isRecord(parsed.value) || !Array.isArray(parsed.value.slices))
		throw new Refusal(`no slices[] in the frontmatter: ${options.plan}`);
	const data = parsed.value;
	const layers = sliceLayers(data);
	const ownership = sliceFiles(data);
	const lines = records(text);
	const chosen = await choose(
		options,
		(data.slices as unknown[]).filter(isRecord),
		layers,
	);
	if (chosen === null) return null;
	const { members } = chosen;
	const selected = new Set(members.map((slice) => String(slice.id)));
	const stages = resolveStages(data, members, options.runtime);
	const slices = members.map((slice, index) => {
		const agents = agentsOf(slice);
		const resolved = stages.slices[index] as (typeof stages.slices)[number];
		const number = String(slice.id);
		const blocks = sliceBlocks(lines, number);
		const proxied = typeof agents.proxy === "string";
		const proxySkills =
			proxied && Array.isArray(agents.proxy_skills)
				? agents.proxy_skills.map(String)
				: [];
		const brief = briefOf(blocks);
		const dependsOn = (
			Array.isArray(slice.depends_on) ? slice.depends_on : []
		).filter((dep) => selected.has(String(dep)));
		return {
			id: slice.id,
			name: typeof slice.name === "string" ? slice.name : "",
			...(Array.isArray(slice.files) && slice.files.length > 0
				? { files: ownership.get(number) ?? slice.files.map(String) }
				: {}),
			dependsOn,
			primary: bakedStage(resolved.primary),
			qa: resolved.qa.map(bakedStage),
			...(typeof agents.proxy === "string" ? { proxyBackend: agents.proxy } : {}),
			...(proxySkills.length > 0 ? { proxySkills } : {}),
			...(proxied && resolved.proxyFlags !== "" ? { proxyFlags: resolved.proxyFlags } : {}),
			brief:
				proxySkills.length > 0
					? `${brief}\n\n${skillInstructions(proxySkills)}`
					: brief,
			testingCriteria: testingCriteria(blocks),
		};
	});
	const args = sorted({
		slices,
		profile: stages.profile,
		maxCorrectionRounds: stages.maxCorrectionRounds,
		roles: Object.fromEntries(
			ROLES.map((role) => [role, bakedStage(stages.roles[role])]),
		),
		specPath: abspath(options.plan),
		scratchPath: options.scratch,
		cwd: options.cwd,
		templates: templatesFor(
			slices.some((slice) => "proxyBackend" in slice),
			options.cwd,
		),
	}) as Record<string, unknown>;
	return { args, name: chosen.name };
}

function bake(runner: string, args: Record<string, unknown>): string {
	const end = runner.indexOf("\n};\n", runner.indexOf("export const meta"));
	const at = end + "\n};\n".length;
	return `${runner.slice(0, at)}const WAVE_ARGS = ${JSON.stringify(args, null, 2)};\n${runner.slice(at)}`;
}

export async function main(argv: string[]): Promise<number> {
	if (argv.includes("--help") || argv.includes("-h")) {
		process.stdout.write(USAGE);
		return 0;
	}
	try {
		const options = parseOptions(argv);
		if (!options) {
			process.stdout.write(USAGE);
			return 2;
		}
		const wave = await waveArgs(options);
		if (wave === null) {
			process.stdout.write("no pending slices\n");
			return 0;
		}
		const { args, name } = wave;
		if (options.wave === "") {
			process.stdout.write(`${JSON.stringify(args, null, 2)}\n`);
			return 0;
		}
		const runner = readFileSync(
			resolveSkillAsset("sdlc", "references/templates/slice-wave.workflow.js"),
			"utf8",
		);
		const file = join(options.wave, `slice-wave.${name}.workflow.js`);
		if (!resolve(file).startsWith(resolve(options.wave) + sep)) {
			process.stderr.write(`${PROGRAM}: runner path escapes ${options.wave}\n`);
			return 1;
		}
		mkdirSync(options.wave, { recursive: true });
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
