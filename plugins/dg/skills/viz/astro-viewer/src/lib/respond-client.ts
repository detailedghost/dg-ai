/**
 * Shared client-side transport for the viz response flow: read the per-board
 * slug/nonce off the DOM, sign an answer batch, and POST it to /api/respond.
 * Callers keep their own UI concerns (loading state, error branching,
 * success choreography) — this module is transport only.
 */

export interface VizMeta {
	slug: string;
	nonce: string;
}

export function readVizMeta(): VizMeta {
	const slug = (document.querySelector("[data-viz-slug]") as HTMLElement | null)?.dataset?.vizSlug ?? "";
	const nonce = (document.querySelector("[data-viz-nonce]") as HTMLElement | null)?.dataset?.vizNonce ?? "";
	return { slug, nonce };
}

/**
 * The HMAC secret lives server-side only (${VIZ_DIR}/.secret) — secured boards
 * always mint one (render.ts/review.ts), so /api/respond fail-closed rejects an
 * unsigned POST. /api/sign computes the digest same-origin without ever exposing
 * the secret itself, reusing the exact construction validateHmac expects.
 */
export async function signAnswers(slug: string, answers: unknown[]): Promise<string> {
	const res = await fetch("/api/sign", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ slug, answers }),
	});
	if (!res.ok) throw new Error(`sign failed: ${res.status}`);
	const { hmac } = (await res.json()) as { hmac: string };
	return hmac;
}

export function respond(slug: string, nonce: string, hmac: string, answers: unknown[]): Promise<Response> {
	return fetch("/api/respond", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ slug, nonce, hmac, answers }),
	});
}
