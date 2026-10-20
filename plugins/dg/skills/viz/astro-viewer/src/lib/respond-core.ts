/**
 * Engine for the respond endpoint — shared between the Astro SSR route
 * (pages/api/respond.ts) and the Bun CLI (common/lock.ts).
 *
 * Lives under astro-viewer/src/lib so the Astro/Vite SSR route can import it
 * within its project root; the Bun CLI reaches in the same way features/track.ts
 * already imports ../../viz/astro-viewer/src/types.ts.
 *
 * Node-compatible only: no Bun.* APIs. All imports from node:* so this
 * module can be required by both the Astro/node SSR runtime and the Bun CLI.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
	closeSync,
	existsSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

/**
 * Evaluated at import time — tests cache-bust with a unique query param (boards_api.test.ts).
 * The one VIZ_DIR fallback chain every server-side file should import rather than re-derive
 * (previously copy-pasted across 5 files, one of which was missing a fallback branch).
 */
export const VIZ_DIR = process.env.VIZ_DIR ?? `${process.env.AI_SCRATCH_DIR ?? "/tmp/ai"}/viz`;
const sessionDir = (slug: string): string => `${VIZ_DIR}/${slug}`;

/**
 * Write JSON atomically: temp file in the SAME directory as the destination (H10)
 * then renameSync. os.tmpdir() can be a different filesystem/mount than VIZ_DIR,
 * and renameSync across filesystems throws EXDEV instead of atomically renaming.
 * Was pasted near-identically in respond.ts and state.ts — one copy here.
 */
export function atomicWriteJson(path: string, data: unknown, mode = 0o600): void {
	const tmp = join(dirname(path), `.viz-write-${randomBytes(8).toString("hex")}.tmp`);
	writeFileSync(tmp, JSON.stringify(data, null, "\t"), { mode });
	renameSync(tmp, path);
}

/**
 * Same-origin check shared by respond.ts and sign.ts (verbatim duplicate before this).
 * PORT is read once per call since each caller may run under a different env snapshot in tests.
 */
export function isAllowedOrigin(origin: string | null): boolean {
	if (!origin) return false;
	const port = parseInt(process.env.VIZ_PORT ?? "4321", 10);
	return origin === `http://localhost:${port}` || origin === `http://127.0.0.1:${port}`;
}

// ── Board marker file ──────────────────────────────────────────────────────────

/**
 * The per-board nonce sidecar render.ts mints. Its presence is THE signal that a
 * dir is a real rendered board (vs a payload-only staging dir). One definition so
 * the minter, the auth reads, and the board-listing filters all key on one file.
 */
export const TOKEN_FILE = ".token";

export function tokenFilePath(dir: string): string {
	return `${dir}/${TOKEN_FILE}`;
}

/**
 * Mint a board's security sidecars: per-board .token (nonce, chmod 600, minted once
 * and preserved on re-mint — re-renders must keep it or open tabs' in-memory copy goes
 * stale) and the shared ${vizDir}/.secret (minted once per VIZ_DIR via O_EXCL, which
 * closes the existsSync+writeFileSync TOCTOU a plain check-then-write would reopen).
 * Single definition so render.ts and review.ts can't drift on this security-sensitive path.
 */
export function mintBoardSecurity(slugDir: string, vizDir: string): void {
	const tokenPath = tokenFilePath(slugDir);
	if (!existsSync(tokenPath)) {
		const nonce = randomBytes(32).toString("hex");
		writeFileSync(tokenPath, nonce, { mode: 0o600 });
	}

	const secretPath = `${vizDir}/.secret`;
	try {
		const fd = openSync(secretPath, "wx", 0o600); // O_CREAT|O_EXCL — atomic, no TOCTOU
		try {
			writeSync(fd, randomBytes(32).toString("hex"));
		} finally {
			closeSync(fd);
		}
	} catch {
		// already exists (winner of the race, or a prior render) — nothing to do
	}
}

