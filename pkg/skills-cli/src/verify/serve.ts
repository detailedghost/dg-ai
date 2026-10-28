import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { VERIFY_CSS, VERIFY_JS } from "./client";
import { loadReview, renderReview } from "./page";
import { loadManifest } from "./session";
import {
	applyDecision,
	readReload,
	VerifyRequestError,
	type VerifyPaths,
} from "./verdict";

export const VERIFY_CSP =
	"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const SHOT =
	/^\/shots\/([a-z0-9][a-z0-9-]{0,63})\/(before|after|target)\/([a-z0-9][a-z0-9-]{0,63})\/(desktop|mobile)\/(light|dark)\/(default|scrolled|menu)\.png$/;

export interface RunningReview {
	port: number;
	stop(): void;
}

function findPort(start: number): number {
	for (let port = start; port < start + 10; port++) {
		try {
			Bun.listen({
				hostname: "127.0.0.1",
				port,
				socket: { data() {}, open() {}, close() {}, error() {} },
			}).stop(true);
			return port;
		} catch {
			continue;
		}
	}
	throw new Error(`No free port found in range ${start}-${start + 9}`);
}

function json(body: unknown, status: number): Response {
	return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function rejectCrossSite(req: Request, port: number): Response | undefined {
	const origin = req.headers.get("origin");
	const allowed = new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`]);
	if (origin !== null && !allowed.has(origin))
		return json({ error: "Forbidden origin" }, 403);
	const site = req.headers.get("sec-fetch-site");
	if (site !== null && site !== "same-origin" && site !== "none")
		return json({ error: "Forbidden request" }, 403);
	const type = (req.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
	if (type !== "application/json" && type !== "application/x-www-form-urlencoded")
		return json({ error: "Content-Type must be json or a form" }, 415);
	return undefined;
}

function html(paths: VerifyPaths, status: number, error?: string): Response {
	const manifest = loadManifest(paths);
	const body = renderReview(loadReview(paths, manifest, error));
	return new Response(body, {
		status,
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Content-Security-Policy": VERIFY_CSP,
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
		},
	});
}

function asset(body: string, type: string): Response {
	return new Response(body, {
		headers: {
			"Content-Type": type,
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
		},
	});
}

async function readDecision(req: Request): Promise<{ itemId: string; action: string; note: string }> {
	const type = (req.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
	if (type === "application/json") {
		let body: unknown;
		try {
			body = await req.json();
		} catch {
			throw new VerifyRequestError("Invalid JSON", 400);
		}
		if (!body || typeof body !== "object" || Array.isArray(body))
			throw new VerifyRequestError("Invalid JSON", 400);
		const record = body as Record<string, unknown>;
		return {
			itemId: typeof record.itemId === "string" ? record.itemId : "",
			action: typeof record.action === "string" ? record.action : "",
			note: typeof record.note === "string" ? record.note : "",
		};
	}
	const params = new URLSearchParams(await req.text());
	return {
		itemId: params.get("itemId") ?? "",
		action: params.get("action") ?? "",
		note: params.get("note") ?? "",
	};
}

function shotFile(paths: VerifyPaths, pathname: string): string | undefined {
	const match = SHOT.exec(pathname);
	if (!match) return undefined;
	const root = resolve(paths.shotsDir);
	const target = resolve(
		join(root, match[1] ?? "", match[2] ?? "", match[3] ?? "", match[4] ?? "", match[5] ?? "", `${match[6] ?? ""}.png`),
	);
	if (target !== root && !target.startsWith(`${root}${sep}`)) return undefined;
	return target;
}

/** Serve the review page, its static script, and the decision endpoint. */
export async function startVerifyServer(options: {
	paths: VerifyPaths;
	port?: number;
}): Promise<RunningReview> {
	const paths = options.paths;
	const requested = options.port === undefined || options.port === 0 ? 0 : findPort(options.port);
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: requested,
		async fetch(req) {
			const url = new URL(req.url);
			const host = (req.headers.get("host") ?? "").split(":")[0];
			if (host !== "localhost" && host !== "127.0.0.1")
				return new Response("Forbidden", { status: 403 });
			if (req.method === "GET" && url.pathname === "/verify.js")
				return asset(VERIFY_JS, "text/javascript; charset=utf-8");
			if (req.method === "GET" && url.pathname === "/verify.css")
				return asset(VERIFY_CSS, "text/css; charset=utf-8");
			if (req.method === "GET" && url.pathname === "/reload")
				return json({ token: String(readReload(paths)) }, 200);
			if (req.method === "GET" && url.pathname === "/session.json") {
				try {
					return json(loadReview(paths, loadManifest(paths)), 200);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return json({ error: message }, 500);
				}
			}
			if (req.method === "GET" && url.pathname.startsWith("/shots/")) {
				const file = shotFile(paths, url.pathname);
				if (!file || !existsSync(file)) return new Response("Not found", { status: 404 });
				return new Response(readFileSync(file), {
					headers: { "Content-Type": "image/png", "Cache-Control": "no-store" },
				});
			}
			if (req.method === "POST" && url.pathname === "/decision") {
				const refusal = rejectCrossSite(req, server.port ?? 0);
				if (refusal) return refusal;
				try {
					const body = await readDecision(req);
					applyDecision(paths, loadManifest(paths), body.itemId, body.action, body.note);
					return new Response(null, { status: 303, headers: { Location: "/" } });
				} catch (error) {
					if (error instanceof VerifyRequestError)
						return html(paths, error.status, error.message);
					const message = error instanceof Error ? error.message : String(error);
					return html(paths, 500, message);
				}
			}
			if (req.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
			if (url.pathname !== "/") return new Response("Not found", { status: 404 });
			try {
				return html(paths, 200);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return new Response(message, { status: 500 });
			}
		},
	});
	return {
		port: server.port ?? requested,
		stop() {
			server.stop(true);
		},
	};
}
