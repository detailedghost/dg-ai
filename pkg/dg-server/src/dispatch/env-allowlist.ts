const POSIX_KEYS = ["PATH", "HOME", "LANG", "TZ"];
const WIN32_EXTRA_KEYS = ["SystemRoot", "USERPROFILE", "TEMP", "PATHEXT"];

export function buildAllowedEnv(): Record<string, string> {
	const keys =
		process.platform === "win32"
			? [...POSIX_KEYS, ...WIN32_EXTRA_KEYS]
			: POSIX_KEYS;
	const env: Record<string, string> = {};
	for (const key of keys) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	return env;
}
