import type { Capturer, CaptureRequest } from "../../../src/verify/capture-model";

export const SESSION = "dummy-session=dummy-value";

/** A loopback app whose pages need the session cookie that `/prototype-signin` sets. */
export function startSignInApp(name = "demo"): { origin: string; stop: () => void } {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req) {
			const url = new URL(req.url);
			const html = (body: string) => new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8" } });
			if (url.pathname === "/prototype-signin") {
				const back = url.searchParams.get("returnUrl") ?? "/";
				const location = back.startsWith("/") && !back.startsWith("//") ? back : "/";
				return new Response(null, { status: 302, headers: { Location: location, "Set-Cookie": `${SESSION}; Path=/; HttpOnly` } });
			}
			if (url.pathname === "/Login/SignIn") return html("<!doctype html><html lang=\"en\"><body><p>Sign in</p></body></html>");
			if (!(req.headers.get("cookie") ?? "").includes(SESSION))
				return new Response(null, { status: 302, headers: { Location: `/Login/SignIn?ReturnUrl=${encodeURIComponent(url.pathname)}` } });
			return html(
				`<!doctype html><html lang="en"><head><title>Schedule</title></head><body><main data-verify-root="${name}"><button type="button">Create shift</button></main></body></html>`,
			);
		},
	});
	return { origin: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

/** A capturer that signs in and reads the page over plain HTTP, waiting `delayMs` per shot. */
export function httpCapturer(seen: CaptureRequest[], delayMs = 0, name = "demo"): () => Promise<Capturer> {
	return async () => ({
		async shot(request) {
			seen.push(request);
			if (delayMs > 0) await Bun.sleep(delayMs);
			let cookie = "";
			if (request.signIn) {
				const signedIn = await fetch(request.signIn, { redirect: "manual" });
				cookie = (signedIn.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
			}
			const page = await fetch(request.url, { redirect: "manual", headers: cookie ? { cookie } : {} });
			const location = page.headers.get("location");
			const finalUrl = location ? new URL(location, request.url).toString() : request.url;
			const body = location ? "" : await page.text();
			return {
				png: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
				html: body,
				finalUrl,
				menuFound: false,
				scrolled: false,
				engine: "playwright",
				fingerprint: body.includes("data-verify-root")
					? { root: { x: 0, y: 0, w: request.width, h: 100 }, controls: [], themeApplied: request.theme }
					: { error: `root: found 0 visible [data-verify-root="${name}"]` },
			};
		},
		async close() {},
	});
}
