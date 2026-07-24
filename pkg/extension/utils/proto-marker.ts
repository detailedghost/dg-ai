/**
 * The `_proto` URL marker. The CLI appends
 * `#…&_proto=<base64url(gzip(json))>` for prototype scrape/plant handoff; this
 * reads the payload and strips the marker. The fragment never reaches the
 * server. Mirrors pkg/skills-cli/src/utils/proto-marker.ts (separate build
 * roots; do not import one twin from the other).
 */

import {
	PROTO_MAX_MARKUP_CHARS,
	PROTO_MAX_VARIATIONS,
	type ProtoPlan,
	validateProtoIdentifier,
	validateProtoPlan,
	validateProtoRenderLimits,
} from "@dg/common";

/** Fragment key used for the CLI-to-extension prototype handoff. */
export const PROTO_MARKER_KEY = "_proto";
/** Mirrors the CLI's conservative complete-URL transport ceiling. */
export const PROTO_ENCODED_MAX_LENGTH = 32_000;
/** Caps gzip expansion before text or JSON allocation. */
export const PROTO_EXPANDED_MAX_BYTES = 1_048_576;
export { PROTO_MAX_MARKUP_CHARS, PROTO_MAX_VARIATIONS };

/** Validated scrape or plant payload accepted from a `_proto` marker. */
export type ProtoPayload =
	| { phase: "scrape"; slug: string }
	| { phase: "plant"; slug: string; plan: ProtoPlan };

function isProtoPayload(value: unknown): value is ProtoPayload {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	try {
		validateProtoIdentifier(candidate.slug, "prototype payload.slug");
	} catch {
		return false;
	}
	if (candidate.phase === "scrape") return true;
	if (candidate.phase !== "plant") return false;

	try {
		const plan = validateProtoPlan(candidate.plan);
		return (
			plan.slug === candidate.slug && validateProtoRenderLimits(plan) === plan
		);
	} catch {
		return false;
	}
}

async function readBoundedDecompression(
	stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array | undefined> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (total + value.byteLength > PROTO_EXPANDED_MAX_BYTES) {
				await reader.cancel("prototype marker expansion exceeds limit");
				return undefined;
			}
			chunks.push(value);
			total += value.byteLength;
		}
	} finally {
		reader.releaseLock();
	}

	const output = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return output;
}

async function decodePayload(
	encoded: string,
): Promise<ProtoPayload | undefined> {
	if (encoded.length > PROTO_ENCODED_MAX_LENGTH) return undefined;
	try {
		const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
		const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
		const compressed = Uint8Array.from(atob(padded), (byte) =>
			byte.charCodeAt(0),
		);
		const source = new Blob([compressed]).stream();
		const decompressed = source.pipeThrough(new DecompressionStream("gzip"));
		const expanded = await readBoundedDecompression(decompressed);
		if (!expanded) return undefined;
		const parsed: unknown = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(expanded),
		);
		return isProtoPayload(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/** Always-gzipped prototype payload from the fragment, or undefined if invalid. */
export async function readProtoPayload(
	url: string,
): Promise<ProtoPayload | undefined> {
	const hashIndex = url.indexOf("#");
	if (hashIndex < 0) return undefined;
	const hash = url.slice(hashIndex + 1);

	for (const part of hash.split("&")) {
		const separator = part.indexOf("=");
		const key = separator < 0 ? part : part.slice(0, separator);
		const value = separator < 0 ? "" : part.slice(separator + 1);
		if (key === PROTO_MARKER_KEY && value) return decodePayload(value);
	}
	return undefined;
}

/** URL with only `_proto` removed; unrelated fragment entries remain byte-for-byte. */
export function stripProtoMarker(url: string): string {
	const hashIndex = url.indexOf("#");
	if (hashIndex < 0) return url;
	const base = url.slice(0, hashIndex);
	const hash = url.slice(hashIndex + 1);
	const kept = hash
		.split("&")
		.filter((part) => part.split("=", 1)[0] !== PROTO_MARKER_KEY);
	return kept.length > 0 ? `${base}#${kept.join("&")}` : base;
}
