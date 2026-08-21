export function fail(message: string): never {
	throw new TypeError(message);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireRecord(
	value: unknown,
	path: string,
): asserts value is Record<string, unknown> {
	if (!isRecord(value)) fail(`${path} must be an object`);
}

export function requireString(
	value: unknown,
	path: string,
	options: { nonEmpty?: boolean } = {},
): asserts value is string {
	if (
		typeof value !== "string" ||
		(options.nonEmpty === true && value.trim().length === 0)
	) {
		fail(`${path} must be ${options.nonEmpty ? "a non-empty " : ""}string`);
	}
}

export function requireFiniteNumber(
	value: unknown,
	path: string,
): asserts value is number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		fail(`${path} must be a finite number`);
	}
}

/** Asserts `value` is one of `allowed`, joining them into the failure message as a quoted list. */
export function requireOneOf<T extends string>(
	value: unknown,
	path: string,
	allowed: readonly T[],
): asserts value is T {
	if (!(allowed as readonly unknown[]).includes(value)) {
		const quoted = allowed.map((item) => `"${item}"`);
		const list =
			quoted.length <= 2
				? quoted.join(" or ")
				: `${quoted.slice(0, -1).join(", ")}, or ${quoted.at(-1)}`;
		fail(`${path} must be ${list}`);
	}
}

export function requireStringArray(
	value: unknown,
	path: string,
	options: { nonEmpty?: boolean } = {},
): asserts value is string[] {
	if (
		!Array.isArray(value) ||
		(options.nonEmpty === true && value.length === 0)
	) {
		fail(`${path} must be ${options.nonEmpty ? "a non-empty " : "an "}array`);
	}

	for (const [index, item] of value.entries()) {
		requireString(item, `${path}[${index}]`);
	}
}

export function requireStringRecord(
	value: unknown,
	path: string,
): asserts value is Record<string, string> {
	requireRecord(value, path);
	for (const [key, item] of Object.entries(value)) {
		requireString(item, `${path}.${key}`);
	}
}
