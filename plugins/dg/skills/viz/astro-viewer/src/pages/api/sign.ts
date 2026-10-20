import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { APIRoute } from "astro";
import { isAllowedOrigin, isValidSlug, tokenFilePath, VIZ_DIR } from "../../lib/respond-core.ts";

/**
 * Same-origin HMAC signer for browser-side submitters (e.g. ReviewSection's
 * submit button) that need to POST to /api/respond on a board that already
 * has a `.secret` — the secret never leaves the server; only the digest does.
 * Mirrors validateHmac's exact construction in respond-core.ts.
 *
 * M9 — same-origin oracle: the origin check below only proves the caller is
 * *some* script running on this origin, not that it's this board's own board
 * JS. Any same-origin caller that knows (or brute-forces) a `slug` can get a
 * valid signature for arbitrary `answers` on THAT slug's board — this route
 * is a signing oracle for the whole origin, not scoped per-board. Accepted
 * because it doesn't widen the trust boundary already stated in
 * DESIGN-TREE.md §3 (same local-origin access already implies the ability to
 * read `.secret` directly), but a future same-origin XSS on any one board
 * would let an attacker sign submissions for every other board too.
 */
export const POST: APIRoute = async ({ request }) => {
	const origin = request.headers.get("origin");
	if (!isAllowedOrigin(origin)) {
		return new Response(JSON.stringify({ error: "forbidden" }), {
			status: 403,
		});
	}

	let body: { slug?: string; answers?: unknown[] };
	try {
		body = await request.json();
	} catch {
		return new Response(JSON.stringify({ error: "invalid JSON" }), {
			status: 400,
		});
	}

	const { slug, answers } = body;
	if (!slug || !Array.isArray(answers) || !isValidSlug(slug)) {
		return new Response(JSON.stringify({ error: "missing or invalid slug/answers" }), { status: 400 });
	}

	const dir = `${VIZ_DIR}/${slug}`;
	const tokenPath = tokenFilePath(dir);
	const secretPath = `${VIZ_DIR}/.secret`;
	if (!existsSync(tokenPath) || !existsSync(secretPath)) {
		return new Response(JSON.stringify({ error: "board not ready" }), {
			status: 503,
		});
	}

	const nonce = readFileSync(tokenPath, "utf-8").trim();
	const secret = readFileSync(secretPath, "utf-8").trim();
	const hmac = createHmac("sha256", secret)
		.update(slug + JSON.stringify(answers) + nonce)
		.digest("hex");

	return new Response(JSON.stringify({ hmac, nonce }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
};
