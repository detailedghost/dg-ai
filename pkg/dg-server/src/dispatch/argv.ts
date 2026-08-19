import type { CommandEntryWithLimits } from "./limits";

const WHOLE_PLACEHOLDER = /^\{([A-Za-z0-9_]+)\}$/;

export class ArgvSubstitutionError extends Error {}

/**
 * Whole-element param substitution: a `{name}` placeholder occupies one full
 * argv slot, never spliced into or out of a larger element. A dash-prefixed
 * value is refused outright (no per-entry opt-in is wired on the wire yet),
 * and a literal `--` is inserted before the first substituted element so a
 * value the target WOULD accept as an option is still read as an operand.
 */
export function substituteArgv(
	entry: CommandEntryWithLimits,
	params: Record<string, unknown>,
): string[] {
	const declared = new Set(entry.params.map((param) => param.name));
	const result: string[] = [];
	let insertedSeparator = false;

	for (const element of entry.argv) {
		const match = WHOLE_PLACEHOLDER.exec(element);
		if (!match || !declared.has(match[1])) {
			result.push(element);
			continue;
		}
		const name = match[1];
		const raw = params[name];
		if (typeof raw !== "string") {
			throw new ArgvSubstitutionError(
				`param "${name}" was not supplied as a string`,
			);
		}
		if (raw.startsWith("-")) {
			throw new ArgvSubstitutionError(
				`param "${name}" begins with a dash — refusing to risk option injection`,
			);
		}
		if (!insertedSeparator) {
			result.push("--");
			insertedSeparator = true;
		}
		result.push(raw);
	}

	return result;
}
