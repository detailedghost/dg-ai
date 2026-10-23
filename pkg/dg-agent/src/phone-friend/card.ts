import { DgCliError } from "@dg/common";
import { nip19 } from "nostr-tools";
import { isLineName } from "./line";
import { DEFAULT_RELAYS } from "./store";

export type Card = { npub: string; relays: string[]; secret: string; exp: number; handle?: string };

/** v1: JSON, base64url. Kept so an old card still dials; `invite`/`card` emit v2 only. */
export const CARD_PREFIX_V1 = "dgcall1";
/** v2: a fixed binary layout, base64url. See `encodeCard`/`decodeCardV2` for the field order. */
export const CARD_PREFIX = "dgcall2";
const SECRET_HEX_PATTERN = /^[0-9a-f]{64}$/;
const RELAY_PATTERN = /^wss:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[\x21-\x7e]*)?$/;
export const MAX_CARD_RELAYS = 10;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const PUBKEY_BYTES = 32;
const SECRET_BYTES = 32;
const EXP_BYTES = 4;
const V2_MIN_BYTES = PUBKEY_BYTES + SECRET_BYTES + EXP_BYTES + 1;
const MAX_RELAY_URL_BYTES = 255;

function isNpub(value: unknown): value is string {
	if (typeof value !== "string") return false;
	try {
		return nip19.decode(value).type === "npub";
	} catch {
		return false;
	}
}

/** Checks a relay list against the rules every card must meet. */
export function isCardRelays(relays: unknown): relays is string[] {
	return (
		Array.isArray(relays) &&
		relays.length > 0 &&
		relays.length <= MAX_CARD_RELAYS &&
		relays.every((relay) => typeof relay === "string" && RELAY_PATTERN.test(relay))
	);
}

function invalid(reason: string): never {
	throw new DgCliError(`not a valid phone-friend call card: ${reason}`);
}

function isDefaultRelays(relays: string[]): boolean {
	return relays.length === DEFAULT_RELAYS.length && relays.every((relay, i) => relay === DEFAULT_RELAYS[i]);
}

function npubToPubkeyBytes(npub: string): Buffer {
	let decoded: ReturnType<typeof nip19.decode>;
	try {
		decoded = nip19.decode(npub);
	} catch {
		throw new DgCliError(`not a valid phone-friend call card: bad npub "${npub}"`);
	}
	if (decoded.type !== "npub") throw new DgCliError(`not a valid phone-friend call card: bad npub "${npub}"`);
	return Buffer.from(decoded.data, "hex");
}

function pubkeyBytesToNpub(bytes: Buffer): string {
	return nip19.npubEncode(bytes.toString("hex"));
}

function encodeRelays(relays: string[]): Buffer {
	if (isDefaultRelays(relays)) return Buffer.from([0]);
	const parts = [Buffer.from([relays.length])];
	for (const relay of relays) {
		const bytes = Buffer.from(relay, "utf8");
		if (bytes.length > MAX_RELAY_URL_BYTES) {
			throw new DgCliError(`relay url is too long for a call card: ${relay}`);
		}
		parts.push(Buffer.from([bytes.length]), bytes);
	}
	return Buffer.concat(parts);
}

/** Reads the relay-set byte and whatever follows it; returns the relays and the offset just past them. */
function decodeRelays(body: Buffer, offset: number): { relays: string[]; next: number } {
	const count = body[offset];
	if (count === undefined) invalid("truncated relay section");
	if (count === 0) return { relays: DEFAULT_RELAYS, next: offset + 1 };
	if (count > MAX_CARD_RELAYS) invalid(`relays must be 1 to ${MAX_CARD_RELAYS} wss:// URLs`);
	const relays: string[] = [];
	let at = offset + 1;
	for (let i = 0; i < count; i++) {
		const length = body[at];
		if (length === undefined) invalid("truncated relay section");
		const start = at + 1;
		const end = start + length;
		if (end > body.length) invalid("truncated relay section");
		relays.push(body.subarray(start, end).toString("utf8"));
		at = end;
	}
	if (!isCardRelays(relays)) invalid(`relays must be 1 to ${MAX_CARD_RELAYS} wss:// URLs`);
	return { relays, next: at };
}

/** Emitted by `invite` and `card`. `card.handle` is required: a v2 card always carries the inviter's handle. */
export function encodeCard(card: Required<Card>): string {
	if (!isLineName(card.handle)) {
		throw new DgCliError(`handle must be 1-32 lowercase letters, digits, or dashes, got "${card.handle}"`);
	}
	if (!SECRET_HEX_PATTERN.test(card.secret)) throw new DgCliError(`bad secret "${card.secret}"`);
	const exp = Buffer.alloc(EXP_BYTES);
	exp.writeUInt32BE(card.exp, 0);
	const body = Buffer.concat([
		npubToPubkeyBytes(card.npub),
		Buffer.from(card.secret, "hex"),
		exp,
		encodeRelays(card.relays),
		Buffer.from(card.handle, "ascii"),
	]);
	return CARD_PREFIX + body.toString("base64url");
}

function decodeCardV2(trimmed: string, now: number): Card {
	const encoded = trimmed.slice(CARD_PREFIX.length);
	if (!BASE64URL_PATTERN.test(encoded)) invalid("it does not decode");
	const body = Buffer.from(encoded, "base64url");
	if (body.length < V2_MIN_BYTES) invalid("it does not decode");
	let offset = 0;
	const npub = pubkeyBytesToNpub(body.subarray(offset, (offset += PUBKEY_BYTES)));
	const secret = body.subarray(offset, (offset += SECRET_BYTES)).toString("hex");
	const exp = body.readUInt32BE(offset);
	offset += EXP_BYTES;
	const { relays, next } = decodeRelays(body, offset);
	const handle = body.subarray(next).toString("ascii");
	if (!isLineName(handle)) invalid("bad handle");
	if (exp <= now) throw new DgCliError("this call card has expired; ask for a new one");
	return { npub, relays, secret, exp, handle };
}

function decodeCardV1(trimmed: string, now: number): Card {
	let body: Record<string, unknown>;
	try {
		body = JSON.parse(Buffer.from(trimmed.slice(CARD_PREFIX_V1.length), "base64url").toString("utf8"));
	} catch {
		invalid("it does not decode");
	}
	if (typeof body !== "object" || body === null) invalid("it does not decode");
	const { v, npub, relays, secret, exp } = body;
	if (v !== 1) invalid(`unknown version ${String(v)}`);
	if (!isNpub(npub)) invalid("bad npub");
	if (!isCardRelays(relays)) invalid(`relays must be 1 to ${MAX_CARD_RELAYS} wss:// URLs`);
	if (typeof secret !== "string" || !SECRET_HEX_PATTERN.test(secret)) invalid("bad secret");
	if (typeof exp !== "number" || !Number.isInteger(exp)) invalid("bad expiry");
	if (exp <= now) throw new DgCliError("this call card has expired; ask for a new one");
	return { npub: npub as string, relays, secret, exp };
}

/** Accepts a v1 or v2 card; validates every field, so a pasted card can be trusted only as far as its own contents. */
export function decodeCard(text: string, now: number): Card {
	const trimmed = text.trim();
	if (trimmed.startsWith(CARD_PREFIX)) return decodeCardV2(trimmed, now);
	if (trimmed.startsWith(CARD_PREFIX_V1)) return decodeCardV1(trimmed, now);
	invalid(`it must start with ${CARD_PREFIX} or ${CARD_PREFIX_V1}`);
}
