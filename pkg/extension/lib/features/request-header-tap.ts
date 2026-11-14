type PageFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type TapHost = {
	location: Pick<Location, "href">;
	fetch: PageFetch;
	XMLHttpRequest: typeof XMLHttpRequest;
};

/** Passes the request headers and URL of each trusted page fetch or XHR to observe, and returns a function that restores the page methods. */
export function tapRequestHeaders(
	host: TapHost,
	trusted: (url: URL) => boolean,
	observe: (headers: Headers, url: URL) => void,
): () => void {
	const allowed = (url: string | URL): URL | undefined => {
		try {
			const parsed = new URL(url, host.location.href);
			return trusted(parsed) ? parsed : undefined;
		} catch {
			return undefined;
		}
	};
	const originalFetch = host.fetch;
	const wrappedFetch: PageFetch = function (input, init) {
		const url = allowed(input instanceof Request ? input.url : String(input));
		if (url) observe(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)), url);
		return originalFetch.call(host, input, init);
	};
	host.fetch = wrappedFetch;
	const prototype = host.XMLHttpRequest.prototype;
	const originalOpen = prototype.open;
	const originalHeader = prototype.setRequestHeader;
	const originalSend = prototype.send;
	const requests = new WeakMap<XMLHttpRequest, { headers: Headers; url: URL } | undefined>();
	const wrappedOpen: XMLHttpRequest["open"] = function (
		this: XMLHttpRequest,
		method: string,
		url: string | URL,
		async: boolean = true,
		username?: string | null,
		password?: string | null,
	) {
		const parsed = allowed(url);
		requests.set(this, parsed ? { headers: new Headers(), url: parsed } : undefined);
		return originalOpen.call(this, method, url, async, username, password);
	};
	const wrappedHeader: XMLHttpRequest["setRequestHeader"] = function (this: XMLHttpRequest, name, value) {
		originalHeader.call(this, name, value);
		try {
			requests.get(this)?.headers.set(name, value);
		} catch {
			return;
		}
	};
	const wrappedSend: XMLHttpRequest["send"] = function (this: XMLHttpRequest, body) {
		const request = requests.get(this);
		if (request) observe(request.headers, request.url);
		return originalSend.call(this, body);
	};
	prototype.open = wrappedOpen;
	prototype.setRequestHeader = wrappedHeader;
	prototype.send = wrappedSend;
	return () => {
		if (host.fetch === wrappedFetch) host.fetch = originalFetch;
		if (prototype.open === wrappedOpen) prototype.open = originalOpen;
		if (prototype.setRequestHeader === wrappedHeader) prototype.setRequestHeader = originalHeader;
		if (prototype.send === wrappedSend) prototype.send = originalSend;
	};
}
