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
	liveThreadAdmission,
	memberConfirmed,
	heldLogLine,
	heldThreadsNotice,
	parseThreadHandle,
	participantPubs,
	pendingIdsToDrop,
	pTagPubs,
	rumorSubject,
	senderLabel,
	shortRoomHandle,
	slugHandle,
	sortByTime,
	threadDirection,
	threadHandleBody,
	threadLine,
	threadRoomId,
	selfCopyOk,
	threadSendKept,
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
		expect(threadRoomId(["npub1c", "npub1a", "npub1b"])).toBe(
			"600b7d4b586de6fa183602f22b2b9f2ac4d626767071d2be1d3666a87f90c8ad",
		);
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
		return nip59.createRumor({ kind: 14, content: "body-text", created_at: createdAt, tags }, alice.sk);
	}

	function contacts(...pubs: string[]) {
		return pubs.map((pub) => ({ pub, keyId: "k" }));
	}

	function classify(tags: string[][], known: { pub: string; keyId?: string }[], createdAt = now) {
		return classifyThreadRumor(rumor(tags, createdAt), [bob.pub], known, now, "k", bob.pub);
	}

	it("returns null for a one-to-one rumor", () => {
		expect(classify([["p", bob.pub]], contacts(alice.pub))).toBeNull();
	});

	it("admits when every member shares the opening key", () => {
		const view = classify([["p", bob.pub], ["p", cara.pub], ["subject", "ops"]], contacts(alice.pub, cara.pub));
		expect(view?.kind).toBe("message");
		expect(view?.keyId).toBe("k");
		expect(view?.memberNpubs.slice().sort()).toEqual([alice.npub, bob.npub, cara.npub].sort());
		expect(view?.senderNpub).toBe(alice.npub);
	});

	it("holds a known sender when a member is unknown, we are absent, keys differ, or a p tag is bad", () => {
		expect(classify([["p", bob.pub], ["p", cara.pub], ["subject", "ops"]], contacts(alice.pub))?.kind).toBe("hold");
		expect(classify([["p", cara.pub], ["subject", "ops"]], contacts(alice.pub, cara.pub))?.kind).toBe("hold");
		expect(classify([["p", bob.pub], ["p", "not-a-key"], ["subject", "ops"]], contacts(alice.pub))?.kind).toBe("hold");
		expect(classify([["p", bob.pub], ["subject", "ops"]], [{ pub: alice.pub, keyId: "other" }])?.kind).toBe("hold");
		expect(classifyThreadRumor(rumor([["p", bob.pub], ["subject", "ops"]]), [bob.pub], contacts(alice.pub), now, "other", bob.pub)?.kind).toBe("hold");
		expect(classifyThreadRumor(rumor([["p", cara.pub], ["subject", "ops"]]), [bob.pub, cara.pub], contacts(alice.pub), now, "k", bob.pub)?.kind).toBe("hold");
	});

	it("drops a stranger sender and stores nothing about them", () => {
		const view = classify([["p", bob.pub], ["subject", "ops"]], []);
		expect(view?.kind).toBe("drop");
		expect(view?.reason).toBe("no matching contact or invite");
		expect(view?.pubkeyPrefix).toBe(alice.pub.slice(0, 8));
	});

	it("drops a thread rumor older than the message window", () => {
		const view = classify([["p", bob.pub], ["subject", "ops"]], contacts(alice.pub), now - MESSAGE_TTL_SECONDS - 1);
		expect(view?.kind).toBe("drop");
		expect(view?.reason).toBe("older than the message window");
		expect(view?.pubkeyPrefix).toBe(alice.pub.slice(0, 8));
	});

	it("keeps a rumor that lands exactly on the window boundary", () => {
		const view = classify([["p", bob.pub], ["subject", "ops"]], contacts(alice.pub), now - MESSAGE_TTL_SECONDS);
		expect(view?.kind).toBe("message");
	});

	it("drops a room larger than the member cap", () => {
		const pubs = Array.from({ length: 16 }, (_, index) => `${(index + 1).toString(16).padStart(64, "0")}`);
		const tags = [...pubs.map((pub) => ["p", pub]), ["subject", "ops"]];
		const known = pubs.map((pub) => ({ pub, keyId: "k" }));
		const view = classifyThreadRumor(rumor(tags), [bob.pub], [{ pub: alice.pub, keyId: "k" }, ...known], now, "k", bob.pub);
		expect(view?.kind).toBe("drop");
		expect(view?.reason).toBe("thread is too large");
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
		const self = { handle: "+me", npub: "npub1me", self: true, relays_ok: [] as string[], relays_unconfirmed: ["wss://self.example"], relays_failed: [] };
		expect(threadSendSucceeded([ok])).toBe(true);
		expect(threadSendSucceeded([ok, behind])).toBe(false);
		expect(threadSendSucceeded([ok, self])).toBe(true);
		expect(threadSendSucceeded([])).toBe(false);
		expect(behindHandles([ok, behind, self])).toEqual(["+c"]);
		expect(selfCopyOk([ok, self])).toBe(false);
		expect(selfCopyOk([{ ...self, relays_ok: ["wss://self.example"], relays_unconfirmed: [] }])).toBe(true);
		expect(threadSendKept([behind])).toBe(true);
		expect(threadSendKept([{ ...behind, relays_unconfirmed: [], relays_failed: [{ relay: "wss://c.example", reason: "no" }] }])).toBe(false);
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
			fallbackSubject: "ops",
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
			fallbackSubject: "ops",
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
		expect(caraRumor.tags.some((tag) => tag[0] === "subject" && tag[1] === "")).toBe(false);
	});

	it("omits an empty subject when several peers are tagged, and uses the fallback for one peer", async () => {
		const alice = person();
		const bob = person();
		const cara = person();
		const events: import("nostr-tools").NostrEvent[] = [];
		await fanoutThread({
			sk: alice.sk,
			text: "hello room",
			createdAt: 50,
			subject: "",
			fallbackSubject: "room",
			recipients: [
				{ handle: "+b", npub: bob.npub, pub: bob.pub, self: false },
				{ handle: "+c", npub: cara.npub, pub: cara.pub, self: false },
				{ handle: "+a", npub: alice.npub, pub: alice.pub, self: true },
			],
			relaysFor: async () => ["wss://a.example"],
			publishTo: async (_relays, event) => {
				events.push(event);
				return { ok: ["wss://a.example"], unconfirmed: [], failed: [] };
			},
		});
		const many = nip59.unwrapEvent(events[0] as import("nostr-tools").NostrEvent, bob.sk);
		expect(many.tags.some((tag) => tag[0] === "subject")).toBe(false);
		events.length = 0;
		await fanoutThread({
			sk: alice.sk,
			text: "hello room",
			createdAt: 50,
			subject: "",
			fallbackSubject: "room",
			recipients: [
				{ handle: "+b", npub: bob.npub, pub: bob.pub, self: false },
				{ handle: "+a", npub: alice.npub, pub: alice.pub, self: true },
			],
			relaysFor: async () => ["wss://a.example"],
			publishTo: async (_relays, event) => {
				events.push(event);
				return { ok: ["wss://a.example"], unconfirmed: [], failed: [] };
			},
		});
		const one = nip59.unwrapEvent(events[0] as import("nostr-tools").NostrEvent, bob.sk);
		expect(one.tags).toContainEqual(["subject", "room"]);
	});

	it("lists a member with no confirmed relay as behind", async () => {
		const alice = person();
		const bob = person();
		const delivered = await fanoutThread({
			sk: alice.sk,
			text: "hello room",
			createdAt: 50,
			subject: "",
			fallbackSubject: "room",
			recipients: [
				{ handle: "+b", npub: bob.npub, pub: bob.pub, self: false },
				{ handle: "+a", npub: alice.npub, pub: alice.pub, self: true },
			],
			relaysFor: async () => ["wss://a.example"],
			publishTo: async (_relays, _event) => ({ ok: [], unconfirmed: ["wss://a.example"], failed: [] }),
		});
		expect(threadSendSucceeded(delivered.members)).toBe(false);
		expect(behindHandles(delivered.members)).toEqual(["+b"]);
		expect(formatBehind(delivered.members)).not.toContain("hello room");
	});
});

