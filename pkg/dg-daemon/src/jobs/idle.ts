/**
 * The daemon stays alive for its scheduled jobs, not only for its chat sessions —
 * without this an idle TTL would kill the feed nothing is watching.
 */
export function isDaemonIdle(
	activeSessions: number,
	openConnections: number,
	enabledJobs: number,
): boolean {
	return activeSessions === 0 && openConnections === 0 && enabledJobs === 0;
}
