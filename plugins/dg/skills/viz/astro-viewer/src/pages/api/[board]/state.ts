import { randomBytes } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { APIRoute } from "astro";
import { heldState } from "../../../lib/held-state.ts";
import {
	isValidSlug,
	mergeStateUpdate,
	VIZ_DIR,
	withRespondLock,
} from "../../../lib/respond-core.ts";

const PORT = parseInt(process.env.VIZ_PORT ?? "4321", 10);

// Local dev tool, but the endpoint is reachable by any no-Origin (CLI-trust) request —
// cap body size so a stray/hostile huge payload can't be written to disk unbounded.
const MAX_BODY_BYTES = 1_000_000;

/**
 * Temp file lives in the SAME directory as the destination (H10) — os.tmpdir() can
 * be a different filesystem/mount than VIZ_DIR, and renameSync across filesystems
 * throws EXDEV instead of atomically renaming.
 *
 * Kept local (not respond-core.ts's atomicWriteJson) — a static-analysis test
 * asserts this file's own source contains dirname(path).
 */
function atomicWriteJson(path: string, data: unknown, mode = 0o600): void {
	const tmp = join(
		dirname(path),
		`.viz-state-${randomBytes(8).toString("hex")}.tmp`,
	);
	writeFileSync(tmp, JSON.stringify(data, null, "\t"), { mode });
	renameSync(tmp, path);
}

/**
 * H9: this endpoint has no HMAC (it's an internal CLI→server upload path, not a
 * user-facing form submit), so Origin is the only CSRF defense available. The CLI's
 * fetch() call never sends an Origin header at all; a cross-origin browser fetch
 * (the CSRF shape) always does. So: no Origin header → allow (CLI); an Origin header
 * present but not same-origin → reject (malicious page).
 */
function isAllowedCliOrigin(origin: string | null): boolean {
	if (origin === null) return true;
	return (
		origin === `http://localhost:${PORT}` ||
		origin === `http://127.0.0.1:${PORT}`
	);
}

/**
 * PUT /api/[board]/state — CLI state upload endpoint.
 * Accepts a full-payload body from CLI mutating operations (render, annotate, phase, merge).
 * Merges into the in-memory held-state map; acquires the same per-board O_EXCL lock as POST.
 * Atomic renameSync write ensures wait.ts file-poll never reads a torn payload.
 */
export const PUT: APIRoute = async ({ params, request }) => {
	if (!isAllowedCliOrigin(request.headers.get("origin"))) {
		return new Response(JSON.stringify({ error: "forbidden" }), {
			status: 403,
		});
	}

	const board = params.board;
	if (!board) {
		return new Response(JSON.stringify({ error: "missing board" }), {
			status: 400,
		});
	}

	// Shared charset/length guard (M4) — matches validateSlug in session.ts (SEC-4).
	if (!isValidSlug(board)) {
		return new Response(JSON.stringify({ error: "invalid board id" }), {
			status: 400,
		});
	}

	const contentLength = Number(request.headers.get("content-length"));
	if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
		return new Response(JSON.stringify({ error: "payload too large" }), {
			status: 413,
		});
	}

	let rawBody: string;
	try {
		rawBody = await request.text();
	} catch {
		return new Response(JSON.stringify({ error: "invalid body" }), {
			status: 400,
		});
	}
	if (Buffer.byteLength(rawBody, "utf-8") > MAX_BODY_BYTES) {
		return new Response(JSON.stringify({ error: "payload too large" }), {
			status: 413,
		});
	}

	let body: { slug?: string; payload?: Record<string, unknown> };
	try {
		body = JSON.parse(rawBody);
	} catch {
		return new Response(JSON.stringify({ error: "invalid JSON" }), {
			status: 400,
		});
	}

	const incomingPayload = body.payload;
	if (
		!incomingPayload ||
		typeof incomingPayload !== "object" ||
		Array.isArray(incomingPayload)
	) {
		return new Response(JSON.stringify({ error: "missing payload" }), {
			status: 400,
		});
	}

	// M6: reject obviously-malformed shapes for the array fields doMerge/mergeStateUpdate
	// depend on, rather than silently persisting corrupt state to disk.
	const ARRAY_FIELDS = [
		"decisions",
		"open_questions",
		"permissions",
		"roundtable",
		"links",
	] as const;
	for (const field of ARRAY_FIELDS) {
		if (
			field in incomingPayload &&
			!Array.isArray((incomingPayload as Record<string, unknown>)[field])
		) {
			return new Response(
				JSON.stringify({
					error: `invalid payload: '${field}' must be an array`,
				}),
				{
					status: 400,
				},
			);
		}
	}

	const dir = `${VIZ_DIR}/${board}`;
	mkdirSync(dir, { recursive: true });
	const payloadPath = `${dir}/payload.json`;

	/**
	 * PUT merges into in-memory held state, not a disk re-read. Field-level merge
	 * (C6) — heldState wins for fields only /api/respond mutates, so a CLI PUT
	 * carrying a stale snapshot can never un-resolve something respond just resolved.
	 */
	await withRespondLock(dir, () => {
		// heldState starts empty right after render.ts's direct disk write (C-bypass) —
		// fall back to disk so an empty `current` can't let incoming pass through unfiltered.
		let current = heldState.get(board);
		if (!current && existsSync(payloadPath)) {
			try {
				current = JSON.parse(readFileSync(payloadPath, "utf-8"));
			} catch {
				current = undefined;
			}
		}
		const merged = mergeStateUpdate(current ?? {}, incomingPayload);

		heldState.set(board, merged);

		// Atomic write: temp file then renameSync.
		atomicWriteJson(payloadPath, merged);
	});

	return new Response(JSON.stringify({ ok: true }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
};
