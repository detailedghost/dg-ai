import type { APIRoute } from "astro";
import { VIZ_DIR } from "../../lib/respond-core.ts";

const PORT = parseInt(process.env.VIZ_PORT ?? "4321", 10);

/**
 * Server identity probe — lets callers confirm a listener on PORT is actually
 * THIS server (same VIZ_DIR) before reusing or killing it. No nonce/secret
 * required (identity only); intentionally exposes nothing beyond vizDir/port/pid.
 *
 * Filename must NOT start with "_" — Astro's file-based router silently excludes
 * any src/pages path segment prefixed with an underscore from routing entirely.
 */
export const GET: APIRoute = () => {
	return new Response(
		JSON.stringify({ vizDir: VIZ_DIR, port: PORT, pid: process.pid }),
		{
			status: 200,
			headers: {
				"Content-Type": "application/json",
				"Cache-Control": "no-store",
			},
		},
	);
};
