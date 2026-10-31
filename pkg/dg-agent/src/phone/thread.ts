import { createHash } from "node:crypto";
import { DgCliError } from "@dg/common";
import { nip19, nip59, type NostrEvent } from "nostr-tools";
import { MESSAGE_TTL_SECONDS } from "./db";
import { isHandle } from "./store";

const CHAT_MESSAGE_KIND = 14;
const PUBKEY_HEX = /^[0-9a-f]{64}$/;

export type ThreadMeta = {
	roomId: string;
	subject: string | null;
	memberPubs: string[];
	memberNpubs: string[];
	keyId: string;
};

export type HeldThread = {
	rumorId: string;
	roomId: string;
	senderNpub: string;
	memberNpubs: string[];
	subject: string | null;
	text: string;
	ts: number;
};

export type ThreadView = {
	kind: "message" | "hold" | "drop";
	roomId: string;
	subject: string | null;
	memberPubs: string[];
	memberNpubs: string[];
	rumorId: string;
	senderNpub: string;
	ts: number;
	text: string;
	pubkeyPrefix?: string;
};

type RumorView = { id: string; pubkey: string; created_at: number; content: string; tags: string[][] };

/** Stable room id: sha256 of the sorted participant npubs, our own included. */
export function threadRoomId(npubs: readonly string[]): string {
	const unique = [...new Set(npubs)].sort();
	return createHash("sha256").update(unique.join("\n")).digest("hex");
}

export function validPubkey(pub: string): boolean {
	return PUBKEY_HEX.test(pub);
}

/** `p` tag pubkeys, in first-seen order, skipping anything that is not a 64-char hex pubkey. */
export function pTagPubs(tags: readonly string[][]): string[] {
	const pubs: string[] = [];
	for (const tag of tags) {
		if (tag[0] !== "p" || typeof tag[1] !== "string" || !validPubkey(tag[1])) continue;
		if (!pubs.includes(tag[1])) pubs.push(tag[1]);
	}
	return pubs;
}

export function hasInvalidPTag(tags: readonly string[][]): boolean {
	return tags.some((tag) => tag[0] === "p" && (typeof tag[1] !== "string" || !validPubkey(tag[1])));
}

/** The subject tag's text, or null when the rumor has no subject tag. */
export function rumorSubject(tags: readonly string[][]): string | null {
	const tag = tags.find((item) => item[0] === "subject" && typeof item[1] === "string");
	return tag === undefined ? null : tag[1];
}

/** More than one `p` tag, or any subject tag, marks a thread rumor. One `p` and no subject stays one-to-one. */
export function isThreadRumor(tags: readonly string[][]): boolean {
	if (pTagPubs(tags).length > 1) return true;
	return rumorSubject(tags) !== null;
}

/** Sender plus every valid `p` tag. The sender is always first. */
export function participantPubs(pubkey: string, tags: readonly string[][]): string[] {
	const pubs = validPubkey(pubkey) ? [pubkey] : [];
	for (const pub of pTagPubs(tags)) {
		if (!pubs.includes(pub)) pubs.push(pub);
	}
	return pubs;
}

export function slugHandle(subject: string): string {
	const slug = subject
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32)
		.replace(/-+$/g, "");
	return isHandle(slug) ? slug : "";
}

export function shortRoomHandle(roomId: string): string {
	const body = roomId.slice(0, 8).toLowerCase();
	return isHandle(body) ? body : "thread";
}

/** `#` + a slug of the subject, or a short room id when the subject does not slug. */
export function threadHandleBody(subject: string | null, roomId: string): string {
	const slug = subject === null ? "" : slugHandle(subject);
	if (slug.length > 0) return slug;
	return shortRoomHandle(roomId);
}

/** `#body`, then `#body-2`, `#body-3`, ... Handles stay inside the 32-character body limit. */
export function dedupeHandle(body: string, taken: (handle: string) => boolean): string {
	const clipped = body.length > 32 ? body.slice(0, 32) : body;
	const stripped = clipped.replace(/-+$/g, "");
	const normalized = stripped.length > 0 ? stripped : "thread";
	const first = `#${normalized}`;
	if (!taken(first)) return first;
	let n = 2;
	for (;;) {
		const suffix = `-${n}`;
		const trimmed = normalized.slice(0, 32 - suffix.length).replace(/-+$/g, "");
		const stem = trimmed.length > 0 ? trimmed : "t";
		const candidate = `#${stem}${suffix}`;
		if (!taken(candidate)) return candidate;
		n += 1;
	}
}

export function parseThreadHandle(value: string): string {
	if (!value.startsWith("#")) {
		throw new DgCliError(`a thread handle must start with #, got "${value}"`);
	}
	const body = value.slice(1);
	if (!isHandle(body)) {
		throw new DgCliError(`a thread handle must be # then 1-32 lowercase letters, digits, or dashes, got "${value}"`);
	}
	return `#${body}`;
}

function npubsFor(pubs: readonly string[]): string[] {
	return pubs.map((pub) => nip19.npubEncode(pub));
}

/**
 * A thread rumor is a message when every participant is a known contact or us.
 * Anything else is held. A rumor past the message ttl is dropped. A non-thread rumor returns null.
 */
