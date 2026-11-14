import { BUILT_IN_SCRIPTS, matchesCoverOrigin } from "@dg/common";
import { tapRequestHeaders, type TapHost } from "../request-header-tap";

export const OUTLOOK_SESSION_HEADERS = ["authorization", "x-owa-canary", "x-anchormailbox", "x-owa-sessionid"] as const;
export type OutlookSessionHeaders = Partial<Record<(typeof OUTLOOK_SESSION_HEADERS)[number], string>>;

const OUTLOOK_MATCHES = BUILT_IN_SCRIPTS.find((script) => script.id === "outlook")?.matches ?? [];
const SERVICE_PATH = /^\/owa\/(?:\d+\/)?service\.svc$/;
const VALUE_MAX = 8192;

export const isOutlookOrigin = (origin: string) => matchesCoverOrigin(OUTLOOK_MATCHES, origin);

function pick(headers: Headers): OutlookSessionHeaders {
	const picked: OutlookSessionHeaders = {};
	for (const name of OUTLOOK_SESSION_HEADERS) {
		const value = headers.get(name);
		if (value && value.length <= VALUE_MAX && !/[\r\n]/.test(value)) picked[name] = value;
	}
	return picked;
}

/** Keeps the OWA session headers of same-origin service.svc requests in this closure only, one copy per account endpoint; an account switch drops that endpoint's copy. */
export function installOutlookHeaderObserver(host: TapHost & { location: Pick<Location, "href" | "origin"> }): {
	getHeaders(servicePath: string): OutlookSessionHeaders | undefined;
	dispose(): void;
} {
	const sessions = new Map<string, OutlookSessionHeaders>();
	function observe(headers: Headers, url: URL): void {
		const picked = pick(headers);
		const anchor = picked["x-anchormailbox"];
		let session = sessions.get(url.pathname);
		if (session && anchor !== undefined && anchor !== session["x-anchormailbox"]) {
			sessions.delete(url.pathname);
			session = undefined;
		}
		if (!picked.authorization && !picked["x-owa-canary"]) return;
		sessions.set(url.pathname, session && session["x-anchormailbox"] === anchor ? { ...session, ...picked } : picked);
	}
	const restore = tapRequestHeaders(
		host,
		(parsed) =>
			isOutlookOrigin(host.location.origin) &&
			parsed.origin === host.location.origin &&
			SERVICE_PATH.test(parsed.pathname),
		observe,
	);
	return {
		getHeaders(servicePath) {
			const session = sessions.get(servicePath);
			return session ? { ...session } : undefined;
		},
		dispose() {
			sessions.clear();
			restore();
		},
	};
}
