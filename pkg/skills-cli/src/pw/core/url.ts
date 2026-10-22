const KNOWN_SCHEME = /^(?:https?|file|about|data|chrome|blob|view-source):/i;
const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i;

export function normalizeUrl(input: string): string {
	if (KNOWN_SCHEME.test(input)) return input;
	return `${LOCAL_HOST.test(input) ? "http" : "https"}://${input}`;
}
