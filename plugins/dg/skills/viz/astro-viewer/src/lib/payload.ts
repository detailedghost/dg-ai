// Shared answer predicates — empty string, missing, and "tbd" all count as unanswered.
export function isEmpty(v: unknown): boolean {
	return !v || String(v).trim() === "" || String(v).toLowerCase() === "tbd";
}

export function isAnswered(v: unknown): boolean {
	return !isEmpty(v);
}
