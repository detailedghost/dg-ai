import { randomBytes, timingSafeEqual } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { APIRoute } from "astro";
import { heldState } from "../../lib/held-state.ts";
import {
	type Answer,
	accumulate,
	doMerge,
	isValidSlug,
	KNOWN_TYPES,
	tokenFilePath,
	VIZ_DIR,
	validateHmac,
	withRespondLock,
} from "../../lib/respond-core.ts";

const PORT = parseInt(process.env.VIZ_PORT ?? "4321", 10);

// Kept local (not respond-core.ts's isAllowedOrigin) — several static-analysis
// tests assert this function's exact source text lives in respond.ts itself.
function isAllowedOrigin(origin: string | null): boolean {
	if (!origin) return false;
	return (
		origin === `http://localhost:${PORT}` ||
		origin === `http://127.0.0.1:${PORT}`
	);
}

/** Parse Referer with URL to reject userinfo-smuggled hosts (a localhost lookalike placed before the @ sign). */
function isAllowedReferer(referer: string): boolean {
	try {
		const u = new URL(referer);
		return (
			u.username === "" &&
			u.password === "" &&
			(u.hostname === "localhost" || u.hostname === "127.0.0.1") &&
			u.port === String(PORT)
		);
	} catch {
		return false;
	}
}

/**
 * Write payload atomically to avoid torn reads by the file-polling wait.ts. The temp
 * file lives in the SAME directory as the destination (H10) — os.tmpdir() can be a
 * different filesystem/mount than VIZ_DIR, and renameSync across filesystems throws
 * EXDEV instead of atomically renaming.
 *
 * Kept local (not respond-core.ts's atomicWriteJson) — static-analysis tests assert
 * this file's own source contains dirname(path)/mode:0o600, not a re-export.
 */
function atomicWriteJson(path: string, data: unknown, mode = 0o600): void {
	const tmp = join(
		dirname(path),
		`viz-payload-${randomBytes(8).toString("hex")}.tmp`,
	);
	writeFileSync(tmp, JSON.stringify(data, null, "\t"), { mode });
	renameSync(tmp, path);
}

