import { bareAgent, isRecord } from "@dg/common";
import { qualifiedAgent } from "../proxy/packaged-personas";
import {
	applyProfile,
	type Complexity,
	loadTiers,
	PROFILE_NAMES,
	type ProfileName,
	type Runtime,
	resolveAgent,
	type StageRole,
	type Tier,
} from "../tiers";

const COMPLEXITIES: readonly string[] = ["low", "medium", "high"];

export interface ResolvedStage {
	agentType: string;
	model: string | null;
	effort: string;
	tier: Tier;
}

export interface SliceStages {
	id: unknown;
	primary: ResolvedStage;
	qa: ResolvedStage[];
	proxyFlags: string;
}

export interface PlanStages {
	profile: ProfileName;
	maxCorrectionRounds: number;
	roles: Record<"qa-writer" | "wave" | "security", ResolvedStage>;
	slices: SliceStages[];
}

interface StageOptions {
	complexity?: Complexity;
	tier?: Tier;
	effort?: string;
}

function stageFor(
	name: string,
	runtime: Runtime,
	profile: ProfileName,
	role: StageRole,
	options: StageOptions = {},
): ResolvedStage {
	const bare = bareAgent(name);
	const { tier, effort, complexity } = options;
	const base = resolveAgent(bare, { runtime, tier, effort });
	const moved = applyProfile(
		{
			name: bare,
			runtime,
			tier: base.tier,
			effort: base.effort,
			fixedTier: tier !== undefined,
			fixedEffort: effort !== undefined,
		},
		profile,
		complexity,
		role,
	);
	const final =
		moved.tier === base.tier
			? base
			: resolveAgent(bare, { runtime, tier: moved.tier });
	return {
		agentType: qualifiedAgent(name),
		model: final.model,
		effort: moved.effort,
		tier: final.tier,
	};
}

function profileOf(data: Record<string, unknown>): ProfileName {
	const execution = isRecord(data.execution) ? data.execution : {};
	const value = execution.profile;
	if (value === undefined || value === null) return "balance";
	if (!PROFILE_NAMES.includes(value as ProfileName))
		throw new Error(
			`execution.profile "${String(value)}" must be one of ${PROFILE_NAMES.join(", ")}`,
		);
	return value as ProfileName;
}

function proxyFlagsFor(
	name: string,
	runtime: Runtime,
	primary: ResolvedStage,
): string {
	const persona = resolveAgent(bareAgent(name), { runtime });
	const row = loadTiers().tiers[primary.tier][runtime];
	return [
		...(primary.tier !== persona.tier ? ["--tier", primary.tier] : []),
		...(primary.effort !== row.effort ? ["--effort", primary.effort] : []),
	].join(" ");
}

function sliceStages(
	slice: Record<string, unknown>,
	runtime: Runtime,
	profile: ProfileName,
): SliceStages {
	const id = String(slice.id);
	const agents = isRecord(slice.agents) ? slice.agents : {};
	const primary = agents.primary;
	if (typeof primary !== "string" || primary === "")
		throw new Error(`slice ${id} has no agents.primary; run /dg:assign`);
	if ("effort" in agents && typeof agents.effort !== "string")
		throw new Error(`slice ${id} has an empty agents.effort`);
	if (
		agents.model !== undefined &&
		(typeof agents.model !== "string" ||
			!Object.hasOwn(loadTiers().tiers, agents.model))
	)
		throw new Error(
			`slice ${id} agents.model "${String(agents.model)}" is not a tier`,
		);
	if (
		agents.complexity !== undefined &&
		!COMPLEXITIES.includes(agents.complexity as string)
	)
		throw new Error(
			`slice ${id} agents.complexity "${String(agents.complexity)}" is not one of ${COMPLEXITIES.join(", ")}`,
		);
	const stage = stageFor(primary, runtime, profile, "primary", {
		complexity: agents.complexity as Complexity | undefined,
		tier: agents.model as Tier | undefined,
		effort: agents.effort as string | undefined,
	});
	const qa = Array.isArray(agents.qa) ? agents.qa.map(String) : [];
	return {
		id: slice.id,
		primary: stage,
		qa: qa.map((name) => stageFor(name, runtime, profile, "qa")),
		proxyFlags: proxyFlagsFor(primary, runtime, stage),
	};
}

/** Resolve every stage of the given slices under one execution profile; reads only the plan data and the tier table. */
export function resolveStages(
	data: Record<string, unknown>,
	members: Record<string, unknown>[],
	runtime: Runtime,
	override?: ProfileName,
): PlanStages {
	const profile = override ?? profileOf(data);
	return {
		profile,
		maxCorrectionRounds: loadTiers().profiles[profile].correctionRounds,
		roles: {
			"qa-writer": stageFor("qa-writer", runtime, profile, "qa-writer"),
			wave: stageFor("wave", runtime, profile, "wave"),
			security: stageFor("security", runtime, profile, "qa"),
		},
		slices: members.map((slice) => sliceStages(slice, runtime, profile)),
	};
}