export const AWAITING_VERDICT_FILE = ".awaiting-verdict";
/** A review is nobody's problem after this long — bounds how long an abandoned board can block anything. */
export const AWAITING_VERDICT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Spans render → actual collection, surviving submission (unlike `response.json`/`all_clear`).
 * Keyed by board directory — session.ts's slug-based wrappers resolve the dir and delegate here.
 */
export function markAwaitingVerdictAt(dir: string): void {
	try {
		writeFileSync(`${dir}/${AWAITING_VERDICT_FILE}`, new Date().toISOString());
	} catch {
		/* session dir gone — nothing to flag */
	}
}

/** Explicit release path for when no verdict is coming (--no-wait, user cancelled) — not just a side effect of collection. */
export function clearAwaitingVerdictAt(dir: string): void {
	try {
		unlinkSync(`${dir}/${AWAITING_VERDICT_FILE}`);
	} catch {
		/* not awaiting — nothing to clear */
	}
}

/** ms since epoch the marker was set, or null if absent/corrupt — the render this round owes a verdict for. */
export function awaitingVerdictSinceAt(dir: string): number | null {
	const path = `${dir}/${AWAITING_VERDICT_FILE}`;
	if (!existsSync(path)) return null;
	const markedAt = Date.parse(readFileSync(path, "utf-8").trim());
	return Number.isNaN(markedAt) ? null : markedAt;
}

/** False once collected, explicitly dismissed, or past the TTL — never permanently true. */
export function isAwaitingVerdictAt(dir: string): boolean {
	if (!existsSync(`${dir}/${AWAITING_VERDICT_FILE}`)) return false;
	const markedAt = awaitingVerdictSinceAt(dir);
	if (markedAt === null) return true; // present but corrupt — fail toward "still awaiting"
	return Date.now() - markedAt < AWAITING_VERDICT_TTL_MS;
}

const SLUG_MAX_LENGTH = 255;

/**
 * The one slug-charset check every server route should use (M4). Previously
 * sign.ts had its own looser regex (`^[A-Za-z0-9._-]+$` with no ".." or length
 * check) that, unlike respond.ts/state.ts, would accept a literal "..". Also caps
 * length — none of the call sites capped it before, risking ENAMETOOLONG instead
 * of a clean validation error.
 */
export function isValidSlug(slug: string): boolean {
	return (
		slug.length > 0 &&
		slug.length <= SLUG_MAX_LENGTH &&
		!slug.includes("/") &&
		slug !== ".." &&
		slug !== "." &&
		/^[A-Za-z0-9._-]+$/.test(slug) &&
		/[A-Za-z0-9]/.test(slug)
	);
}

// ── Answer identity & accumulation ────────────────────────────────────────────

export type Answer = Record<string, unknown>;

/**
 * Identity collapses re-answers of the SAME item while keeping DISTINCT items.
 * permission_grant → perm key (in `answer`); recommendation → agent+rec; else type+index.
 * Distinct perms accumulate; re-granting a perm or flipping approve→reject overrides in place.
 */
export function answerIdentity(a: Answer): string {
	const type = String(a.type ?? "");
	if (type === "permission_grant") return `permission_grant:${String(a.answer ?? "")}`;
	if (type === "recommendation") return `recommendation:${String(a.agent ?? "")}:${String(a.rec ?? "")}`;
	return `${type}:${String(a.index ?? "")}`;
}

/**
 * Read-merge-write so one response.json holds EVERY answer given before the orchestrator merges.
 * Without it, rapid clicks (multi-grant, multi-triage) each overwrote the file; only the last
 * survived. Stale/foreign files (nonce mismatch, parse error) are discarded, not merged.
 */
