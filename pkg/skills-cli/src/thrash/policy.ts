import { parse } from "yaml";
import { isTier, TIERS, type Tier } from "./core";

export interface PolicyPhase {
	name: string;
	/** Last round this phase covers; unset covers every later round. */
	through?: number;
	/** Tiers with no open earlier finding before a PR may enter this phase. */
	requiresClear: Tier[];
	nits: boolean;
	block: Partial<Record<Tier, number>>;
}

export interface ReviewPolicy {
	maxComments?: number;
	phases: PolicyPhase[];
}

function positiveInt(raw: unknown, where: string): number | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (!Number.isInteger(raw) || (raw as number) < 0)
		throw new Error(`${where} must be a whole number of 0 or more`);
	return raw as number;
}

function tierList(raw: unknown, where: string): Tier[] {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw)) throw new Error(`${where} must be a list of tiers`);
	return raw.map((t) => {
		if (!isTier(t))
			throw new Error(
				`${where}: unknown tier "${String(t)}" (expected one of ${TIERS.join(", ")})`,
			);
		return t;
	});
}

function blockLimits(
	raw: unknown,
	where: string,
): Partial<Record<Tier, number>> {
	if (raw === undefined || raw === null) return {};
	if (typeof raw !== "object" || Array.isArray(raw))
		throw new Error(`${where} must map tiers to limits`);
	const limits: Partial<Record<Tier, number>> = {};
	for (const [tier, value] of Object.entries(raw)) {
		if (!isTier(tier))
			throw new Error(
				`${where}: unknown tier "${tier}" (expected one of ${TIERS.join(", ")})`,
			);
		limits[tier] = positiveInt(value, `${where}.${tier}`);
	}
	return limits;
}

export function parsePolicy(text: string): ReviewPolicy {
	const raw = parse(text) as Record<string, unknown> | null;
	if (!raw || typeof raw !== "object")
		throw new Error("policy must be a YAML mapping");
	const phasesRaw = raw.phases;
	if (!Array.isArray(phasesRaw) || phasesRaw.length === 0)
		throw new Error("policy needs a non-empty phases list");
	const phases = phasesRaw.map((p: Record<string, unknown>, i) => {
		const where = `phases[${i}]`;
		if (!p || typeof p !== "object")
			throw new Error(`${where} must be a mapping`);
		return {
			name: typeof p.name === "string" ? p.name.trim() : "",
			through: positiveInt(p.through, `${where}.through`),
			requiresClear: tierList(p.requiresClear, `${where}.requiresClear`),
			nits: p.nits !== false,
			block: blockLimits(p.block, `${where}.block`),
		};
	});
	return { maxComments: positiveInt(raw.maxComments, "maxComments"), phases };
}

/** The phase a round falls in; a phase whose required tiers still have open earlier findings is not entered. */
export function selectPhase(
	policy: ReviewPolicy,
	round: number,
	openPrior: Record<Tier, number>,
): PolicyPhase {
	let chosen = policy.phases[0];
	for (const phase of policy.phases) {
		if (phase.requiresClear.some((tier) => openPrior[tier] > 0)) break;
		chosen = phase;
		if (phase.through === undefined || round <= phase.through) break;
	}
	return chosen;
}
