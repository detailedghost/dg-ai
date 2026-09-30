/** The daemon stays alive for its scheduled jobs and supervised services, not only for its chat sessions. */
export function isDaemonIdle(
	activeSessions: number,
	openConnections: number,
	enabledJobs: number,
	runningServices: number,
): boolean {
	return (
		activeSessions === 0 &&
		openConnections === 0 &&
		enabledJobs === 0 &&
		runningServices === 0
	);
}