export function accumulate(responsePath: string, diskNonce: string, incoming: Answer[]): Answer[] {
	const merged = new Map<string, Answer>();
	if (existsSync(responsePath)) {
		try {
			const prev = JSON.parse(readFileSync(responsePath, "utf-8")) as {
				answers?: unknown[];
				nonce?: string;
			};
			if (prev.nonce === diskNonce && Array.isArray(prev.answers)) {
				for (const a of prev.answers) merged.set(answerIdentity(a as Answer), a as Answer);
			}
		} catch {
			// corrupt prior file — start fresh rather than reject the new answer
		}
	}
	for (const a of incoming) merged.set(answerIdentity(a), a);
	return [...merged.values()];
}

// ── O_EXCL lock primitives ────────────────────────────────────────────────────
// Single source of the lock mechanics. withRespondLock (node/Astro SSR) and the
// Bun CLI's withLock (common/lock.ts) both build on these — no copy-paste drift.

export const RESPOND_LOCK_STALE_MS = 30_000;

export function lockFilePath(dir: string): string {
	return `${dir}/.lock`;
}

/**
 * Atomic O_EXCL acquire. Returns a fencing token on success (write it into the
 * lock file so lockRelease can verify it's still the current holder before
 * unlinking), or null if already locked.
 *
 * H2: without a fencing token, a stale-lock reap racing against its original
 * (still-running, just slow) holder is an ABA hazard — the reaper's release can
 * delete a THIRD holder's lock if the original holder's release fires late.
 */
export function lockTryAcquire(lockPath: string): string | null {
	const token = randomBytes(16).toString("hex");
	try {
		const fd = openSync(lockPath, "wx"); // O_CREAT | O_EXCL — atomic
		writeSync(fd, token);
		closeSync(fd);
		return token;
	} catch {
		return null;
	}
}

/**
 * True when the lockfile's mtime indicates an abandoned lock. `staleMs` lets the
 * Bun CLI pass its config-driven threshold while the SSR side uses the default.
 */
export function lockIsStale(lockPath: string, staleMs: number = RESPOND_LOCK_STALE_MS): boolean {
	try {
		return Date.now() - statSync(lockPath).mtimeMs > staleMs;
	} catch {
		return true; // gone already — counts as stale
	}
}

/**
 * Delete the lockfile — but only if it still holds `token` (fencing, H2). Without
 * a token (legacy call sites, or a stale reap where the file's contents are
 * irrelevant) it unconditionally unlinks. Tolerates double-release either way.
 */
export function lockRelease(lockPath: string, token?: string): void {
	try {
		if (token !== undefined) {
			const current = readFileSync(lockPath, "utf-8");
			if (current !== token) return; // someone else's lock now — not ours to delete
		}
		unlinkSync(lockPath);
	} catch {
		/* already gone — nothing to do */
	}
}

// ── withRespondLock — node-compatible retry loop ──────────────────────────────
// Used by the Astro SSR endpoint (which runs under node, not Bun).
// For the Bun CLI side, lock.ts keeps its own env-configurable loop (Bun.sleep)
// but builds it from the same primitives above.

const RESPOND_LOCK_TIMEOUT_MS = 10_000;
const RESPOND_LOCK_RETRY_MS = 50;

const nodeSetTimeout = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * O_EXCL lock on ${dir}/.lock — mutual exclusion for concurrent in-flight
 * POSTs (rapid multi-click) AND the merge consumer. Without it the accumulate
 * read-merge-write is TOCTOU: two overlapping requests both read the old file
 * and one clobbers.
 */
export async function withRespondLock<T>(dir: string, fn: () => Promise<T> | T): Promise<T> {
	const path = lockFilePath(dir);
	const deadline = Date.now() + RESPOND_LOCK_TIMEOUT_MS;

	for (;;) {
		if (lockIsStale(path)) lockRelease(path);

		const token = lockTryAcquire(path);
		if (token !== null) {
			try {
				return await fn();
			} finally {
				lockRelease(path, token);
			}
		}

		if (Date.now() >= deadline) {
			throw new Error(`respond: lock timeout for ${dir}`);
		}

		await nodeSetTimeout(RESPOND_LOCK_RETRY_MS);
	}
}

