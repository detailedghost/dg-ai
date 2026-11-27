/** The kind of each local page path; the page text loads on the first request for one. */
const PAGE_KINDS: Readonly<Record<string, "html" | "script">> = {
	"/chat": "html",
	"/board": "html",
	"/secret": "html",
	"/chat.js": "script",
	"/board.js": "script",
	"/secret.js": "script",
};

const PAGE_HEADERS = {
	"X-Content-Type-Options": "nosniff",
	"X-Frame-Options": "DENY",
	"Cache-Control": "no-store",
};

function contentSecurityPolicy(port: number): string {
	return [
		"default-src 'none'",
		"script-src 'self'",
		`connect-src 'self' ws://127.0.0.1:${port}`,
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' data: blob:",
	].join("; ");
}

export function localPageResponse(
	pathname: string,
	port: number,
): Promise<Response> | undefined {
	const kind = Object.hasOwn(PAGE_KINDS, pathname) ? PAGE_KINDS[pathname] : undefined;
	if (kind === undefined) return undefined;
	return import("./page-assets").then(({ PAGE_ASSETS }) => {
		const body = PAGE_ASSETS[pathname];
		if (kind === "html") {
			return new Response(body, {
				headers: {
					...PAGE_HEADERS,
					"Content-Type": "text/html; charset=utf-8",
					"Content-Security-Policy": contentSecurityPolicy(port),
				},
			});
		}
		return new Response(body, {
			headers: {
				...PAGE_HEADERS,
				"Content-Type": "text/javascript; charset=utf-8",
			},
		});
	});
}
