import { normalizeKey } from "@dg/common";
import { type InputRequest, type InputVerb, VERBS, validate } from "@dg/common/pw-ext-verbs/input";

export class InputUsageError extends Error {}

const ARGUMENT = {
	check: "target",
	uncheck: "target",
	type: "text",
	keydown: "key",
	keyup: "key",
} as const satisfies Record<InputVerb, string>;

export function isInputVerb(verb: string): verb is InputVerb {
	return (VERBS as readonly string[]).includes(verb);
}

/** Builds the validated relay request for one input verb from its CLI arguments. */
export function parse(input: { verb: string; args: readonly string[]; tab?: number; submit?: boolean }): InputRequest {
	const { verb, args, tab, submit } = input;
	if (!isInputVerb(verb)) throw new InputUsageError(`Unknown pw --ext input verb: ${verb}.`);
	if (args.length !== 1) throw new InputUsageError(`pw --ext ${verb} takes <${ARGUMENT[verb]}>.`);
	if (submit && verb !== "type") throw new InputUsageError("--submit works only with pw --ext type.");
	const [value] = args as [string];
	const field = ARGUMENT[verb];
	try {
		return validate({
			verb,
			[field]: field === "key" ? normalizeKey(value) : value,
			...(submit ? { submit: true } : {}),
			...(tab === undefined ? {} : { tabId: tab }),
		});
	} catch (error) {
		throw new InputUsageError(error instanceof Error ? error.message : String(error));
	}
}
