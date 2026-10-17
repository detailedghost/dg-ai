const REJECTION_WORDS = [
	"unknown",
	"invalid",
	"unsupported",
	"not found",
	"not available",
	"unrecognized",
	"not support",
];
const EFFORT_WORDS = ["effort", "thinking", "variant", "reasoning"];

const REJECTED_EFFORT = new RegExp(
	`(?:${REJECTION_WORDS.join("|")})\\s+(?:\\w+\\s+){0,2}(?:${EFFORT_WORDS.join("|")})`,
);

/**
 * Narrow heuristic for classifying a failed backend invocation as a
 * model-rejection or effort/reasoning-level-rejection error, based on
 * keyword co-occurrence in the combined stdout+stderr text. This is not
 * a general error taxonomy — it only covers the model/effort-rejection
 * case backends are known to surface.
 */
export function classifyFailure(combinedOutput: string): "model" | "effort" | "other" {
	const text = combinedOutput.toLowerCase();
	const hasRejection = REJECTION_WORDS.some((word) => text.includes(word));

	if (REJECTED_EFFORT.test(text)) return "effort";
	if (hasRejection && text.includes("model")) return "model";
	if (hasRejection && EFFORT_WORDS.some((word) => text.includes(word))) {
		return "effort";
	}
	return "other";
}