// ── Merge logic — shared between CLI (merge.ts) and server (respond.ts Slice 2) ─

/**
 * Top-level payload keys ONLY /api/respond's doMerge ever mutates as whole values
 * (not sub-fields the CLI also touches, like decisions[].rationale via annotate.ts).
 * A CLI PUT must never let its own possibly-stale copy of these win over heldState's —
 * heldState is always at least as fresh, since every respond POST updates it
 * synchronously before releasing the lock.
 */
const SERVER_OWNED_WHOLE_KEYS = [
	"open_questions",
	"open_questions_resolved",
	"approved",
	"approval_note",
	"review_result",
	"all_clear",
] as const;

/** decisions[]/permissions[]/roundtable[].recommendations[] sub-fields doMerge writes;
 * heldState's copy wins for exactly these, per-entry, everything else is incoming's. */
const SERVER_OWNED_DECISION_FIELDS = ["answer", "thread"] as const;
const DEFAULT_PR_REGENERATE_GUIDANCE = "Generate a new PR message.";

function mergeDecisions(current: unknown, incoming: unknown): unknown {
	if (!Array.isArray(incoming)) return incoming;
	if (!Array.isArray(current)) return incoming;
	return incoming.map((inc: Record<string, unknown>, i: number) => {
		const cur = current[i] as Record<string, unknown> | undefined;
		if (!cur || typeof inc !== "object" || inc === null) return inc;
		const merged = { ...inc };
		for (const field of SERVER_OWNED_DECISION_FIELDS) {
			if (field in cur) merged[field] = cur[field];
		}
		return merged;
	});
}

function mergePermissions(current: unknown, incoming: unknown): unknown {
	if (!Array.isArray(incoming) || !Array.isArray(current)) return incoming;
	return incoming.map((inc: Record<string, unknown>, i: number) => {
		const cur = current[i] as Record<string, unknown> | undefined;
		if (!cur || typeof inc !== "object" || inc === null) return inc;
		return "granted" in cur ? { ...inc, granted: cur.granted } : inc;
	});
}

function mergeRoundtable(current: unknown, incoming: unknown): unknown {
	if (!Array.isArray(incoming) || !Array.isArray(current)) return incoming;
	return incoming.map((incAgent: Record<string, unknown>, i: number) => {
		const curAgent = current[i] as Record<string, unknown> | undefined;
		const incRecs = incAgent?.recommendations;
		const curRecs = curAgent?.recommendations;
		if (!Array.isArray(incRecs) || !Array.isArray(curRecs)) return incAgent;
		return {
			...incAgent,
			recommendations: incRecs.map((r: Record<string, unknown>, j: number) => {
				const curR = curRecs[j] as Record<string, unknown> | undefined;
				return curR && "outcome" in curR ? { ...r, outcome: curR.outcome } : r;
			}),
		};
	});
}

/**
 * Merge a CLI PUT's full-payload snapshot on top of the server's held state without
 * letting the CLI's (possibly stale) copy clobber fields /api/respond has since
 * updated (C6). Field-level, not a blind top-level spread: whole server-owned keys
 * take heldState's value outright; decisions/permissions/roundtable are merged
 * per-entry so CLI-only edits (e.g. annotate.ts's decisions[].rationale) still land.
 */
export function mergeStateUpdate(
	current: Record<string, unknown>,
	incoming: Record<string, unknown>,
): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...current, ...incoming };
	for (const key of SERVER_OWNED_WHOLE_KEYS) {
		if (key in current) merged[key] = current[key];
	}
	if ("decisions" in incoming) merged.decisions = mergeDecisions(current.decisions, incoming.decisions);
	if ("permissions" in incoming) merged.permissions = mergePermissions(current.permissions, incoming.permissions);
	if ("roundtable" in incoming) merged.roundtable = mergeRoundtable(current.roundtable, incoming.roundtable);
	return merged;
}

