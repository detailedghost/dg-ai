const SECRET_MARKS = [
	"ghp_",
	"gho_",
	"ghs_",
	"github_pat_",
	"glpat-",
	"xoxb-",
	"xoxa-",
	"xoxp-",
	"xoxs-",
	"xoxr-",
	"AKIA",
];

const FORBIDDEN_HEADERS = new Set([
	"authorization",
	"cookie",
	"proxy-authorization",
	"set-cookie",
]);

/** True when a header or cookie value looks like a live credential. */
export function looksSecret(value: string): boolean {
	if (/bearer\s+\S{8,}/i.test(value)) return true;
	if (/\bsk-[A-Za-z0-9]{20,}/.test(value)) return true;
	return SECRET_MARKS.some((mark) => value.includes(mark));
}

/** Accept only a loopback http(s) URL with no userinfo. */
export function assertLoopbackUrl(raw: string, label: string): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error(`${label} is not a URL`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:")
		throw new Error(`${label} must use http or https`);
	const host = url.hostname.replace(/^\[|\]$/g, "");
	if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1")
		throw new Error(`${label} must stay on loopback`);
	if (url.username !== "" || url.password !== "")
		throw new Error(`${label} must not carry userinfo`);
	return url.toString();
}

/** Reject credential headers. Seed roles use a dedicated header or cookie. */
export function assertSeedHeader(name: string, value: string): void {
	if (FORBIDDEN_HEADERS.has(name.toLowerCase()))
		throw new Error(`header ${name} is not allowed; use a seed header or cookie`);
	if (looksSecret(value) || looksSecret(name))
		throw new Error(`header ${name} looks like a secret`);
}

/** Reject a cookie whose name or value looks like a live credential. */
export function assertSeedCookie(name: string, value: string): void {
	if (name.trim() === "" || value.includes(";") || value.includes("\n"))
		throw new Error("cookie name and value must be a single seed token");
	if (looksSecret(name) || looksSecret(value))
		throw new Error(`cookie ${name} looks like a secret`);
}
