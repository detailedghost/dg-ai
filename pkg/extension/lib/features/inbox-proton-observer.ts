import {
	isProtonMailOrigin,
	type ProtonSessionHeaders,
} from "../../../inbox/src/protonmail/page-session";
import { tapRequestHeaders, type TapHost } from "./request-header-tap";

export { isProtonMailOrigin, type ProtonSessionHeaders };

/** Observes trusted mail fetch/XHR headers in memory, invalidates account switches, and returns a restoration handle. */
export function installProtonSessionObserver(host: TapHost & { location: Pick<Location, "href" | "origin" | "pathname"> }): {
	getHeaders(): ProtonSessionHeaders | undefined;
	dispose(): void;
} {
	let session: ProtonSessionHeaders | undefined;
	let account: string | undefined;
	const accountKey = () =>
		/^\/u\/([^/]+)(?:\/|$)/.exec(host.location.pathname)?.[1];
	function observe(headers: Headers): void {
		const uid = headers.get("x-pm-uid");
		if (!uid || uid.length > 1024) return;
		session = {
			uid,
			...(headers.get("x-pm-appversion")
				? { appVersion: headers.get("x-pm-appversion")!.slice(0, 1024) }
				: {}),
			...(headers.get("x-pm-locale")
				? { locale: headers.get("x-pm-locale")!.slice(0, 128) }
				: {}),
		};
		account = accountKey();
	}
	const restore = tapRequestHeaders(
		host,
		(parsed) =>
			isProtonMailOrigin(host.location.origin) &&
			parsed.origin === host.location.origin &&
			parsed.pathname.startsWith("/api/"),
		observe,
	);
	return {
		getHeaders: () =>
			session && account === accountKey() ? { ...session } : undefined,
		dispose() {
			session = undefined;
			restore();
		},
	};
}
