import table from "../../../plugins/dg/skills/assign/references/model-tiers.json" with {
	type: "json",
};

export const RUNTIMES = ["claude", "codex", "grok"] as const;
export type Runtime = (typeof RUNTIMES)[number];
export type Tier = "haiku" | "sonnet" | "opus" | "fable";

export interface TierRow {
	model: string | null;
	effort: string;
}

export type ProfileName = "balance" | "cheap" | "expensive";
export type Complexity = "low" | "medium" | "high";
export type StageRole = "primary" | "qa-writer" | "qa" | "wave";

export interface ComplexityRule {
	effortStep?: number;
	tier?: Tier;
}

export interface Profile {
	effortStep: number;
	correctionRounds: number;
	complexity?: Partial<Record<Complexity, ComplexityRule>>;
}

export interface TierTable {
	default: Tier;
	fableAgents: string[];
	agents: Record<string, Tier>;
	tiers: Record<Tier, Record<Runtime, TierRow>>;
	profiles: Record<ProfileName, Profile>;
}

export interface ResolvedAgent extends TierRow {
	tier: Tier;
}

export interface ResolveOptions {
	runtime: Runtime;
	effort?: string;
	tier?: Tier;
}

const OVERRIDE_EFFORTS = ["low", "medium", "xhigh"];

export function loadTiers(): TierTable {
	return table as TierTable;
}

/** Fable is legal only for fableAgents; codex and grok run those through the opus row. */
export function resolveAgent(
	name: string,
	options: ResolveOptions,
): ResolvedAgent {
	if (options.effort !== undefined && !OVERRIDE_EFFORTS.includes(options.effort))
		throw new Error(
			`Effort "${options.effort}" is not allowed; use low, medium or xhigh.`,
		);
	const { agents, fableAgents, tiers, default: fallback } = loadTiers();
	const requested =
		options.tier ?? (Object.hasOwn(agents, name) ? agents[name] : fallback);
	if (requested === "fable" && !fableAgents.includes(name))
		throw new Error(
			`Agent "${name}" cannot use the fable tier; only ${fableAgents.join(", ")} can.`,
		);
	const tier =
		requested === "fable" && options.runtime !== "claude" ? "opus" : requested;
	const row = tiers[tier][options.runtime];
	return { model: row.model, effort: options.effort ?? row.effort, tier };
}

export const PROFILE_NAMES = ["balance", "cheap", "expensive"] as const;

export const TIER_ORDER: readonly Tier[] = ["haiku", "sonnet", "opus", "fable"];
const SHIFTED_ROLES: readonly StageRole[] = ["primary", "qa-writer", "qa"];

export interface ProfileStage {
	name: string;
	runtime: Runtime;
	tier: Tier;
	effort: string;
	fixedTier?: boolean;
	fixedEffort?: boolean;
}

function effortLadder(runtime: Runtime): string[] {
	const efforts = TIER_ORDER.map((tier) => loadTiers().tiers[tier][runtime].effort);
	return [...new Set(efforts)];
}

/** Move a stage's tier and effort by its profile; a tier is only ever raised and `security` is never touched. */
export function applyProfile(
	stage: ProfileStage,
	profile: ProfileName,
	complexity: Complexity | undefined,
	role: StageRole,
): { tier: Tier; effort: string } {
	const unchanged = { tier: stage.tier, effort: stage.effort };
	if (stage.name === "security" || role === "wave") return unchanged;
	const { effortStep, complexity: rules } = loadTiers().profiles[profile];
	const rule = role === "primary" && complexity ? rules?.[complexity] : undefined;
	let { tier, effort } = unchanged;
	if (
		rule?.tier &&
		!stage.fixedTier &&
		TIER_ORDER.indexOf(rule.tier) > TIER_ORDER.indexOf(tier)
	) {
		tier = rule.tier;
		if (!stage.fixedEffort) effort = loadTiers().tiers[tier][stage.runtime].effort;
	}
	if (stage.fixedEffort) return { tier, effort };
	const step =
		(SHIFTED_ROLES.includes(role) ? effortStep : 0) + (rule?.effortStep ?? 0);
	const ladder = effortLadder(stage.runtime);
	const at = ladder.indexOf(effort);
	if (at < 0 || step === 0) return { tier, effort };
	const shifted = Math.min(ladder.length - 1, Math.max(0, at + step));
	return { tier, effort: ladder[shifted] as string };
}
