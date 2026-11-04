import { isRecord } from "@dg/common";
import { resolveStages } from "../assign/stages";
import { PROFILE_NAMES, type ProfileName, type Runtime, type Tier } from "../tiers";
import { frontmatterOf, parseYaml } from "./frontmatter";
import {
	die,
	flagValue,
	needFile,
	PROGRAM,
	readText,
	say,
	usageError,
} from "./shared";

const RUNTIMES: readonly Runtime[] = ["claude", "codex", "grok"];
const USAGE = `usage: ${PROGRAM} estimate <plan.md> [--profile ${PROFILE_NAMES.join("|")}] [--runtime ${RUNTIMES.join("|")}]\n`;
const TIERS: readonly Tier[] = ["haiku", "sonnet", "opus", "fable"];

function estimateLine(
	data: Record<string, unknown>,
	slices: Record<string, unknown>[],
	runtime: Runtime,
	profile: ProfileName,
): string {
	const stages = resolveStages(data, slices, runtime, profile);
	const { "qa-writer": writer, wave } = stages.roles;
	const counts = new Map<Tier, number>();
	const count = (tier: Tier) => counts.set(tier, (counts.get(tier) ?? 0) + 1);
	for (const slice of stages.slices) {
		for (const tier of [
			writer.tier,
			slice.primary.tier,
			writer.tier,
			wave.tier,
			wave.tier,
			...slice.qa.map((stage) => stage.tier),
		])
			count(tier);
	}
	const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
	const byTier = TIERS.map((tier) => `${counts.get(tier) ?? 0} ${tier}`).join(", ");
	return `${profile}: ${slices.length} slices · ${total} agent calls (${byTier}) · up to ${stages.maxCorrectionRounds} correction rounds`;
}

export async function estimateCommand(args: string[]): Promise<number> {
	let plan = "";
	let profile: ProfileName | undefined;
	let runtime: Runtime = "claude";
	for (let i = 0; i < args.length; ) {
		const arg = args[i] as string;
		if (arg === "-h" || arg === "--help") {
			say(USAGE);
			return 0;
		}
		if (arg === "--profile") {
			const value = flagValue(args, i, arg);
			if (!PROFILE_NAMES.includes(value as ProfileName))
				die(`--profile must be one of ${PROFILE_NAMES.join(", ")}`);
			profile = value as ProfileName;
			i += 2;
		} else if (arg === "--runtime") {
			const value = flagValue(args, i, arg);
			if (!RUNTIMES.includes(value as Runtime))
				die(`--runtime must be one of ${RUNTIMES.join(", ")}`);
			runtime = value as Runtime;
			i += 2;
		} else if (arg.startsWith("-")) die(`unknown estimate flag: ${arg}`);
		else if (plan === "") {
			plan = arg;
			i += 1;
		} else die("estimate takes a single <plan.md> argument");
	}
	if (plan === "") return usageError("estimate <plan.md> [--profile p] [--runtime r]");
	needFile(plan);
	const parsed = parseYaml(frontmatterOf(await readText(plan)));
	if (!parsed.ok || !isRecord(parsed.value) || !Array.isArray(parsed.value.slices))
		throw new Error(`no slices[] in the frontmatter: ${plan}`);
	const data = parsed.value;
	const slices = data.slices as unknown[];
	const bad = slices.findIndex((slice) => !isRecord(slice));
	if (bad !== -1)
		throw new Error(`slices[${bad}] is not an object: ${plan}`);
	const members = slices.filter(isRecord);
	const lines = (profile === undefined ? PROFILE_NAMES : [profile]).map(
		(name) => `${estimateLine(data, members, runtime, name)}\n`,
	);
	say(lines.join(""));
	return 0;
}
