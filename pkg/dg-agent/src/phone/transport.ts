import { lstatSync } from "node:fs";
import { join } from "node:path";
import type { DgPaths } from "@dg/common/node";
import { nip19 } from "nostr-tools";
import { FILE_REQUEST_KIND, type FileRequestRumor, type KeyEntry, type PhonePool, publish, shouldSaveOutgoing, wrapTagged } from "./chat";
import { OUTBOX_DIR, type PhoneDb } from "./db";
import { MAX_IMAGE_BYTES } from "./image";
import { findContactByNpub } from "./store";
import {
	ensureWormhole,
	type ReceiveResult,
	WORMHOLE_CODE_PATTERN,
	wormholeCode,
	type WormholeDeps,
	wormholeReceive,
	wormholeSend,
} from "./wormhole";

const X_PATTERN = /^[0-9a-f]{64}$/;
const GCM_TAG_BYTES = 16;
const MAX_CIPHER_BYTES = MAX_IMAGE_BYTES + GCM_TAG_BYTES;
/** A request whose `created_at` is further than this from the sender's clock is ignored. */
export const REQUEST_SKEW_SECONDS = 5 * 60;
const SEEN_SECONDS = 60 * 60;
const SEND_QUEUE_DEPTH = 4;
/** Sends one contact may start in a rolling day. */
export const DAILY_REQUEST_CAP = 20;
const DAY_SECONDS = 24 * 60 * 60;

export type FileFetch = ReceiveResult | { ok: false; reason: "request not sent" };

/** The kind 15 fields one fetch needs: `senderPub` signed the rumor, and `key` is our key it was addressed to. */
export type FileTarget = { x: string; size: number; senderPub: string; key: KeyEntry; relays: string[] };

export type RequestDeps = { pool: PhonePool; paths: DgPaths; wormhole?: WormholeDeps; signal?: AbortSignal };

/** One fetch attempt on a fresh code; the caller owns retry, backoff, and the give-up time. */
export async function requestFile(target: FileTarget, deps: RequestDeps): Promise<FileFetch> {
	if (!X_PATTERN.test(target.x) || !Number.isSafeInteger(target.size) || target.size <= 0) return { ok: false, reason: "bad offer" };
	if (target.size > MAX_CIPHER_BYTES) return { ok: false, reason: "too large" };
	try {
		await ensureWormhole(deps.paths, deps.wormhole);
	} catch {
		return { ok: false, reason: "tool unavailable" };
	}
	const code = wormholeCode();
	const event = wrapTagged(
		{
			kind: FILE_REQUEST_KIND,
			content: "",
			tags: [
				["x", target.x],
				["code", code],
			],
		},
		target.key.sk,
		target.senderPub,
	);
	const report = await publish(deps.pool, target.relays, event).catch(() => undefined);
	if (!report || !shouldSaveOutgoing(report)) return { ok: false, reason: "request not sent" };
	return wormholeReceive(deps.paths, { code, x: target.x, size: target.size }, deps.wormhole, deps.signal);
}

export type FileRequestHandler = {
	handle(request: FileRequestRumor): void;
	/** Drops queued requests and kills the running send. */
	stop(): void;
	settle(): Promise<void>;
};

type SendJob = { slot: string; code: string; file: string };

function tagValue(tags: string[][], name: string): string | undefined {
	const value = tags.find((tag) => tag[0] === name)?.[1];
	return typeof value === "string" ? value : undefined;
}

/** The sender side: checks each request, then runs one `send` at a time. Every refusal is silent. */
export function createFileRequestHandler(deps: { db: PhoneDb; paths: DgPaths; now: () => number; wormhole?: WormholeDeps }): FileRequestHandler {
	const seen = new Map<string, number>();
	const open = new Set<string>();
	const started = new Map<string, number[]>();
	const queue: SendJob[] = [];
	const controller = new AbortController();
	let running: Promise<void> | undefined;

	const forget = (now: number) => {
		for (const [key, until] of seen) {
			if (until > now) break;
			seen.delete(key);
		}
	};

	const accept = (request: FileRequestRumor): SendJob | undefined => {
		const now = deps.now();
		const x = tagValue(request.tags, "x");
		const code = tagValue(request.tags, "code");
		if (!x || !X_PATTERN.test(x) || !code || !WORMHOLE_CODE_PATTERN.test(code)) return undefined;
		if (Math.abs(now - request.createdAt) > REQUEST_SKEW_SECONDS) return undefined;
		if (!findContactByNpub(deps.db, nip19.npubEncode(request.from))) return undefined;
		forget(now);
		const idKey = `id:${request.id}`;
		const codeKey = `code:${code}`;
		if (seen.has(idKey) || seen.has(codeKey)) return undefined;
		seen.set(idKey, now + SEEN_SECONDS);
		seen.set(codeKey, now + SEEN_SECONDS);
		if (deps.db.outboxKeyId(x) !== request.keyId || !deps.db.outboxRecipients(x).includes(request.from)) return undefined;
		const file = join(deps.paths.phoneRoot, OUTBOX_DIR, x);
		if (!lstatSync(file, { throwIfNoEntry: false })?.isFile()) return undefined;
		const slot = `${request.from}:${x}`;
		if (open.has(slot) || queue.length >= SEND_QUEUE_DEPTH) return undefined;
		const recent = (started.get(request.from) ?? []).filter((at) => at > now - DAY_SECONDS);
		if (recent.length >= DAILY_REQUEST_CAP) return undefined;
		started.set(request.from, [...recent, now]);
		open.add(slot);
		return { slot, code, file };
	};

	const pump = () => {
		if (running || controller.signal.aborted) return;
		const job = queue.shift();
		if (!job) return;
		running = wormholeSend(deps.paths, { code: job.code, file: job.file }, deps.wormhole, controller.signal)
			.catch(() => "failed" as const)
			.then(() => {
				open.delete(job.slot);
				running = undefined;
				pump();
			});
	};

	return {
		handle(request) {
			if (controller.signal.aborted) return;
			const job = accept(request);
			if (!job) return;
			queue.push(job);
			pump();
		},
		stop() {
			queue.length = 0;
			controller.abort();
		},
		async settle() {
			while (running) await running;
		},
	};
}
