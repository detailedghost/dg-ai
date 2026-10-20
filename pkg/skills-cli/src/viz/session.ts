import { createHash, randomBytes } from "node:crypto";
import {
	existsSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sessionDir, vizConfig } from "./config";
import { die, note } from "./io";
import {
	awaitingVerdictSinceAt,
	clearAwaitingVerdictAt,
	isValidSlug,
	markAwaitingVerdictAt,
} from "./respond-core";

export function validateSlug(s: string): string {
	if (!isValidSlug(s)) {
		throw new Error(
			`invalid slug: "${s}" — must match ^[A-Za-z0-9._-]+$, contain at least one alphanumeric character, not be "." or "..", and be ≤255 characters`,
		);
	}
	return s;
}

function fallbackId(): string {
	return createHash("sha1").update(process.cwd()).digest("hex").slice(0, 8);
}

/** Append the short session id to a slug, idempotently. */
export function namespaceSlug(slug: string, sessionId?: string): string {
	const shortId = (sessionId ?? detectSessionId() ?? fallbackId()).slice(0, 8);
	if (slug.endsWith(`-${shortId}`)) return slug;
	return `${slug}-${shortId}`;
}

/** Current Claude Code session id, from env or this cwd's newest transcript. */
export function detectSessionId(): string | undefined {
	if (process.env.CLAUDE_CODE_SESSION_ID)
		return process.env.CLAUDE_CODE_SESSION_ID;
	if (process.env.CLAUDE_SESSION_ID) return process.env.CLAUDE_SESSION_ID;
	try {
		const enc = process.cwd().replace(/\//g, "-");
		const dir = `${homedir()}/.claude/projects/${enc}`;
		const newest = readdirSync(dir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => ({
				id: f.replace(/\.jsonl$/, ""),
				mtime: statSync(`${dir}/${f}`).mtimeMs,
			}))
			.sort((a, b) => b.mtime - a.mtime)[0];
		return newest?.id;
	} catch {
		return undefined;
	}
}

/** Throws on a corrupt payload so a caller holding a lock unwinds through its finally. */
export function readPayload(slug: string): Record<string, unknown> {
	const path = `${sessionDir(slug)}/payload.json`;
	if (!existsSync(path)) die(`no payload at ${path}`);
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
	} catch {
		throw new Error(`payload.json for "${slug}" is corrupt — unable to read`);
	}
}

/** Temp file plus rename so a concurrent reader never sees a torn payload. */
export function savePayload(
	slug: string,
	payload: Record<string, unknown>,
): void {
	const dir = sessionDir(slug);
	const dest = `${dir}/payload.json`;
	const tmp = join(dir, `.payload-${randomBytes(8).toString("hex")}.tmp`);
	writeFileSync(tmp, JSON.stringify(payload, null, "\t"));
	renameSync(tmp, dest);
}

async function tryNetworkPut(
	slug: string,
	payload: Record<string, unknown>,
): Promise<boolean> {
	const { serverIdentityMatches } = await import("./server");
	if (!(await serverIdentityMatches())) return false;

	const { port } = vizConfig();
	const url = `http://127.0.0.1:${port}/api/${slug}/state`;
	try {
		const res = await fetch(url, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ slug, payload }),
			signal: AbortSignal.timeout(5_000),
		});
		if (res.ok) return true;
		note(
			`putPayload: server rejected PUT for ${slug} (HTTP ${res.status}) — falling back to direct write`,
		);
	} catch (err) {
		note(
			`putPayload: server unreachable for ${slug} (${(err as Error).message}) — falling back to direct write`,
		);
	}
	return false;
}

/** Read, mutate and persist a payload under the slug lock. */
export async function mutatePayload(
	slug: string,
	mutate: (payload: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
	const { withLock } = await import("./lock");
	let payload: Record<string, unknown> = {};

	await withLock(slug, () => {
		payload = readPayload(slug);
		mutate(payload);
	});

	if (await tryNetworkPut(slug, payload)) return payload;

	await withLock(slug, () => {
		payload = readPayload(slug);
		mutate(payload);
		savePayload(slug, payload);
	});
	return payload;
}

export function markStale(slug: string): void {
	try {
		writeFileSync(`${sessionDir(slug)}/.stale`, "");
	} catch {
		return;
	}
}

export function clearStale(slug: string): void {
	try {
		unlinkSync(`${sessionDir(slug)}/.stale`);
	} catch {
		return;
	}
}

export function markAwaitingVerdict(slug: string): void {
	markAwaitingVerdictAt(sessionDir(slug));
}

export function clearAwaitingVerdict(slug: string): void {
	clearAwaitingVerdictAt(sessionDir(slug));
}

export function awaitingVerdictSince(slug: string): number | null {
	return awaitingVerdictSinceAt(sessionDir(slug));
}
