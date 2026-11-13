import { getDomain } from "tldts";

/** One allowlist entry: a scheme and registrable domain, plus any non-default port, or an exact origin when the host has no domain. */
export type Site = { key: string; name: string; grouped: boolean };

/** Keys a web URL by scheme, registrable domain and non-default port, with private Public Suffix List entries as their own suffixes. */
export function siteOf(url: string): Site {
	const { protocol, hostname, origin, port } = new URL(url);
	const domain = hostname.endsWith(".")
		? null
		: getDomain(hostname, { allowPrivateDomains: true, extractHostname: false });
	const key = domain ? `${protocol}//${domain}${port ? `:${port}` : ""}` : origin;
	return { key, name: protocol === "https:" ? key.slice("https://".length) : key, grouped: domain !== null };
}
