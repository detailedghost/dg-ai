/**
 * DNS-rebinding defense the Origin check does not provide: the Host header
 * must name exactly the loopback authority at the bound port, on every
 * request AND upgrade.
 */
export function isLoopbackHost(
	hostHeader: string | null,
	port: number,
): boolean {
	if (!hostHeader) return false;
	const authority = hostHeader.trim().toLowerCase();
	return authority === `127.0.0.1:${port}` || authority === `localhost:${port}`;
}
