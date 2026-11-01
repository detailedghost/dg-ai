import { UsageError } from "./args";

const KNOWN_SCHEME = /^(?:https?|file|about|data|chrome|blob|view-source):/i;
const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i;
const CDP_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]"]);

export function normalizeUrl(input: string): string {
	if (KNOWN_SCHEME.test(input)) return input;
	return `${LOCAL_HOST.test(input) ? "http" : "https"}://${input}`;
}

export function parseCdpUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new UsageError(`Invalid CDP URL '${value}'`);
	}
	if (!CDP_PROTOCOLS.has(url.protocol)) {
		throw new UsageError(`CDP URL must be http(s) or ws(s), got '${value}'`);
	}
	if (!LOOPBACK_HOSTS.has(url.hostname)) {
		throw new UsageError(
			`CDP URL must use a loopback host (127.0.0.1 or [::1]), got '${value}'`,
		);
	}
	const port = Number(url.port);
	if (url.port === "" || !Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new UsageError(
			`CDP URL needs a port from 1 to 65535, got '${value}'`,
		);
	}
	return value;
}
