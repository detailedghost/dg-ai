export function fenceEnv(): Record<string, string> {
	const fence = process.env.DG_PATH_FENCE;
	return fence ? { DG_PATH_FENCE: fence } : {};
}
