import { getDomain } from "tldts";

/** One allowlist entry: a scheme with a registrable domain, or an exact origin when the host has no domain. */
export type Site = { key: string; name: string; grouped: boolean };

/** Keys a web URL by scheme and registrable domain, with private Public Suffix List entries as their own suffixes. */
export function siteOf(url: string): Site {
	const { protocol, hostname, origin } = new URL(url);
	const domain = hostname.endsWith(".")
		? null
		: getDomain(hostname, { allowPrivateDomains: true, extractHostname: false });
	const key = domain ? `${protocol}//${domain}` : origin;
	return { key, name: protocol === "https:" ? key.slice("https://".length) : key, grouped: domain !== null };
}
