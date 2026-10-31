import { describe, expect, it } from "bun:test";
import { DgCliError } from "@dg/common";
import { generateSecretKey, getPublicKey, nip19, nip59 } from "nostr-tools";
import { MESSAGE_TTL_SECONDS } from "../../src/phone/db";
import {
	behindHandles,
	classifyThreadRumor,
	dedupeHandle,
	fanoutThread,
	formatBehind,
	hasInvalidPTag,
	isThreadRumor,
	memberConfirmed,
	parseThreadHandle,
	participantPubs,
	pTagPubs,
	pendingNotice,
	rumorSubject,
	senderLabel,
	shortRoomHandle,
	slugHandle,
	sortByTime,
	threadDirection,
	threadHandleBody,
	threadLine,
	threadRoomId,
	threadSendSucceeded,
	validPubkey,
} from "../../src/phone/thread";

function person() {
	const sk = generateSecretKey();
	const pub = getPublicKey(sk);
	return { sk, pub, npub: nip19.npubEncode(pub) };
}

describe("threadRoomId", () => {
	it("is the sha256 of the sorted unique npubs, including our own", () => {
		const a = person();
		const b = person();
		const c = person();

		expect(threadRoomId([c.npub, a.npub, b.npub, a.npub])).toBe(threadRoomId([a.npub, b.npub, c.npub]));
		expect(threadRoomId([a.npub, b.npub])).not.toBe(threadRoomId([a.npub]));
		expect(threadRoomId([a.npub, b.npub])).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("rumor shape", () => {
	const alice = "a".repeat(64);
	const bob = "b".repeat(64);

	it("treats one p tag and no subject as one-to-one", () => {
		const tags = [["p", alice]];
		expect(isThreadRumor(tags)).toBe(false);
		expect(pTagPubs(tags)).toEqual([alice]);
		expect(rumorSubject(tags)).toBeNull();
		expect(hasInvalidPTag(tags)).toBe(false);
	});

	it("treats two p tags, or a subject, as a thread", () => {
		expect(isThreadRumor([["p", alice], ["p", bob]])).toBe(true);
		expect(isThreadRumor([["p", alice], ["subject", "ops"]])).toBe(true);
		expect(isThreadRumor([["subject", ""]])).toBe(true);
		expect(rumorSubject([["subject", "ops"]])).toBe("ops");
		expect(pTagPubs([["p", alice], ["p", alice], ["p", bob]])).toEqual([alice, bob]);
	});

	it("drops p tags that are not pubkeys and flags them", () => {
		expect(validPubkey(alice)).toBe(true);
		expect(validPubkey("zz")).toBe(false);
		expect(pTagPubs([["p", "nope"], ["p", alice]])).toEqual([alice]);
		expect(hasInvalidPTag([["p", "nope"]])).toBe(true);
		expect(hasInvalidPTag([["p"]])).toBe(true);
		expect(participantPubs(bob, [["p", alice], ["p", bob]])).toEqual([bob, alice]);
	});
});

describe("handles", () => {
	it("slugs a subject and falls back to a short room id", () => {
		expect(slugHandle("Hello Ops!")).toBe("hello-ops");
		expect(slugHandle("---")).toBe("");
		expect(threadHandleBody("Hello Ops!", "abcdef12ffff")).toBe("hello-ops");
		expect(threadHandleBody("", "abcdef12ffff")).toBe("abcdef12");
		expect(threadHandleBody(null, "abcdef12ffff")).toBe("abcdef12");
		expect(shortRoomHandle("")).toBe("thread");
	});

	it("dedupes a handle and keeps the body inside 32 characters", () => {
		const taken = new Set<string>();
		expect(dedupeHandle("ops", (handle) => taken.has(handle))).toBe("#ops");
		taken.add("#ops");
		expect(dedupeHandle("ops", (handle) => taken.has(handle))).toBe("#ops-2");
		expect(dedupeHandle("", () => false)).toBe("#thread");
		const long = "a".repeat(40);
		expect(dedupeHandle(long, () => false)).toBe(`#${"a".repeat(32)}`);
	});

	it("rejects a thread handle that does not start with # or is not a handle body", () => {
		expect(parseThreadHandle("#ops")).toBe("#ops");
		expect(() => parseThreadHandle("ops")).toThrow('a thread handle must start with #, got "ops"');
		expect(() => parseThreadHandle("#Ops")).toThrow(DgCliError);
		expect(() => parseThreadHandle("#")).toThrow(DgCliError);
	});
});

describe("classifyThreadRumor", () => {
	const now = 2_000_000;
	const alice = person();
	const bob = person();
	const cara = person();

	function rumor(tags: string[][], createdAt = now) {
		const built = nip59.createRumor({ kind: 14, content: "body-text", created_at: createdAt, tags }, alice.sk);
		return built;
	}

	it("returns null for a one-to-one rumor", () => {
		expect(classifyThreadRumor(rumor([["p", bob.pub]]), [bob.pub], [alice.pub], now)).toBeNull();
	});

	it("admits when every member is us or a known contact", () => {
		const view = classifyThreadRumor(
			rumor([["p", bob.pub], ["p", cara.pub], ["subject", "ops"]]),
			[bob.pub],
			[alice.pub, cara.pub],
			now,
		);
		expect(view?.kind).toBe("message");
		expect(view?.memberNpubs.slice().sort()).toEqual([alice.npub, bob.npub, cara.npub].sort());
		expect(view?.senderNpub).toBe(alice.npub);
		expect(view?.rumorId).toBe(rumor([["p", bob.pub], ["p", cara.pub], ["subject", "ops"]]).id);
	});

	it("holds when a member is a stranger, when we are absent, or when a p tag is not a pubkey", () => {
		const stranger = classifyThreadRumor(
			rumor([["p", bob.pub], ["p", cara.pub], ["subject", "ops"]]),
			[bob.pub],
			[alice.pub],
			now,
		);
		expect(stranger?.kind).toBe("hold");

		const withoutUs = classifyThreadRumor(
			rumor([["p", cara.pub], ["subject", "ops"]]),
			[bob.pub],
			[alice.pub, cara.pub],
			now,
		);
		expect(withoutUs?.kind).toBe("hold");

		const invalid = classifyThreadRumor(
			rumor([["p", bob.pub], ["p", "not-a-key"], ["subject", "ops"]]),
			[bob.pub],
			[alice.pub],
			now,
		);
		expect(invalid?.kind).toBe("hold");
	});

	it("drops a thread rumor older than the message window", () => {
		const view = classifyThreadRumor(
			rumor([["p", bob.pub], ["subject", "ops"]], now - MESSAGE_TTL_SECONDS - 1),
			[bob.pub],
			[alice.pub],
			now,
		);
		expect(view?.kind).toBe("drop");
		expect(view?.pubkeyPrefix).toBe(alice.pub.slice(0, 8));
	});

	it("keeps a rumor that lands exactly on the window boundary", () => {
		const view = classifyThreadRumor(
			rumor([["p", bob.pub], ["subject", "ops"]], now - MESSAGE_TTL_SECONDS),
			[bob.pub],
			[alice.pub],
			now,
		);
		expect(view?.kind).toBe("message");
	});
});

describe("delivery report", () => {
	const ok = { handle: "+b", npub: "npub1b", self: false, relays_ok: ["wss://a.example"], relays_unconfirmed: [], relays_failed: [] };
	const behind = {
		handle: "+c",
		npub: "npub1c",
		self: false,
		relays_ok: [] as string[],
		relays_unconfirmed: ["wss://b.example"],
		relays_failed: [{ relay: "wss://c.example", reason: "refused" }],
	};

	it("succeeds only when every member has a confirmed relay", () => {
		expect(memberConfirmed(ok)).toBe(true);
		expect(memberConfirmed(behind)).toBe(false);
		expect(threadSendSucceeded([ok])).toBe(true);
		expect(threadSendSucceeded([ok, behind])).toBe(false);
		expect(threadSendSucceeded([])).toBe(false);
		expect(behindHandles([ok, behind])).toEqual(["+c"]);
		expect(formatBehind([ok, behind])).toContain("behind: +c");
		expect(formatBehind([ok, behind])).toContain("wss://a.example ok");
		expect(formatBehind([ok, behind])).toContain("wss://b.example unconfirmed");
		expect(formatBehind([ok, behind])).toContain("wss://c.example failed: refused");
		expect(formatBehind([{ ...behind, relays_unconfirmed: [], relays_failed: [] }])).toContain("no relay");
	});
});

describe("fanoutThread", () => {
	it("builds one rumor, tags every other member and the subject, and wraps each recipient including us", async () => {
		const alice = person();
		const bob = person();
		const cara = person();
		const published: { relays: string[]; id: string }[] = [];
		const delivered = await fanoutThread({
			sk: alice.sk,
			text: "hello room",
			createdAt: 50,
			subject: "ops",
			recipients: [
				{ handle: "+b", npub: bob.npub, pub: bob.pub, self: false },
				{ handle: "+c", npub: cara.npub, pub: cara.pub, self: false },
				{ handle: "+a", npub: alice.npub, pub: alice.pub, self: true },
			],
			relaysFor: async (recipient) => [recipient.self ? "wss://self.example" : `wss://${recipient.handle}.example`],
			publishTo: async (relays, event) => {
				published.push({ relays, id: event.id });
				return { ok: relays, unconfirmed: [], failed: [] };
			},
		});

		expect(published).toHaveLength(3);
		expect(delivered.rumorId).toMatch(/^[0-9a-f]{64}$/);
		expect(delivered.members.map((member) => member.handle)).toEqual(["+b", "+c", "+a"]);
		expect(threadSendSucceeded(delivered.members)).toBe(true);
		expect(new Set(published.map((item) => item.relays[0])).size).toBe(3);
	});

	it("seals the same rumor id for every recipient and omits our pubkey from the p tags", async () => {
		const alice = person();
		const bob = person();
		const cara = person();
		const events: import("nostr-tools").NostrEvent[] = [];
		const delivered = await fanoutThread({
			sk: alice.sk,
			text: "hello room",
			createdAt: 50,
			subject: "ops",
			recipients: [
				{ handle: "+c", npub: cara.npub, pub: cara.pub, self: false },
				{ handle: "+b", npub: bob.npub, pub: bob.pub, self: false },
				{ handle: "+a", npub: alice.npub, pub: alice.pub, self: true },
			],
			relaysFor: async () => ["wss://a.example"],
			publishTo: async (relays, event) => {
				events.push(event);
				return { ok: relays, unconfirmed: [], failed: [] };
			},
		});
		const caraRumor = nip59.unwrapEvent(events[0] as import("nostr-tools").NostrEvent, cara.sk);
		const bobRumor = nip59.unwrapEvent(events[1] as import("nostr-tools").NostrEvent, bob.sk);
		const selfRumor = nip59.unwrapEvent(events[2] as import("nostr-tools").NostrEvent, alice.sk);
		expect(caraRumor.id).toBe(delivered.rumorId);
		expect(bobRumor.id).toBe(delivered.rumorId);
		expect(selfRumor.id).toBe(delivered.rumorId);
		expect(caraRumor.tags.filter((tag) => tag[0] === "p").map((tag) => tag[1]).sort()).toEqual([bob.pub, cara.pub].sort());
		expect(caraRumor.tags.some((tag) => tag[0] === "p" && tag[1] === alice.pub)).toBe(false);
		expect(caraRumor.tags).toContainEqual(["subject", "ops"]);
		expect(caraRumor.content).toBe("hello room");
	});

	it("lists a member with no confirmed relay as behind", async () => {
		const alice = person();
		const bob = person();
		const delivered = await fanoutThread({
			sk: alice.sk,
			text: "hello room",
			createdAt: 50,
			subject: "",
			recipients: [
				{ handle: "+b", npub: bob.npub, pub: bob.pub, self: false },
				{ handle: "+a", npub: alice.npub, pub: alice.pub, self: true },
			],
			relaysFor: async () => ["wss://a.example"],
			publishTo: async (_relays, _event) => ({ ok: [], unconfirmed: ["wss://a.example"], failed: [] }),
		});
		expect(threadSendSucceeded(delivered.members)).toBe(false);
		expect(behindHandles(delivered.members)).toEqual(["+b", "+a"]);
		expect(formatBehind(delivered.members)).not.toContain("hello room");
	});
});

describe("display", () => {
	it("renders a thread row as [#handle] +sender and never puts the body in a hold notice", () => {
		expect(threadLine("#ops", "+baron", "hello")).toBe("[#ops] +baron: hello");
		expect(senderLabel("npub1abcdefghijklmnop", "baron", undefined)).toBe("+baron");
		expect(senderLabel("npub1abcdefghijklmnop", undefined, "dg")).toBe("+dg");
		expect(senderLabel("npub1abcdefghijklmnop", undefined, undefined)).toBe("npub1abcdefghijk");
		expect(pendingNotice("abcdef1234567890")).toBe("held thread abcdef12; a member is not a known contact");
		expect(pendingNotice("abcdef1234567890")).not.toContain("hello");
		expect(threadDirection("npub1us", ["npub1us"])).toBe("out");
		expect(threadDirection("npub1them", ["npub1us"])).toBe("in");
	});

	it("sorts by timestamp and keeps equal timestamps in their existing order", () => {
		expect(sortByTime([{ id: "b", ts: 2 }, { id: "a", ts: 1 }, { id: "c", ts: 2 }]).map((row) => row.id)).toEqual(["a", "b", "c"]);
	});
});
