import { existsSync, readdirSync, statSync } from "node:fs";
import type { APIRoute } from "astro";
import { isValidSlug, VIZ_DIR } from "../../lib/respond-core.ts";

// Lightweight poll target: page watches `rev` (re-render), `awaiting` (response
// on disk), and `stale` to refresh in place without a full reload.
export const GET: APIRoute = ({ url }) => {
	const slug = url.searchParams.get("slug") ?? "";
	// Shared charset/length guard (M4) — status.ts previously had its own looser
	// regex missing the ".."/length checks isValidSlug enforces everywhere else.
	if (!isValidSlug(slug)) {
		return new Response(JSON.stringify({ error: "invalid slug" }), {
			status: 400,
		});
	}

	const dir = `${VIZ_DIR}/${slug}`;
	const payloadPath = `${dir}/payload.json`;
	let mtime = 0;
	try {
		mtime = statSync(payloadPath).mtimeMs;
	} catch {
		// payload gone (session cleaned) — rev 0
	}
	// Track sidecars (tracks/*.json) live outside payload.json — fold their
	// newest mtime into rev so writing a track triggers the poll/refresh.
	try {
		for (const f of readdirSync(`${dir}/tracks`)) {
			if (!f.endsWith(".json")) continue;
			mtime = Math.max(mtime, statSync(`${dir}/tracks/${f}`).mtimeMs);
		}
	} catch {
		// no tracks dir yet — fine
	}
	const awaiting = existsSync(`${dir}/response.json`);
	const stale = existsSync(`${dir}/.stale`);

	return new Response(
		JSON.stringify({ rev: Math.floor(mtime), awaiting, stale }),
		{
			status: 200,
			headers: {
				"Content-Type": "application/json",
				"Cache-Control": "no-store",
			},
		},
	);
};
