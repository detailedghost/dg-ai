const POSIX_KEYS = ["PATH", "HOME", "LANG", "TZ"];
const WIN32_EXTRA_KEYS = ["SystemRoot", "USERPROFILE", "TEMP", "PATHEXT"];

/** Minimal env for a dispatched child — omitting env entirely hands it the daemon's full process.env, including anything a dotenv loader read. */
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