export const POST: APIRoute = async ({ request }) => {
	// Invariant: Referer fallback ONLY fires when Origin is absent — never loosen to
	// "Origin-allowed OR Referer-allowed" or a bad Origin could ride a crafted Referer.
	const origin = request.headers.get("origin");
	const referer = request.headers.get("referer");
	const allowed =
		isAllowedOrigin(origin) ||
		(!origin && !!referer && isAllowedReferer(referer));

	if (!allowed) {
		return new Response(JSON.stringify({ error: "forbidden" }), {
			status: 403,
		});
	}

	let body: {
		slug?: string;
		answers?: unknown[];
		nonce?: string;
		hmac?: string;
	};
	try {
		body = await request.json();
	} catch {
		return new Response(JSON.stringify({ error: "invalid JSON" }), {
			status: 400,
		});
	}

	const { slug, answers, nonce: bodyNonce, hmac: bodyHmac } = body;
	if (!slug || !Array.isArray(answers)) {
		return new Response(JSON.stringify({ error: "missing slug or answers" }), {
			status: 400,
		});
	}
	// Shared charset/length guard (M4) — matches validateSlug in session.ts (SEC-4).
	if (!isValidSlug(slug)) {
		return new Response(JSON.stringify({ error: "invalid slug" }), {
			status: 400,
		});
	}

	const dir = `${VIZ_DIR}/${slug}`;

	// Nonce/HMAC defends against CSRF + cross-user forgery, NOT same-uid local execution —
	// anything that can read ${VIZ_DIR}/.secret can forge. Read .token from disk (timing-safe).
	// NONCE CHECK IS FIRST — unconditional, before HMAC and before any merge/write.
	const tokenPath = tokenFilePath(dir);
	if (!existsSync(tokenPath)) {
		return new Response(JSON.stringify({ error: "unauthorized" }), {
			status: 401,
		});
	}
	const diskNonce = readFileSync(tokenPath, "utf-8").trim();
	if (!bodyNonce) {
		return new Response(JSON.stringify({ error: "unauthorized" }), {
			status: 401,
		});
	}
	const diskBuf = Buffer.from(diskNonce, "utf-8");
	const bodyBuf = Buffer.from(String(bodyNonce), "utf-8");
	const noncesMatch =
		diskBuf.length === bodyBuf.length && timingSafeEqual(diskBuf, bodyBuf);
	if (!noncesMatch) {
		return new Response(JSON.stringify({ error: "unauthorized" }), {
			status: 401,
		});
	}

	// .secret must be minted at server start by render.ts — never on demand (TOCTOU guard)
	const secretPath = `${VIZ_DIR}/.secret`;
	if (!existsSync(secretPath)) {
		return new Response(JSON.stringify({ error: "server not ready" }), {
			status: 503,
		});
	}

	mkdirSync(dir, { recursive: true });
	const responsePath = `${dir}/response.json`;
	const payloadPath = `${dir}/payload.json`;

	let mergeResult: unknown;
	let hmacRejected = false;

	// Lock the whole read-merge-write so concurrent rapid-click POSTs serialize (no last-write-wins).
	await withRespondLock(dir, () => {
		const finalAnswers = accumulate(
			responsePath,
			diskNonce,
			answers as Answer[],
		);

		/**
		 * Derive forceEnforce from the SERVER-held payload — never from incoming answers.
		 * heldState has the in-memory copy; fall back to disk if not yet held.
		 *
		 * C7 fail-closed fix: a payload.json that EXISTS but fails to parse (corrupt/
		 * truncated write) must enforce, not fall through to "no gate" — we cannot tell
		 * whether the corrupted file had an approval/permissions gate, so treat corruption
		 * itself as the security-relevant signal. Only a genuinely ABSENT payload (a
		 * fresh/legacy board that never had a gate) legitimately skips enforcement.
		 */
		let heldPayload: Record<string, unknown> | undefined = heldState.get(slug);
		let corruptPayloadOnDisk = false;
		if (!heldPayload && existsSync(payloadPath)) {
			try {
				heldPayload = JSON.parse(readFileSync(payloadPath, "utf-8")) as Record<
					string,
					unknown
				>;
			} catch {
				corruptPayloadOnDisk = true;
			}
		}
		const forceEnforce =
			corruptPayloadOnDisk ||
			(heldPayload !== undefined &&
				(heldPayload.approval !== undefined ||
					Array.isArray(heldPayload.permissions)));

		/**
		 * HMAC validates against the CALLER's own submitted answers, not finalAnswers
		 * (accumulate()'s merged superset) — /api/sign can only ever sign what the
		 * caller itself sent, since it has no visibility into concurrent submissions
		 * already on disk. Validating against the superset made a second legitimate,
		 * correctly-signed submission indistinguishable from a forgery.
		 */
		const hmacResult = validateHmac(
			slug,
			answers as Answer[],
			bodyHmac,
			forceEnforce,
		);
		if (hmacResult === false) {
			hmacRejected = true;
			return; // exit lock body — caller checks hmacRejected before writing
		}

		// Filter by KNOWN_TYPES before calling doMerge (doMerge itself does not filter).
		const typedAnswers = (
			finalAnswers as {
				type: string;
				index: number;
				answer: string;
				note?: string;
				agent?: unknown;
				rec?: unknown;
			}[]
		).filter((a) => KNOWN_TYPES.has(a.type ?? ""));

		/**
		 * Apply merge to the held payload (single-writer: server owns the state).
		 * corruptPayloadOnDisk already forced HMAC enforcement above; if reached with
		 * it true, the disk copy is unusable — start clean rather than re-throwing.
		 */
		const payloadToMerge: Record<string, unknown> = heldPayload
			? { ...heldPayload }
			: !corruptPayloadOnDisk && existsSync(payloadPath)
				? (JSON.parse(readFileSync(payloadPath, "utf-8")) as Record<
						string,
						unknown
					>)
				: { slug, decisions: [], open_questions: [] };

		mergeResult = doMerge(payloadToMerge, typedAnswers);

		// Update held state with merged result.
		heldState.set(slug, payloadToMerge);

		// Atomic payload write: temp file then renameSync — prevents torn reads by wait.ts.
		atomicWriteJson(payloadPath, payloadToMerge);

		// Write response.json atomically too (rehydrate replays it on restart).
		const responseData = {
			slug,
			answers: finalAnswers,
			nonce: diskNonce,
			hmac: bodyHmac ?? "",
			timestamp: new Date().toISOString(),
		};
		atomicWriteJson(responsePath, responseData);
	});

	if (hmacRejected) {
		return new Response(JSON.stringify({ error: "unauthorized" }), {
			status: 401,
		});
	}

	// Answering un-stales the session
	rmSync(`${dir}/.stale`, { force: true });

	return new Response(JSON.stringify({ ok: true, merge: mergeResult }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
};