export const KNOWN_TYPES = new Set([
	"decision",
	"decision_question",
	"open_question",
	"recommendation",
	"approval",
	"permission_grant",
	"permission_set",
	"review_submit",
	"pr_decision",
	"next_steps_review",
]);

/**
 * Validate response.json HMAC using the disk nonce (never trusts body nonce). Fail-closed.
 * Returns 'skip' only for legacy boards with no approval/permissions AND no security layer.
 * Boards with approval/permissions always enforce — forceEnforce:true.
 */
export function validateHmac(
	slug: string,
	answers: unknown[],
	bodyHmac: string | undefined,
	forceEnforce = false,
): boolean | "skip" {
	const tokenPath = `${sessionDir(slug)}/.token`;
	const secretPath = `${VIZ_DIR}/.secret`;
	const payloadPath = `${sessionDir(slug)}/payload.json`;
	const tokenExists = existsSync(tokenPath);

	/**
	 * H8: the "was this board ever secured" decision must not rest ENTIRELY on
	 * live FS re-derivation — a race that removes .secret and .token together
	 * (e.g. a cleanup step) would otherwise make validateHmac see "neither file
	 * exists" and wrongly conclude "never secured." render.ts bakes `_secured:
	 * true` into payload.json at mint time; if that flag is present, the legacy
	 * skip is never available regardless of what the FS currently shows.
	 */
	let everSecured = false;
	if (existsSync(payloadPath)) {
		try {
			const payload = JSON.parse(readFileSync(payloadPath, "utf-8")) as {
				_secured?: boolean;
			};
			everSecured = payload._secured === true;
		} catch {
			// corrupt payload — err toward "was secured" (fail-closed), not skip.
			everSecured = true;
		}
	}

	// Legacy mode: security layer never provisioned AND board has no approval/permissions gate.
	if (!forceEnforce && !everSecured && !existsSync(secretPath) && !tokenExists && !bodyHmac) return "skip";

	// Security active: enforce fully — missing .secret or .token is fail-closed
	if (!existsSync(secretPath)) return false;
	if (!tokenExists) return false;

	// Response written to disk without hmac (bypassed server) — reject
	if (!bodyHmac) return false;

	const diskNonce = readFileSync(tokenPath, "utf-8").trim();
	const secret = readFileSync(secretPath, "utf-8").trim();

	const expected = createHmac("sha256", secret)
		.update(slug + JSON.stringify(answers) + diskNonce)
		.digest("hex");

	const eBuf = Buffer.from(expected, "utf-8");
	const bBuf = Buffer.from(bodyHmac, "utf-8");
	if (eBuf.length !== bBuf.length) return false;
	return timingSafeEqual(eBuf, bBuf);
}

type MergeAnswerItem = {
	type: string;
	index: number;
	answer: string;
	note?: string;
	agent?: unknown;
	rec?: unknown;
};

export type MergeSummary = {
	resolved: string[];
	threads: { index: number; question: string; userText: string }[];
	pending_decisions: { index: number; question: string }[];
	open_questions_remaining: number;
	approved: boolean | undefined;
	approval_required: boolean;
	approval_note?: string;
	recommendations_triaged: number;
	recommendations_pending: number;
	next_steps_approved?: boolean;
	next_steps_feedback_pending: boolean;
	all_clear: boolean;
};

/**
 * Pure merge state transformation. Applies answers to the payload in place and
 * returns the updated payload plus a summary. No I/O — callers handle reading,
 * locking, and persisting. Node-compatible (no Bun.* APIs).
 */
const TBD = "tbd";

/**
 * The single definition of "what blocks the agent", read by both `doMerge` and the board's
 * activity rail. Payload-only: per-request discussion threads are not payload state, so
 * `doMerge` folds those into its own `all_clear`.
 */
