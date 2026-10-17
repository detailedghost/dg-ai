const FLAG_LIKE = /^--[A-Za-z]/;

/** Read the value after a flag; a missing value or another flag throws. */
export function optionalOption(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	if (index === -1) return undefined;
	const value = args[index + 1];
	if (!value || FLAG_LIKE.test(value)) throw new Error(`${name} requires a value`);
	return value;
}

/** Read the value after a flag that must be present. */
export function requireOption(args: string[], name: string): string {
	const value = optionalOption(args, name);
	if (value === undefined) throw new Error(`${name} requires a value`);
	return value;
}