export function classifyThreadRumor(
	rumor: RumorView,
	ownPubs: readonly string[],
	contactPubs: readonly string[],
	now: number,
): ThreadView | null {
	if (!isThreadRumor(rumor.tags)) return null;
	const memberPubs = participantPubs(rumor.pubkey, rumor.tags);
	const memberNpubs = npubsFor(memberPubs);
	const view = {
		roomId: threadRoomId(memberNpubs),
		subject: rumorSubject(rumor.tags),
		memberPubs,
		memberNpubs,
		rumorId: rumor.id,
		senderNpub: nip19.npubEncode(rumor.pubkey),
		ts: rumor.created_at,
		text: rumor.content,
	};
	if (rumor.created_at < now - MESSAGE_TTL_SECONDS) {
		return { kind: "drop", ...view, pubkeyPrefix: rumor.pubkey.slice(0, 8) };
	}
	if (hasInvalidPTag(rumor.tags)) return { kind: "hold", ...view };
	const includesUs = memberPubs.some((pub) => ownPubs.includes(pub));
	const unknown = memberPubs.filter((pub) => !ownPubs.includes(pub) && !contactPubs.includes(pub));
	if (!includesUs || unknown.length > 0) return { kind: "hold", ...view };
	return { kind: "message", ...view };
}

export function heldFrom(view: ThreadView): HeldThread {
	return {
		rumorId: view.rumorId,
		roomId: view.roomId,
		senderNpub: view.senderNpub,
		memberNpubs: view.memberNpubs,
		subject: view.subject,
		text: view.text,
		ts: view.ts,
	};
}

export function threadMessageFields(view: ThreadView, keyId: string): {
	id: string;
	ts: number;
	from: string;
	text: string;
	thread: ThreadMeta;
} {
	return {
		id: view.rumorId,
		ts: view.ts,
		from: view.senderNpub,
		text: view.text,
		thread: {
			roomId: view.roomId,
			subject: view.subject,
			memberPubs: view.memberPubs,
			memberNpubs: view.memberNpubs,
			keyId,
		},
	};
}

/** Notice text for a held thread. The message body is never included. */
export function pendingNotice(roomId: string): string {
	return `held thread ${roomId.slice(0, 8)}; a member is not a known contact`;
}

export function threadLine(threadHandle: string, senderLabelText: string, text: string): string {
	return `[${threadHandle}] ${senderLabelText}: ${text}`;
}

export function senderLabel(npub: string, contactHandle: string | undefined, selfHandle: string | undefined): string {
	if (selfHandle !== undefined) return selfHandle.startsWith("+") ? selfHandle : `+${selfHandle}`;
	if (contactHandle !== undefined && contactHandle.length > 0) {
		return contactHandle.startsWith("+") ? contactHandle : `+${contactHandle}`;
	}
	return npub.slice(0, 16);
}

export function threadDirection(senderNpub: string, ownNpubs: readonly string[]): "in" | "out" {
	return ownNpubs.includes(senderNpub) ? "out" : "in";
}

export type RelayFailure = { relay: string; reason: string };

export type MemberReport = {
	handle: string;
	npub: string;
	self: boolean;
	relays_ok: string[];
	relays_unconfirmed: string[];
	relays_failed: RelayFailure[];
};

export function memberConfirmed(member: MemberReport): boolean {
	return member.relays_ok.length > 0;
}

export function behindHandles(members: readonly MemberReport[]): string[] {
	return members.filter((member) => !memberConfirmed(member)).map((member) => member.handle);
}

export function threadSendSucceeded(members: readonly MemberReport[]): boolean {
	return members.length > 0 && members.every((member) => memberConfirmed(member));
}

export function formatBehind(members: readonly MemberReport[]): string {
	const behind = behindHandles(members);
	const detail = members
		.map((member) => {
			const parts = [
				...member.relays_ok.map((relay) => `${relay} ok`),
				...member.relays_unconfirmed.map((relay) => `${relay} unconfirmed`),
				...member.relays_failed.map((failure) => `${failure.relay} failed: ${failure.reason}`),
			];
			return `${member.handle}: ${parts.join(", ") || "no relay"}`;
		})
		.join("; ");
	return `not every member confirmed the message; behind: ${behind.join(", ")} (${detail})`;
}

export type ThreadRecipient = { handle: string; npub: string; pub: string; self: boolean };

export type RelayReport = { ok: string[]; unconfirmed: string[]; failed: RelayFailure[] };

/**
 * One kind-14 rumor, a `p` tag per other member, and the subject tag.
 * Each recipient, including us, gets their own seal and gift wrap.
 */
export async function fanoutThread(input: {
	sk: Uint8Array;
	text: string;
	createdAt: number;
	subject: string;
	recipients: ThreadRecipient[];
	relaysFor: (recipient: ThreadRecipient) => Promise<string[]>;
	publishTo: (relays: string[], event: NostrEvent) => Promise<RelayReport>;
}): Promise<{ rumorId: string; members: MemberReport[] }> {
	const others = input.recipients.filter((recipient) => !recipient.self).map((recipient) => recipient.pub);
	const pubs = [...new Set(others)].sort();
	const tags: string[][] = pubs.map((pub) => ["p", pub]);
	tags.push(["subject", input.subject]);
	const rumor = nip59.createRumor(
		{ kind: CHAT_MESSAGE_KIND, content: input.text, created_at: input.createdAt, tags },
		input.sk,
	);
	const members: MemberReport[] = [];
	for (const recipient of input.recipients) {
		const relays = await input.relaysFor(recipient);
		const seal = nip59.createSeal(rumor, input.sk, recipient.pub);
		const event = nip59.createWrap(seal, recipient.pub);
		const report = await input.publishTo(relays, event);
		members.push({
			handle: recipient.handle,
			npub: recipient.npub,
			self: recipient.self,
			relays_ok: report.ok,
			relays_unconfirmed: report.unconfirmed,
			relays_failed: report.failed,
		});
	}
	return { rumorId: rumor.id, members };
}

export function sortByTime<T extends { ts: number }>(rows: T[]): T[] {
	return rows.sort((left, right) => left.ts - right.ts);
}