export interface GateState {
	pendingDecisions: { index: number; question: string }[];
	openQuestionsRemaining: number;
	approvalRequired: boolean;
	approved: boolean | undefined;
	approvalBlocks: boolean;
	permissionsUngranted: number;
	permissionsBlock: boolean;
	recommendationsPending: number;
	recommendationsTriaged: number;
	roundtableBlocks: boolean;
	nextStepsReviewRequired: boolean;
	nextStepsApproved: boolean | undefined;
	nextStepsFeedbackPending: boolean;
	nextStepsBlocks: boolean;
	allClear: boolean;
}

export function computeGates(payload: Record<string, unknown>): GateState {
	const decisions = Array.isArray(payload.decisions)
		? (payload.decisions as { question: string; answer?: string }[])
		: [];
	const pendingDecisions = decisions
		.map((d, index) => ({ d, index }))
		.filter(({ d }) => !d.answer || d.answer === TBD)
		.map(({ d, index }) => ({ index, question: d.question }));

	const openQuestionsRemaining = Array.isArray(payload.open_questions) ? payload.open_questions.length : 0;

	const approval = payload.approval as { required?: boolean } | undefined;
	const approvalRequired = !!approval?.required;
	const approved = payload.approved as boolean | undefined;
	const approvalBlocks = approvalRequired && !approved;

	const permissions = Array.isArray(payload.permissions) ? (payload.permissions as { granted?: boolean }[]) : undefined;
	const permissionsUngranted = permissions ? permissions.filter((p) => !p.granted).length : 0;
	const permissionsBlock = permissions !== undefined && permissionsUngranted > 0;

	const roundtable = Array.isArray(payload.roundtable)
		? (payload.roundtable as { recommendations?: { outcome?: string }[] }[])
		: undefined;
	const countRecs = (match: (r: { outcome?: string }) => boolean) =>
		roundtable
			? roundtable.reduce(
					(sum, a) => sum + (Array.isArray(a.recommendations) ? a.recommendations.filter(match).length : 0),
					0,
				)
			: 0;
	const recommendationsPending = countRecs((r) => !r.outcome);
	const recommendationsTriaged = countRecs((r) => !!r.outcome);
	const roundtableBlocks = roundtable !== undefined && recommendationsPending > 0;

	const nextStepsReview = payload.next_steps_review as { required?: boolean } | undefined;
	const nextStepsReviewRequired = !!nextStepsReview?.required;
	const nextStepsApproved = payload.next_steps_approved as boolean | undefined;
	const nextStepsFeedbackPending = payload.next_steps_feedback_pending === true;
	const nextStepsBlocks = nextStepsFeedbackPending || (nextStepsReviewRequired && nextStepsApproved !== true);

	return {
		pendingDecisions,
		openQuestionsRemaining,
		approvalRequired,
		approved,
		approvalBlocks,
		permissionsUngranted,
		permissionsBlock,
		recommendationsPending,
		recommendationsTriaged,
		roundtableBlocks,
		nextStepsReviewRequired,
		nextStepsApproved,
		nextStepsFeedbackPending,
		nextStepsBlocks,
		allClear:
			pendingDecisions.length === 0 &&
			openQuestionsRemaining === 0 &&
			!approvalBlocks &&
			!permissionsBlock &&
			!roundtableBlocks &&
			!nextStepsBlocks,
	};
}

export type BoardStatus = "live" | "awaiting" | "settled" | "stale";

export function computeBoardStatus(dir: string, payload: Record<string, unknown>): BoardStatus {
	if (existsSync(`${dir}/.stale`)) return "stale";
	if (isAwaitingVerdictAt(dir)) return "awaiting";
	if (!computeGates(payload).allClear) return "live";
	return "settled";
}

