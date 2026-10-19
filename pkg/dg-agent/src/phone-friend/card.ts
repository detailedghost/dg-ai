import { DgCliError } from "@dg/common";
import { nip19 } from "nostr-tools";

export type Card = { npub: string; relays: string[]; secret: string; exp: number };

export const CARD_PREFIX = "dgcall1";
const CARD_VERSION = 1;
const SECRET_PATTERN = /^[0-9a-f]{64}$/;

export function encodeCard(card: Card): string {
	const body = { v: CARD_VERSION, ...card };
	return CARD_PREFIX + Buffer.from(JSON.stringify(body)).toString("base64url");
}

function invalid(reason: string): never {
	throw new DgCliError(`not a valid phone-friend call card: ${reason}`);
}

/** Validates every field, so a pasted card can be trusted only as far as its own contents. */
export function decodeCard(text: string, now: number): Card {
	const trimmed = text.trim();
	if (!trimmed.startsWith(CARD_PREFIX)) invalid(`it must start with ${CARD_PREFIX}`);
	let body: Record<string, unknown>;
	try {
		body = JSON.parse(Buffer.from(trimmed.slice(CARD_PREFIX.length), "base64url").toString("utf8"));
	} catch {
		invalid("it does not decode");
	}
	if (typeof body !== "object" || body === null) invalid("it does not decode");
	const { v, npub, relays, secret, exp } = body;
	if (v !== CARD_VERSION) invalid(`unknown version ${String(v)}`);
	try {
		if (typeof npub !== "string" || nip19.decode(npub).type !== "npub") invalid("bad npub");
	} catch {
		invalid("bad npub");
	}
	if (
		!Array.isArray(relays) ||
		relays.length === 0 ||
		!relays.every((relay) => typeof relay === "string" && /^wss:\/\/[^\s/]+/.test(relay))
	) {
		invalid("relays must be wss:// URLs");
	}
	if (typeof secret !== "string" || !SECRET_PATTERN.test(secret)) invalid("bad secret");
	if (typeof exp !== "number" || !Number.isInteger(exp)) invalid("bad expiry");
	if (exp <= now) throw new DgCliError("this call card has expired; ask for a new one");
	return { npub: npub as string, relays: relays as string[], secret, exp };
}
