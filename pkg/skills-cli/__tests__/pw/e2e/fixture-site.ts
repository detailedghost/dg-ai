export const COOKIE_NAME = "pw_e2e_sid";
export const COOKIE_VALUE = "e2e-ok";

const page = (body: string): Response =>
	new Response(`<!doctype html><html><head><title>fixture</title></head><body>${body}</body></html>`, {
		headers: { "content-type": "text/html; charset=utf-8" },
	});

const loggedIn = (request: Request): boolean =>
	(request.headers.get("cookie") ?? "").split(/;\s*/).includes(`${COOKIE_NAME}=${COOKIE_VALUE}`);

const LOGIN_FORM = `<h1>Sign in</h1>
<form method="post" action="/login">
<label>Username <input name="user" type="text"></label>
<label>Password <input name="pass" type="password"></label>
<button type="submit">Log in</button>
</form>`;

const UPLOAD_PAGE = `<h1>Upload</h1>
<input id="file" type="file" aria-label="Attachment" onchange="document.getElementById('picked').textContent = this.files[0].name">
<p id="picked">none</p>`;

export function startFixtureSite(): { url: string; stop: () => void } {
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(request) {
			const { pathname } = new URL(request.url);
			if (pathname === "/login" && request.method === "POST") {
				return new Response(null, {
					status: 303,
					headers: {
						location: "/protected",
						"set-cookie": `${COOKIE_NAME}=${COOKIE_VALUE}; Path=/; Max-Age=3600; HttpOnly`,
					},
				});
			}
			if (pathname === "/protected") {
				return loggedIn(request) ? page("<h1>Welcome back</h1>") : page("<h1>Signed out</h1>");
			}
			if (pathname === "/upload") return page(UPLOAD_PAGE);
			return page(LOGIN_FORM);
		},
	});
	return { url: `http://127.0.0.1:${server.port}`, stop: () => void server.stop(true) };
}