export function doMerge(payload: Record<string, unknown>, answers: MergeAnswerItem[]): MergeSummary {
	if (!Array.isArray(payload.decisions)) payload.decisions = [];
	if (!Array.isArray(payload.open_questions)) payload.open_questions = [];
	if (!Array.isArray(payload.open_questions_resolved)) payload.open_questions_resolved = [];

	const decisions = payload.decisions as {
		question: string;
		answer?: string;
		thread?: { role: string; text: string }[];
	}[];
	const openQuestions = payload.open_questions as string[];
	const resolvedOpenQuestions = payload.open_questions_resolved as {
		question: string;
		answer: string;
	}[];
	const roundtable = Array.isArray(payload.roundtable)
		? (payload.roundtable as {
				name: string;
				recommendations: { text: string; outcome?: string }[];
			}[])
		: undefined;

	const resolved: string[] = [];
	const threads: { index: number; question: string; userText: string }[] = [];
	const answeredIndices: number[] = [];

	let approvedVerdict: boolean | undefined;
	let approvalNote: string | undefined;

	// A blank answer must never resolve an item — leave it pending so the loop continues.
	const isBlank = (s?: string) => !s || s.trim() === "";

	for (const ans of answers) {
		if (isBlank(ans.answer)) continue;

		if (ans.type === "approval") {
			if (ans.answer === "rejected") {
				approvedVerdict = false;
				approvalNote = ans.note;
			} else if (ans.answer === "approved") {
				approvedVerdict = true;
				approvalNote = ans.note;
			}
		} else if (ans.type === "decision") {
			const d = decisions[ans.index];
			if (d) {
				d.answer = ans.answer;
				d.thread = [];
				resolved.push(`decision[${ans.index}]: "${d.question}" → "${ans.answer}"`);
			}
		} else if (ans.type === "decision_question") {
			const d = decisions[ans.index];
			if (d) {
				if (!Array.isArray(d.thread)) d.thread = [];
				/**
				 * H7: a replayed POST (client retry after a timeout, even though the
				 * first attempt actually landed) re-delivers the identical accumulated
				 * answer. accumulate()'s identity map is a no-op on replay (same
				 * identity, same text), but doMerge itself had no matching guard — it
				 * unconditionally pushed, growing the thread by a duplicate entry on
				 * every replay. Skip only when the immediately preceding entry is the
				 * exact same user message; a legitimately repeated question text sent
				 * as a NEW answer still lands (this only catches back-to-back identical
				 * replays of the same thread position).
				 */
				const last = d.thread[d.thread.length - 1] as { role: string; text: string } | undefined;
				const isReplay = last !== undefined && last.role === "user" && last.text === ans.answer;
				if (!isReplay) {
					d.thread.push({ role: "user", text: ans.answer });
					threads.push({
						index: ans.index,
						question: d.question,
						userText: ans.answer,
					});
				}
			}
		} else if (ans.type === "open_question") {
			const q = openQuestions[ans.index];
			if (q !== undefined) {
				resolvedOpenQuestions.push({ question: q, answer: ans.answer });
				answeredIndices.push(ans.index);
				resolved.push(`open_question[${ans.index}]: "${q}" → "${ans.answer}"`);
			}
		} else if (ans.type === "recommendation") {
			const agent = ans.agent;
			const rec = ans.rec;
			// -0 collapses to 0 through JSON round-trip; < 0 checks cover all negatives.
			if (
				typeof agent !== "number" ||
				typeof rec !== "number" ||
				!Number.isInteger(agent) ||
				!Number.isInteger(rec) ||
				agent < 0 ||
				rec < 0 ||
				!roundtable ||
				agent >= roundtable.length ||
				!Array.isArray(roundtable[agent]?.recommendations) ||
				rec >= roundtable[agent].recommendations.length
			) {
				continue;
			}
			if (!["accepted", "rejected", "deferred"].includes(ans.answer)) continue;
			roundtable[agent].recommendations[rec].outcome = ans.answer as "accepted" | "rejected" | "deferred";
		} else if (ans.type === "permission_grant") {
			const perms = Array.isArray(payload.permissions)
				? (payload.permissions as { key: string; granted: boolean }[])
				: undefined;
			if (perms) {
				const idx = perms.findIndex((p) => p.key === ans.answer);
				if (idx !== -1) perms[idx].granted = true;
			}
		} else if (ans.type === "permission_set") {
			const perms = Array.isArray(payload.permissions)
				? (payload.permissions as { key: string; granted: boolean }[])
				: undefined;
			if (perms) {
				let keys: unknown;
				try {
					keys = JSON.parse(ans.answer);
				} catch {
					continue;
				}
				if (!Array.isArray(keys)) continue;
				const selected = new Set(keys.map(String));
				for (const p of perms) p.granted = selected.has(p.key);
				resolved.push(`permission_set: ${selected.size} of ${perms.length} granted`);
			}
		} else if (ans.type === "review_submit") {
			// answer is the whole review, JSON-stringified — allClear falls through to true
			// below (a review has no decisions/approval/permissions gates) once this lands.
			try {
				payload.review_result = JSON.parse(ans.answer) as unknown;
				resolved.push("review_submit: review submitted");
			} catch {
				// malformed JSON from a hand-crafted POST — drop rather than corrupt the payload
			}
		} else if (ans.type === "pr_decision") {
			// { action, body, guidance? } JSON — mirrors review_submit; allClear falls through.
			try {
				const decision = JSON.parse(ans.answer) as Record<string, unknown>;
				if (
					decision.action === "regenerate" &&
					(typeof decision.guidance !== "string" || decision.guidance.trim() === "")
				) {
					decision.guidance = DEFAULT_PR_REGENERATE_GUIDANCE;
				}
				payload.pr_decision = decision;
				resolved.push("pr_decision: decision submitted");
			} catch {
				// malformed JSON from a hand-crafted POST — drop rather than corrupt the payload
			}
		} else if (ans.type === "next_steps_review") {
			try {
				const review = JSON.parse(ans.answer) as {
					action?: string;
					comment?: string;
				};
				if (review.action === "approved") {
					payload.next_steps_approved = true;
					payload.next_steps_feedback_pending = false;
					resolved.push("next_steps_review: approved");
				} else if (review.action === "comment") {
					const comment = review.comment?.trim();
					if (!comment) continue;
					const feedback = Array.isArray(payload.next_steps_feedback)
						? (payload.next_steps_feedback as Record<string, unknown>[])
						: [];
					feedback.push({ comment, resolved: false });
					payload.next_steps_feedback = feedback;
					payload.next_steps_approved = false;
					payload.next_steps_feedback_pending = true;
					resolved.push("next_steps_review: comment submitted");
				}
			} catch {
				// ignore malformed hand-crafted payloads
			}
		}
	}

	// Remove resolved questions highest-index first to preserve lower indices
	for (const i of answeredIndices.sort((a, b) => b - a)) {
		openQuestions.splice(i, 1);
	}

	if (approvedVerdict !== undefined) {
		payload.approved = approvedVerdict;
	}
	if (approvalNote !== undefined) {
		payload.approval_note = approvalNote;
	}

	const gates = computeGates(payload);
	const allClear = gates.allClear && threads.length === 0;

	payload.all_clear = allClear;

	return {
		resolved,
		threads,
		pending_decisions: gates.pendingDecisions,
		open_questions_remaining: gates.openQuestionsRemaining,
		approved: gates.approved,
		approval_required: gates.approvalRequired,
		...(payload.approval_note !== undefined ? { approval_note: payload.approval_note as string } : {}),
		recommendations_triaged: gates.recommendationsTriaged,
		recommendations_pending: gates.recommendationsPending,
		next_steps_approved: gates.nextStepsApproved,
		next_steps_feedback_pending: gates.nextStepsFeedbackPending,
		all_clear: allClear,
	};
}
