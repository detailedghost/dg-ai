const SITE_KEY = /^https?:\/\/[a-z0-9.:[\]-]+$/;

export const PHI_SITES_MAX = 256;

function parseKey(value: string): URL | undefined {
	if (!SITE_KEY.test(value)) return undefined;
	try {
		const url = new URL(value);
		return url.hostname !== "" && url.origin === value ? url : undefined;
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
	return sites.some((site) => {
		const key = parseKey(site);
		return (
			key !== undefined &&
			key.protocol === page.protocol &&
			key.port === page.port &&
			(page.hostname === key.hostname || page.hostname.endsWith(`.${key.hostname}`))
		);
	});
}
