export const MIN_BUN = "1.4.0";

export function bunVersionError(version: string): string | null {
	const [major = 0, minor = 0] = version.split(".").map((part) => Number.parseInt(part, 10) || 0);
	const [minMajor = 0, minMinor = 0] = MIN_BUN.split(".").map(Number);
	const ok = major > minMajor || (major === minMajor && minor >= minMinor);
	return ok ? null : `pw needs Bun >= ${MIN_BUN} (found ${version}). Run: bun upgrade`;
}
