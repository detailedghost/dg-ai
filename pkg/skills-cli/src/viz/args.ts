export const hasFlag = (args: string[], flag: string): boolean =>
	args.includes(flag);

/** Value after a flag, unless it is missing or another flag. */
export function flagValue(args: string[], flag: string): string | undefined {
	const i = args.indexOf(flag);
	if (i < 0) return undefined;
	const v = args[i + 1];
	return v !== undefined && !v.startsWith("-") ? v : undefined;
}
