import { appendFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { escapeRegExp } from "@dg/common";
import { scratchDir } from "@dg/common/node";
import { schemaAsset } from "./schema";
import {
	abspath,
	die,
	flagValue,
	isFile,
	localStamp,
	needFile,
	PROGRAM,
	readText,
	records,
	say,
	stripNewlines,
	usageError,
	utcMinute,
	warn,
} from "./shared";

const AGENT_TIMEOUT_MS = 600_000;
const DEFAULT_AGENTS = "reviewer,qa-perf,security";
const LEGACY_SCRATCH_TOOL = "spec-cli";

const SECTION_NAMES: Record<string, string> = {
	reviewer: "Reviewer",
	"qa-perf": "QA-Perf",
	security: "Security",
	"qa-devops": "QA-DevOps",
};

interface PhasePlan {
	template: string;
	placeholder: string;
}

function phasePlan(phase: string): PhasePlan {
	switch (phase) {
		case "3b":
			return { template: "roundtable.md", placeholder: "<plan_path>" };
		case "5":
			return { template: "spec-review.md", placeholder: "<spec_path>" };
		default:
			return die(`invalid phase: ${phase} (expected 3b or 5)`);
	}
}

function renderPrompt(
	template: string,
	section: string,
	placeholder: string,
	target: string,
): string {
	const heading = new RegExp(`^## ${escapeRegExp(section)}\\s*$`, "i");
	const prompt: string[] = [];
	let inSection = false;
	for (const line of records(template)) {
		if (line.startsWith("## ")) {
			if (heading.test(line)) inSection = true;
			else if (inSection) break;
		} else if (inSection && line.startsWith("> "))
			prompt.push(line.slice(2).replaceAll(placeholder, () => target));
	}
	return stripNewlines(prompt.join("\n"));
}

async function runAgent(
	agent: string,
	prompt: string,
	outDir: string,
	dryRun: boolean,
): Promise<void> {
	const out = `${outDir}/${agent}.md`;
	const preview = `claude -p --agent ${agent} --permission-mode plan --output-format text`;
	if (dryRun) {
		writeFileSync(out, `[DRY] ${preview} <<<\n${prompt}\n>>>\n`);
		return;
	}
	const err = `${outDir}/${agent}.err`;
	let status: number;
	try {
		const child = Bun.spawn(
			[
				"claude",
				"-p",
				"--agent",
				agent,
				"--permission-mode",
				"plan",
				"--output-format",
				"text",
				prompt,
			],
			{
				stdin: "ignore",
				stdout: Bun.file(out),
				stderr: Bun.file(err),
				timeout: AGENT_TIMEOUT_MS,
			},
		);
		status = (await child.exited) || 0;
		if (child.signalCode !== null) status = 124;
	} catch (error) {
		status = 127;
		writeFileSync(out, "");
		writeFileSync(
			err,
			`${PROGRAM}: claude: ${error instanceof Error ? error.message : String(error)}\n`,
		);
	}
	if (status !== 0) appendFileSync(out, `[FAILED exit=${status}]\n`);
}

function detectPhase(text: string): string {
	return records(text).some((line) =>
		/^## (Engineering|Testing|Acceptance)/.test(line),
	)
		? "5"
		: "3b";
}

export async function roundtableCommand(args: string[]): Promise<number> {
	const [file, ...flags] = args;
	if (file === undefined)
		return usageError(
			"roundtable <file> [--phase N] [--agents a,b,c] [--append] [--dry-run]",
		);
	needFile(file);
	const target = abspath(file);
	let phase = "";
	let agents = "";
	let append = false;
	let dryRun = false;
	for (let i = 0; i < flags.length; ) {
		const flag = flags[i] as string;
		if (flag === "--phase") {
			phase = flagValue(flags, i, flag);
			i += 2;
		} else if (flag === "--agents") {
			agents = flagValue(flags, i, flag);
			i += 2;
		} else if (flag === "--append") {
			append = true;
			i += 1;
		} else if (flag === "--dry-run") {
			dryRun = true;
			i += 1;
		} else die(`unknown roundtable flag: ${flag}`);
	}
	if (phase === "") phase = detectPhase(await readText(target));
	if (phase === "2") {
		warn(
			"warning: --phase 2 is deprecated; use --phase 3b (prose roundtable moved post-approval)",
		);
		phase = "3b";
	}
	const plan = phasePlan(phase);
	const templatePath = schemaAsset(`templates/${plan.template}`);
	if (!isFile(templatePath)) die(`file not found: ${templatePath}`);
	const template = await readText(templatePath);
	if (agents === "") agents = DEFAULT_AGENTS;

	const scratchRoot = scratchDir(LEGACY_SCRATCH_TOOL, { cwdScope: false });
	const outDir = `${scratchRoot}/roundtable/${basename(target, ".md")}-p${phase}-${localStamp()}`;
	mkdirSync(outDir, { recursive: true });

	const runs: Promise<void>[] = [];
	for (const agent of agents.split(",").filter((name) => name !== "")) {
		const prompt = renderPrompt(
			template,
			SECTION_NAMES[agent] ?? agent,
			plan.placeholder,
			target,
		);
		if (prompt === "") {
			writeFileSync(
				`${outDir}/${agent}.md`,
				`[SKIP] no template section for agent=${agent} in ${templatePath}\n`,
			);
			continue;
		}
		runs.push(runAgent(agent, prompt, outDir, dryRun));
	}
	await Promise.all(runs);

	let consolidated = `## Roundtable Findings (phase ${phase}, ${utcMinute()})\n\n`;
	for (const name of readdirSync(outDir)
		.filter((entry) => entry.endsWith(".md"))
		.sort())
		consolidated += `### ${name.slice(0, -3)}\n\n${await readText(`${outDir}/${name}`)}\n`;
	consolidated += `_Outputs: ${outDir}_\n`;

	if (append) {
		appendFileSync(target, `\n${consolidated}`);
		process.stderr.write(`appended to ${target}\n`);
	} else say(consolidated);
	return 0;
}

export async function reviewCommand(args: string[]): Promise<number> {
	const [spec, ...rest] = args;
	if (spec === undefined)
		return usageError("review <spec> [extra roundtable flags]");
	return roundtableCommand([spec, "--phase", "5", "--append", ...rest]);
}
