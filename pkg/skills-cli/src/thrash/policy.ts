import { parse } from "yaml";
import { z } from "zod";
import { type Tier, TIERS } from "./constants";

const count = z.number().int().min(0);
const tier = z.enum(TIERS);

const PolicyPhaseSchema = z.strictObject({
	name: z.string().trim().default(""),
	/** Last round this phase covers; unset covers every later round. */
	through: count.optional(),
	/** Tiers with no open earlier finding before a PR may enter this phase. */
	requiresClear: z.array(tier).default([]),
	nits: z.boolean().default(true),
	block: z.partialRecord(tier, count).default({}),
});

const ReviewPolicySchema = z.strictObject({
	maxComments: count.optional(),
	/** Rounds before a still-blocked review suggests a new approach; the default is 3. */
	reconsiderAfter: count.optional(),
	improvements: z.boolean().optional(),
	maxImprovements: count.optional(),
	phases: z.array(PolicyPhaseSchema).min(1, "needs at least one phase"),
});

function formatZodError(error: z.ZodError): string {
	return error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ");
}

export type PolicyPhase = z.output<typeof PolicyPhaseSchema>;
export type ReviewPolicy = z.output<typeof ReviewPolicySchema>;

export function parsePolicy(text: string): ReviewPolicy {
	const result = ReviewPolicySchema.safeParse(parse(text) ?? {});
	if (!result.success)
		throw new Error(`policy: ${formatZodError(result.error)}`);
	return result.data;
}

/** The phase a round falls in; a phase whose required tiers still have open earlier findings is not entered. */
export function selectPhase(
	policy: ReviewPolicy,
	round: number,
	openPrior: Record<Tier, number>,
): PolicyPhase {
	let chosen = policy.phases[0];
	for (const phase of policy.phases) {
		if (phase.requiresClear.some((t) => openPrior[t] > 0)) break;
		chosen = phase;
		if (phase.through === undefined || round <= phase.through) break;
	}
	return chosen;
}
