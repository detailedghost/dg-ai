export function numberArg(value: string, name: string): number {
	const parsed = Number(value);
	if (value.trim() === "" || !Number.isFinite(parsed)) throw new Error(`Invalid ${name} '${value}': use a number`);
	return parsed;
}
