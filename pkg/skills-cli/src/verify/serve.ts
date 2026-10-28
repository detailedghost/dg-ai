import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { resolveSkillAsset } from "../utils/skill-assets";
import { mergeVerdicts, readBoard, readVerdicts, VerifyRequestError, type VerifyPaths } from "./board";

export const VERIFY_CSP =
	"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const ASSETS: Record<string, { skill: string; file: string; type: string }> = {
	"/": { skill: "verify", file: "index.html", type: "text/html; charset=utf-8" },
	"/board/board.js": { skill: "verify", file: "board.js", type: "text/javascript; charset=utf-8" },
	"/board/board.css": { skill: "verify", file: "board.css", type: "text/css; charset=utf-8" },
	"/board/icons.js": { skill: "proto", file: "dg-icons.js", type: "text/javascript; charset=utf-8" },
};

const SHOT = /^\/shots\/((?:[a-z0-9][a-z0-9._-]{0,127}\/){1,8}[a-z0-9][a-z0-9._-]{0,127}\.png)$/;

export interface RunningReview {
	port: number;
	stop(): void;
}

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function rejectCrossSite(req: Request, port: number): Response | undefined {
	const origin = req.headers.get("origin");
	const allowed = new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`]);
	if (origin !== null && !allowed.has(origin)) return json({ error: "Forbidden origin" }, 403);
	const site = req.headers.get("sec-fetch-site");
	if (site !== null && site !== "same-origin" && site !== "none") return json({ error: "Forbidden request" }, 403);
	const type = (req.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
	if (type !== "application/json") return json({ error: "Content-Type must be application/json" }, 415);
	return undefined;
}

function shotFile(paths: VerifyPaths, pathname: string): string | undefined {
	const match = SHOT.exec(pathname);
	if (!match?.[1] || match[1].split("/").some((part) => part.startsWith(".."))) return undefined;
	const root = resolve(paths.shotsDir);
	const target = resolve(join(root, match[1]));
	return target.startsWith(`${root}${sep}`) ? target : undefined;
}

/** Serve the review board, its manifest and verdict API, and the captured shots. */
export async function startVerifyServer(options: { name: string; paths: VerifyPaths; port?: number }): Promise<RunningReview> {
	const { name, paths } = options;
	const assets = Object.fromEntries(
		Object.entries(ASSETS).map(([route, asset]) => [
			route,
			{ body: readFileSync(resolveSkillAsset(asset.skill, join("assets", asset.file)), "utf8"), type: asset.type },
		]),
	);
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: options.port ?? 0,
		async fetch(req) {
			const url = new URL(req.url);
			const host = (req.headers.get("host") ?? "").split(":")[0];
			if (host !== "localhost" && host !== "127.0.0.1") return new Response("Forbidden", { status: 403 });
			if (url.pathname === "/api/verdicts" && req.method === "POST") {
				const refusal = rejectCrossSite(req, server.port ?? 0);
				if (refusal) return refusal;
				try {
					mergeVerdicts(paths, readBoard(paths, name), await req.json().catch(() => undefined));
					return json({ ok: true });
				} catch (error) {
					const status = error instanceof VerifyRequestError ? error.status : 500;
					return json({ error: error instanceof Error ? error.message : String(error) }, status);
				}
			}
			if (req.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
			try {
				if (url.pathname === "/api/manifest") return json(readBoard(paths, name));
				if (url.pathname === "/api/verdicts") return json(readVerdicts(paths));
			} catch (error) {
				return json({ error: error instanceof Error ? error.message : String(error) }, 500);
			}
			const asset = assets[url.pathname];
			if (asset)
				return new Response(asset.body, {
					headers: {
						"Content-Type": asset.type,
						"Content-Security-Policy": VERIFY_CSP,
						"Cache-Control": "no-store",
						"X-Content-Type-Options": "nosniff",
					},
				});
			const file = shotFile(paths, url.pathname);
			if (!file || !existsSync(file)) return new Response("Not found", { status: 404 });
			return new Response(readFileSync(file), {
				headers: { "Content-Type": "image/png", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
			});
		},
	});
	return {
		port: server.port ?? 0,
		stop() {
			server.stop(true);
		},
	};
}