describe("liveThreadAdmission", () => {
	it("files a room under the shared key, holds mixed keys, and drops a stranger", () => {
		const own = [{ npub: "npub1me", keyId: "k" }];
		expect(liveThreadAdmission(["npub1me", "npub1a"], "npub1a", own, [{ npub: "npub1a", keyId: "k" }])).toEqual({
			kind: "message",
			keyId: "k",
		});
		expect(
			liveThreadAdmission(["npub1me", "npub1a", "npub1b"], "npub1a", own, [
				{ npub: "npub1a", keyId: "k" },
				{ npub: "npub1b", keyId: "other" },
			]).kind,
		).toBe("hold");
		expect(liveThreadAdmission(["npub1me", "npub1a"], "npub1stranger", own, [{ npub: "npub1a", keyId: "k" }]).kind).toBe("drop");
		expect(liveThreadAdmission(["npub1me", "npub1other"], "npub1a", own, [{ npub: "npub1a", keyId: "k" }]).kind).toBe("hold");
		expect(
			liveThreadAdmission(
				["npub1me", "npub1me2", "npub1a"],
				"npub1a",
				[
					{ npub: "npub1me", keyId: "k" },
					{ npub: "npub1me2", keyId: "k" },
				],
				[{ npub: "npub1a", keyId: "k" }],
			).kind,
		).toBe("hold");
		expect(
			liveThreadAdmission(
				["npub1me", "npub1a"],
				"npub1a",
				[{ npub: "npub1me", keyId: "k" }, { npub: "npub1me2", keyId: "other" }],
				[{ npub: "npub1a", keyId: "k" }],
			).kind,
		).toBe("message");
		const many = Array.from({ length: 16 }, (_, index) => `npub1m${index}`);
		expect(liveThreadAdmission(["npub1me", ...many], "npub1a", own, [{ npub: "npub1a", keyId: "k" }]).kind).toBe("drop");
	});
});

