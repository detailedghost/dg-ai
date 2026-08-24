const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];

export function isLoopbackHost(
	hostHeader: string | null,
	port: number,
): boolean {
	if (!hostHeader) return false;
	const authority = hostHeader.trim().toLowerCase();
	return LOOPBACK_HOSTS.some((host) => authority === `${host}:${port}`);
}
