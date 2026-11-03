import boardHtml from "../../../pages/dist/board.html" with { type: "text" };
import boardJs from "../../../pages/dist/board.js" with { type: "text" };
import chatHtml from "../../../pages/dist/chat.html" with { type: "text" };
import chatJs from "../../../pages/dist/chat.js" with { type: "text" };

const SCRIPTS: Record<string, string> = {
	"/chat.js": chatJs,
	"/board.js": boardJs,
};

const HTML: Record<string, string> = {
	"/chat": chatHtml,
	"/board": boardHtml,
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
): Response | undefined {
	const html = HTML[pathname];
	if (html !== undefined) {
		return new Response(html, {
			headers: {
				...PAGE_HEADERS,
				"Content-Type": "text/html; charset=utf-8",
				"Content-Security-Policy": contentSecurityPolicy(port),
			},
		});
	}
	const script = SCRIPTS[pathname];
	if (script === undefined) return undefined;
	return new Response(script, {
		headers: {
			...PAGE_HEADERS,
			"Content-Type": "text/javascript; charset=utf-8",
		},
	});
}
