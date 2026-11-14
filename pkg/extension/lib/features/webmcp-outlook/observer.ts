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

/** Keeps the OWA session headers of same-origin service.svc requests in this closure only; an account switch drops the copy. */
export function installOutlookHeaderObserver(host: TapHost & { location: Pick<Location, "href" | "origin"> }): {
	getHeaders(): OutlookSessionHeaders | undefined;
	dispose(): void;
} {
	let session: OutlookSessionHeaders | undefined;
	function observe(headers: Headers): void {
		const picked = pick(headers);
		if (!picked.authorization && !picked["x-owa-canary"]) return;
		session =
			session && session["x-anchormailbox"] === picked["x-anchormailbox"] ? { ...session, ...picked } : picked;
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
		getHeaders: () => (session ? { ...session } : undefined),
		dispose() {
			session = undefined;
			restore();
		},
	};
}
