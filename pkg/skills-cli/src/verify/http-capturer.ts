import {
	menuIsOpen,
	pageMarkedScrolled,
	type Capturer,
	type CaptureRequest,
	type CaptureShot,
	withCaptureQuery,
} from "./capture-model";
import { isLoopbackUrl } from "./urls";

const PLACEHOLDER_PNG = Uint8Array.from(
	atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
	(char) => char.charCodeAt(0),
);

function cookieHeader(cookies: CaptureRequest["cookies"]): string {
	return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

async function followLoopback(target: string, headers: Headers, timeoutMs: number): Promise<{ html: string; finalUrl: string }> {
	let current = target;
	for (let hop = 0; hop < 3; hop++) {
		const response = await fetch(current, { headers, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
		if (response.status < 300 || response.status >= 400) {
			const html = await response.text();
			if (!response.ok) throw new Error(`verify capture HTTP ${response.status} for ${current}`);
			return { html, finalUrl: current };
		}
		const location = response.headers.get("location");
		if (!location) throw new Error(`verify capture redirect from ${current} has no location`);
		const next = new URL(location, current);
		if (!isLoopbackUrl(next)) throw new Error(`verify refused a redirect to ${next.toString()}`);
		current = next.toString();
	}
	throw new Error(`verify capture followed too many redirects from ${target}`);
}

/** Fetch the page HTML. The image is a placeholder, not a viewport bitmap. */
export function createHttpCapturer(timeoutMs = 10_000): Capturer {
	return {
		async shot(request: CaptureRequest): Promise<CaptureShot> {
			const headers = new Headers(request.headers);
			if (request.cookies.length > 0) headers.set("cookie", cookieHeader(request.cookies));
			const target = withCaptureQuery(request.url, request.theme, request.state);
			const { html, finalUrl } = await followLoopback(target, headers, timeoutMs);
			const menuFound = request.state === "menu" && menuIsOpen(html);
			const scrolled = request.state === "scrolled" && pageMarkedScrolled(html);
			return {
				png: PLACEHOLDER_PNG,
				html,
				finalUrl,
				menuFound,
				scrolled,
				engine: "http",
			};
		},
		async close() {},
	};
}
