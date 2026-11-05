import { lstatSync } from "node:fs";
import { join } from "node:path";
import { type DgPaths, ensurePrivateDir, writeFileAtomic } from "@dg/common/node";
import { nip19 } from "nostr-tools";
import type { KeyEntry, PhonePool } from "./chat";
import type { ImageFetchRow, PhoneDb } from "./db";
import type { Cancel, Schedule } from "./hook";
import {
	FILES_DIR,
	IMAGE_TEXT,
	type ImageFailure,
	type ImageFile,
	imageFileName,
	type ImageType,
	imageUnavailableText,
	openImage,
} from "./image";
import { contactRelays } from "./store";
import { DAILY_REQUEST_CAP, type FileFetch, requestFile } from "./transport";
import { dirBytes, type WormholeDeps } from "./wormhole";

/** Fetches waiting at once; a new image past this is stored as unavailable. */
export const MAX_PENDING_IMAGES = 32;
/** Bytes `files/` may hold before a new image is refused. */
export const FILES_BYTE_CAP = 200 * 1024 * 1024;
/** Wait before the first retry; each later retry doubles it up to an hour. */
export const IMAGE_RETRY_BASE_SECONDS = 60;
const IMAGE_RETRY_MAX_SECONDS = 60 * 60;
const DAY_SECONDS = 24 * 60 * 60;
const TYPES: readonly ImageType[] = ["image/png", "image/jpeg", "image/webp"];

type FetchFailure = Extract<FileFetch, { ok: false }>["reason"];

const RETRY_REASONS: ReadonlySet<FetchFailure> = new Set(["timeout", "no transfer", "request not sent", "tool unavailable"]);

export type ImageReceiverDeps = {
	db: PhoneDb;
	paths: DgPaths;
	pool: PhonePool;
	now: () => number;
	keys: () => readonly KeyEntry[];
	schedule: Schedule;
	wormhole?: WormholeDeps;
	/** A row got its final text; the listener hands it to the hook. */
	onFinish: () => void;
};

export type ImageReceiver = {
	/** Runs every due fetch, one at a time; the point a presence signal can call to retry early. */
	wake(): void;
	/** Kills the running receive and leaves every unfinished fetch in the database for the next start. */
	stop(): void;
	settle(): Promise<void>;
};

function terminalReason(reason: FetchFailure): ImageFailure {
	return reason === "too large" ? "too large" : "fetch failed";
}

/** The listener's fetch queue for `[image pending]` rows: concurrency 1, backoff retries, and a fixed reason when it ends. */
export function createImageReceiver(deps: ImageReceiverDeps): ImageReceiver {
	const dir = join(deps.paths.phoneRoot, FILES_DIR);
	const controller = new AbortController();
	const started = new Map<string, number[]>();
	let running: Promise<void> | undefined;
	let again = false;
	let cancelTimer: Cancel | undefined;

	const finish = (row: ImageFetchRow, text: string, file?: ImageFile) => {
		deps.db.finishImage(row.message_id, text, file ? JSON.stringify(file) : null);
		deps.onFinish();
	};

	const fail = (row: ImageFetchRow, reason: ImageFailure) => finish(row, imageUnavailableText(reason));

	const storedCopy = (ox: string): ImageFile | undefined => {
		if (!deps.db.hasPlainImage(ox)) return undefined;
		for (const type of TYPES) {
			const name = imageFileName({ sha256: ox, type });
			const stat = name ? lstatSync(join(dir, name), { throwIfNoEntry: false }) : undefined;
			if (stat?.isFile()) return { sha256: ox, type, size: stat.size };
		}
		return undefined;
	};

	const withinDailyCap = (sender: string, now: number) => {
		const recent = (started.get(sender) ?? []).filter((at) => at > now - DAY_SECONDS);
		if (recent.length >= DAILY_REQUEST_CAP) return false;
		started.set(sender, [...recent, now]);
		return true;
	};

	const defer = (row: ImageFetchRow, now: number, reason: FetchFailure) => {
		const attempts = row.attempts + 1;
		const delay = Math.min(IMAGE_RETRY_BASE_SECONDS * 2 ** (attempts - 1), IMAGE_RETRY_MAX_SECONDS);
		if (now + delay >= row.deadline) return fail(row, reason === "tool unavailable" ? "fetch failed" : "sender offline");
		deps.db.deferImageFetch(row.message_id, attempts, now + delay);
	};

	const attempt = async (row: ImageFetchRow) => {
		const now = deps.now();
		if (now >= row.deadline) return fail(row, "sender offline");
		const copy = storedCopy(row.ox);
		if (copy) return finish(row, IMAGE_TEXT, copy);
		if (row.attempts === 0 && !withinDailyCap(row.sender, now)) return fail(row, "daily limit");
		ensurePrivateDir(dir);
		if (dirBytes(dir) >= FILES_BYTE_CAP) return fail(row, "storage full");
		const key = deps.keys().find((entry) => entry.id === row.key_id);
		if (!key) return defer(row, now, "request not sent");
		const result = await requestFile(
			{ x: row.x, size: row.size, senderPub: row.sender, key, relays: contactRelays(deps.db, nip19.npubEncode(row.sender)) },
			{ pool: deps.pool, paths: deps.paths, wormhole: deps.wormhole, signal: controller.signal },
		);
		if (controller.signal.aborted) return;
		const live = deps.db.imageFetches().find((candidate) => candidate.message_id === row.message_id);
		if (!live) return;
		if (deps.now() >= live.deadline) return fail(live, "sender offline");
		if (!result.ok) return RETRY_REASONS.has(result.reason) ? defer(live, deps.now(), result.reason) : fail(live, terminalReason(result.reason));
		const opened = openImage(result.cipher, row);
		if (!opened.ok) return fail(row, opened.reason);
		const file: ImageFile = { sha256: row.ox, type: opened.type, size: opened.plain.length };
		const name = imageFileName(file);
		if (!name) return fail(row, "fetch failed");
		writeFileAtomic(join(dir, name), opened.plain, 0o600);
		finish(row, IMAGE_TEXT, file);
	};

	const arm = (rows: readonly ImageFetchRow[], now: number) => {
		cancelTimer?.();
		cancelTimer = undefined;
		const next = rows[0];
		if (!next) return;
		cancelTimer = deps.schedule(Math.max(0, next.next_at - now) * 1000, () => {
			cancelTimer = undefined;
			wake();
		});
	};

	const drain = async () => {
		for (;;) {
			if (controller.signal.aborted) return;
			const now = deps.now();
			const rows = deps.db.imageFetches();
			const due = rows.find((row) => row.next_at <= now);
			if (!due) return arm(rows, now);
			try {
				await attempt(due);
			} catch {
				if (controller.signal.aborted) return;
				fail(due, "fetch failed");
			}
		}
	};

	const wake = () => {
		if (controller.signal.aborted) return;
		if (running) {
			again = true;
			return;
		}
		running = drain()
			.catch(() => {})
			.finally(() => {
				running = undefined;
				if (!again) return;
				again = false;
				wake();
			});
	};

	return {
		wake,
		stop() {
			controller.abort();
			cancelTimer?.();
			cancelTimer = undefined;
		},
		async settle() {
			while (running) await running;
		},
	};
}
