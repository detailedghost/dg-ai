import table from "../../../plugins/dg/skills/assign/references/model-tiers.json" with {
	type: "json",
};

export type Runtime = "claude" | "codex" | "grok";
export type Tier = "haiku" | "sonnet" | "opus" | "fable";

export interface TierRow {
	model: string | null;
	effort: string;
}

export interface TierTable {
	default: Tier;
	fableAgents: string[];
	agents: Record<string, Tier>;
	tiers: Record<Tier, Record<Runtime, TierRow>>;
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
