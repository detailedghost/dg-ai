/**
 * Append the `_proto` marker the dg-ai-extension consumes for prototype work.
 * Payloads ride in the URL fragment as base64url(gzip(JSON)), so the server
 * never sees them. Mirrors pkg/extension/utils/proto-marker.ts (separate build
 * roots; do not import one twin from the other).
 */

import { gzipSync } from "node:zlib";
import {
	PROTO_MARKER_KEY,
	PROTO_MARKER_URL_MAX_LENGTH,
	type ProtoPayload,
} from "@dg/common";

export { PROTO_MARKER_KEY, type ProtoPayload };

/**
 * The WSL Start-Process path is the lowest-common-denominator among supported
 * openers, so every opener intentionally uses the same conservative ~32K cap.
 */
export const PROTO_URL_MAX_LENGTH = PROTO_MARKER_URL_MAX_LENGTH;

function encodeProtoPayload(payload: ProtoPayload): string {
	return gzipSync(Buffer.from(JSON.stringify(payload), "utf8")).toString(
		"base64url",
	);
}

function markedProtoUrl(url: string, payload: ProtoPayload): string {
	const marker = `${PROTO_MARKER_KEY}=${encodeProtoPayload(payload)}`;
	const hashIndex = url.indexOf("#");
	if (hashIndex < 0) return `${url}#${marker}`;

	const base = url.slice(0, hashIndex);
	const hash = url.slice(hashIndex + 1);
	const entries = hash
		? hash
				.split("&")
				.filter((entry) => entry.split("=", 1)[0] !== PROTO_MARKER_KEY)
		: [];
	entries.push(marker);
	return `${base}#${entries.join("&")}`;
}

/** Whether the complete marked URL fits the uniform opener-size ceiling. */
export function protoPayloadFits(url: string, payload: ProtoPayload): boolean {
	return markedProtoUrl(url, payload).length <= PROTO_URL_MAX_LENGTH;
}

/** Append an always-gzipped prototype marker, rejecting URLs no opener can carry. */
export function addProtoMarker(url: string, payload: ProtoPayload): string {
	const marked = markedProtoUrl(url, payload);
	if (marked.length > PROTO_URL_MAX_LENGTH) {
		throw new RangeError(
			"Prototype marker exceeds the 32K URL limit; trim your variations and retry.",
		);
	}
	return marked;
}
