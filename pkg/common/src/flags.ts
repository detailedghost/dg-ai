import { z } from "zod";

/** A zod schema for one text value, with the phrase an error uses to say what it expected. */
export interface Flag<T> {
	schema: z.ZodType<T, string>;
	expected: string;
}

export function wholeNumber(min: number, max?: number): Flag<number> {
	const number = z.number().int().min(min);
	return {
		expected:
			max === undefined
				? `a whole number of ${min} or more`
				: `a whole number from ${min} to ${max}`,
		schema: z
			.string()
			.regex(/^-?\d+$/)
			.transform(Number)
			.pipe(max === undefined ? number : number.max(max)),
	};
}

export function oneOf<const T extends string>(values: readonly T[]): Flag<T> {
	return { expected: `one of ${values.join(", ")}`, schema: z.enum(values as [T, ...T[]]) };
}

export const text: Flag<string> = { expected: "text", schema: z.string() };

export const trueOrFalse: Flag<boolean> = {
	expected: "true or false",
	schema: z.enum(["true", "false"]).transform((v) => v === "true"),
};

/** Parses a raw value, or throws `<name> must be <expected>, got "<raw>"`. */
export function parseFlag<T>(flag: Flag<T>, raw: string, name: string): T {
	const result = flag.schema.safeParse(raw.trim());
	if (!result.success)
		throw new Error(`${name} must be ${flag.expected}, got "${raw}"`);
	return result.data;
}

/** Same as parseFlag, but an absent value is undefined. */
export function parseOptionalFlag<T>(
	flag: Flag<T>,
	raw: string | undefined,
	name: string,
): T | undefined {
	return raw === undefined ? undefined : parseFlag(flag, raw, name);
}

/** Reads an environment value; empty and unset both count as absent, as GitHub Actions passes an unset input as "". */
export function readEnvFlag<T>(
	env: Record<string, string | undefined>,
	key: string,
	flag: Flag<T>,
	name: string,
): T | undefined {
	const raw = env[key]?.trim() ?? "";
	return raw === "" ? undefined : parseFlag(flag, raw, name);
}
