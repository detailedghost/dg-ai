import type { CommandEntryWithLimits } from "./limits";

const WHOLE_PLACEHOLDER = /^\{([A-Za-z0-9_]+)\}$/;

export class ArgvSubstitutionError extends Error {}

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
