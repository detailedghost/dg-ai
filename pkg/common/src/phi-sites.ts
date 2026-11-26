const SITE_KEY = /^https?:\/\/[a-z0-9.:[\]-]+$/;

export const PHI_SITES_MAX = 256;

function hasValidLabels(hostname: string): boolean {
	return hostname.startsWith("[") || hostname.split(".").every((label) => label !== "" && !label.startsWith("-") && !label.endsWith("-"));
}

function parseKey(value: string): URL | undefined {
	if (!SITE_KEY.test(value)) return undefined;
	try {
		const url = new URL(value);
		return hasValidLabels(url.hostname) && url.port !== "0" && url.origin === value ? url : undefined;
	} catch {
		return undefined;
	}
}

export function isSiteKey(value: string): boolean {
	return parseKey(value) !== undefined;
}

/** True when `url` is on a listed site or any subdomain of it, on the same scheme and port. */
export function isPhiSite(url: string, sites: readonly string[]): boolean {
	if (sites.length === 0) return false;
	let page: URL;
	try {
		page = new URL(url);
	} catch {
		return false;
	}
	const host = page.hostname.endsWith(".") ? page.hostname.slice(0, -1) : page.hostname;
	return sites.some((site) => {
		const key = parseKey(site);
		return (
			key !== undefined &&
			key.protocol === page.protocol &&
			key.port === page.port &&
			(host === key.hostname || host.endsWith(`.${key.hostname}`))
		);
	});
}