describe("pending caps", () => {
	it("keeps the newest rows per sender and then the newest overall", () => {
		const rows = [
			{ rumorId: "a1", sender: "a", ts: 1 },
			{ rumorId: "a2", sender: "a", ts: 2 },
			{ rumorId: "a3", sender: "a", ts: 3 },
			{ rumorId: "b1", sender: "b", ts: 4 },
		];
		expect(pendingIdsToDrop(rows, 2, 50).sort()).toEqual(["a1"]);
		expect(pendingIdsToDrop(rows, 5, 2).sort()).toEqual(["a1", "a2"]);
		expect(pendingIdsToDrop([{ rumorId: "only", sender: "a", ts: 1 }], 5, 50)).toEqual([]);
		expect(pendingIdsToDrop([{ rumorId: "b", sender: "a", ts: 1 }, { rumorId: "a", sender: "a", ts: 1 }], 1, 50)).toEqual(["b"]);
	});
});

describe("display", () => {
	it("renders a thread row as [#handle] +sender and never puts the body in a hold notice", () => {
		expect(threadLine("#ops", "+baron", "hello")).toBe("[#ops] +baron: hello");
		expect(senderLabel("npub1abcdefghijklmnop", "baron", undefined)).toBe("+baron");
		expect(senderLabel("npub1abcdefghijklmnop", undefined, "dg")).toBe("+dg");
		expect(senderLabel("npub1abcdefghijklmnop", undefined, undefined)).toBe("npub1abcdefghijk");
		expect(heldThreadsNotice(1)).toBe("1 held thread");
		expect(heldThreadsNotice(3)).toBe("3 held threads");
		expect(heldLogLine("abcdef1234567890")).toBe("phone: held thread abcdef12\n");
		expect(heldLogLine("abcdef1234567890")).not.toContain("hello");
		expect(threadDirection("npub1us", ["npub1us"])).toBe("out");
		expect(threadDirection("npub1them", ["npub1us"])).toBe("in");
	});

	it("sorts by timestamp and keeps equal timestamps in their existing order", () => {
		expect(sortByTime([{ id: "b", ts: 2 }, { id: "a", ts: 1 }, { id: "c", ts: 2 }]).map((row) => row.id)).toEqual(["a", "b", "c"]);
	});
});
