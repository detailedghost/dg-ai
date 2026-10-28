import { bareAgent } from "@dg/common";
import { resolveAgent, type Runtime, type Tier } from "../tiers";
import { resolveSlicePrimary } from "./spec-persona";

const TIER_RUNTIMES: Record<string, Runtime> = { codex: "codex", grok: "grok" };
const TIER_NAMES: readonly string[] = ["haiku", "sonnet", "opus", "fable"];

export interface TierInput {
	backend: string;
	tier?: string;
	subagent?: string;
	spec?: string;
	slice?: string;
	model?: string;
	effort?: string;
}

export function parseTier(value: string | undefined): Tier | undefined {
	if (value === undefined) return undefined;
	if (!TIER_NAMES.includes(value))
		throw new Error(`--tier must be one of ${TIER_NAMES.join(", ")}; got "${value}"`);
	return value as Tier;
}

/** Fill the model and effort the caller left unset from the tier table; explicit values always win. */
export function applyTier(input: TierInput): { model?: string; effort?: string } {
	const { model, effort } = input;
	const tier = parseTier(input.tier);
	const runtime = TIER_RUNTIMES[input.backend];
	if (!runtime) return { model, effort };
	const persona =
		input.subagent ??
		(input.spec && input.slice ? resolveSlicePrimary(input.spec, input.slice) : null);
	const row = resolveAgent(persona ? bareAgent(persona) : "", { runtime, tier });
	return { model: model ?? row.model ?? undefined, effort: effort ?? row.effort };
}
