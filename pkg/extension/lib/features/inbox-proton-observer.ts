/** Observed Proton headers are private page-memory state and must never enter relay responses. */
export type ProtonSessionHeaders = {
	uid: string;
	appVersion?: string;
	locale?: string;
};
type PageFetch = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;
type ObserverHost = {
	location: Pick<Location, "href" | "origin" | "pathname">;
	fetch: PageFetch;
	XMLHttpRequest: typeof XMLHttpRequest;
};

/** Accepts only the two supported HTTPS Proton Mail origins, without subdomain or suffix matching. */
export function isProtonMailOrigin(origin: string): boolean {
	return (
		origin === "https://mail.proton.me" ||
		origin === "https://mail.protonmail.com"
	);
}

/** Observes trusted mail fetch/XHR headers in memory, invalidates account switches, and returns a restoration handle. */
export function installProtonSessionObserver(host: ObserverHost): {
	getHeaders(): ProtonSessionHeaders | undefined;
	dispose(): void;
} {
	let session: ProtonSessionHeaders | undefined;
	let account: string | undefined;
	const accountKey = () =>
		/^\/u\/([^/]+)(?:\/|$)/.exec(host.location.pathname)?.[1];
	function trusted(url: string | URL): boolean {
		try {
			const parsed = new URL(url, host.location.href);
			return (
				isProtonMailOrigin(host.location.origin) &&
				parsed.origin === host.location.origin &&
				parsed.pathname.startsWith("/api/")
			);
		} catch {
			return false;
		}
	}
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
	const originalFetch = host.fetch;
	const wrappedFetch: PageFetch = function (input, init) {
		const url = input instanceof Request ? input.url : String(input);
		if (trusted(url))
			observe(
				new Headers(
					init?.headers ??
						(input instanceof Request ? input.headers : undefined),
				),
			);
		return originalFetch.call(host, input, init);
	};
	host.fetch = wrappedFetch;
	const prototype = host.XMLHttpRequest.prototype;
	const originalOpen = prototype.open;
	const originalHeader = prototype.setRequestHeader;
	const originalSend = prototype.send;
	const requests = new WeakMap<
		XMLHttpRequest,
		{ trusted: boolean; headers: Headers }
	>();
	const wrappedOpen: XMLHttpRequest["open"] = function (
		this: XMLHttpRequest,
		method: string,
		url: string | URL,
		async: boolean = true,
		username?: string | null,
		password?: string | null,
	) {
		requests.set(this, { trusted: trusted(url), headers: new Headers() });
		return originalOpen.call(this, method, url, async, username, password);
	};
	const wrappedHeader: XMLHttpRequest["setRequestHeader"] = function (
		this: XMLHttpRequest,
		name,
		value,
	) {
		originalHeader.call(this, name, value);
		if (/^x-pm-(uid|appversion|locale)$/i.test(name))
			requests.get(this)?.headers.set(name, value);
	};
	const wrappedSend: XMLHttpRequest["send"] = function (
		this: XMLHttpRequest,
		body,
	) {
		const request = requests.get(this);
		if (request?.trusted) observe(request.headers);
		return originalSend.call(this, body);
	};
	prototype.open = wrappedOpen;
	prototype.setRequestHeader = wrappedHeader;
	prototype.send = wrappedSend;
	return {
		getHeaders: () =>
			session && account === accountKey() ? { ...session } : undefined,
		dispose() {
			session = undefined;
			if (host.fetch === wrappedFetch) host.fetch = originalFetch;
			if (prototype.open === wrappedOpen) prototype.open = originalOpen;
			if (prototype.setRequestHeader === wrappedHeader)
				prototype.setRequestHeader = originalHeader;
			if (prototype.send === wrappedSend) prototype.send = originalSend;
		},
	};
}
