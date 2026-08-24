export function readEnvNumber(
	env: Record<string, string | undefined>,
	name: string,
	fallback: number,
): number {
	const raw = env[name];
	if (raw === undefined) return fallback;
	const parsed = Number(raw);
	return Number.isFinite(parsed) ? parsed : fallback;
}
