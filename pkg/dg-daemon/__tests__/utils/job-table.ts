export const asContinuous = (
	table: Record<string, unknown>,
): Record<string, unknown> =>
	Object.fromEntries(
		Object.entries(table).map(([name, entry]) => [
			name,
			typeof entry === "object" && entry !== null && !Array.isArray(entry)
				? { continuous: true, ...entry }
				: entry,
		]),
	);
