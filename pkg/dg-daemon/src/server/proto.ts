import {
	authorizeFrame,
	CHAT_PROTOCOL_VERSION,
	isRecord,
	type PROTO_RELAY,
	validateChatFrame,
} from "@dg/common";
import type { RelayHooks } from "./browser-relay";

function withoutPreview(raw: Record<string, unknown>): Record<string, unknown> {
	if (!isRecord(raw.data) || !Object.hasOwn(raw.data, "previewDataUrl")) {
		return raw;
	}
	const data = { ...raw.data };
	delete data.previewDataUrl;
	return { ...raw, data };
}

/** Drops an oversized preview so the verdict still reaches the waiting CLI. */
export function protoRelayHooks(): RelayHooks<typeof PROTO_RELAY> {
	return {
		salvage({ raw, socket }) {
			const frame = validateChatFrame(withoutPreview(raw));
			if (frame.type !== "proto-browser-result") {
				throw new Error("prototype result changed type");
			}
			if (frame.protocolVersion !== CHAT_PROTOCOL_VERSION) {
				throw new Error(
					`protocol version mismatch: daemon expects ${CHAT_PROTOCOL_VERSION}`,
				);
			}
			authorizeFrame(frame, socket.data.capabilities);
			return frame;
		},
	};
}
