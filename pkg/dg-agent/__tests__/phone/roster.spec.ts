import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { generateSecretKey, getPublicKey, nip19, nip59 } from "nostr-tools";
import { fetchNew, ROSTER_KIND, wrap, wrapTagged, type KeyEntry } from "../../src/phone/chat";
import { phoneAccept, phoneClose, phoneNumber, type OpenCloseDeps, type PhoneDeps } from "../../src/phone/commands";
import { createFileKey } from "../../src/phone/keys";
import {
	claudeNameFromJson,
	codexNameFromLine,
	currentSelfName,
	type DiscoveredAgent,
	discoverAgents,
	namesForRoster,
	slugHandle,
} from "../../src/phone/names";
import {
	applyRoster,
	clearMachineContacts,
	handleIncomingRoster,
	legacyPeerDisposition,
	LEGACY_CHAT_KINDS,
	LEGACY_CONTROL_KINDS,
	parseRosterBody,
	planRosterFlush,
	ROSTER_BODY_TAG,
	ROSTER_DEBOUNCE_MAX_S,
	ROSTER_DEBOUNCE_S,
	ROSTER_FANOUT,
	ROSTER_HARD_CAP,
	ROSTER_LIMIT,
	ROSTER_TAG,
	rosterDocument,
	rosterHash,
	flushRosterPush,
	sendRoster,
	setupSelfName,
	type RosterAgent,
} from "../../src/phone/roster";
import { addContact, findContactByHandle, gateFor, listContacts, numberKeyId, readAdmissionEpoch, readNumber } from "../../src/phone/store";
import { createFakePool, freshNpub, makeHomeTracker, makePhoneDeps, parseNdjson, type FakePool } from "./fake-pool";

const NOW = Math.floor(Date.now() / 1000);
const tracker = makeHomeTracker("dg-phone-roster-");
let pool: FakePool;
let out: string[];

function deps(home: string, extra: Partial<PhoneDeps> = {}): PhoneDeps {
	const d = makePhoneDeps({ home, pool, write: (text) => out.push(text), now: NOW });
	tracker.trackDb(d.db);
	return { ...d, ...extra, db: d.db, paths: d.paths };
}

function lines(): unknown[] {
	return parseNdjson(out);
}

function agent(handle: string, runtime: RosterAgent["runtime"], npub = freshNpub()): RosterAgent {
	return { handle, npub, ...(runtime ? { runtime } : {}) };
}

function pairContact(db: PhoneDeps["db"], npub: string, handle: string): void {
	addContact(db, { npub, handle, relays: ["wss://a.example"], keyId: numberKeyId(db), addedAt: NOW, via: "accept" });
}

function identity(db: PhoneDeps["db"], handle: string, runtime: string): string {
	const sk = createFileKey(db, `agent-${handle}`);
	if (!sk) throw new Error("key");
	db.putIdentity(handle, `agent-${handle}`, runtime);
	return nip19.npubEncode(getPublicKey(sk));
}

function rumorTags(event: Parameters<typeof nip59.unwrapEvent>[0], sk: Uint8Array): string[][] {
	return nip59.unwrapEvent(event, sk).tags;
}

afterEach(() => {
	tracker.cleanup();
});

describe("session names", () => {
	it("slugs a Claude-style name and refuses placeholders", () => {
		expect(slugHandle("Dante")).toBe("dante");
		expect(slugHandle("Fix the parser")).toBe("fix-the-parser");
		expect(slugHandle("#853 fix flyway")).toBe("853-fix-flyway");
		expect(slugHandle("a".repeat(40))).toHaveLength(32);
		expect(slugHandle("agent")).toBeUndefined();
		expect(slugHandle("default")).toBeUndefined();
		expect(slugHandle("---dante---")).toBe("dante");
		expect(slugHandle("   ")).toBeUndefined();
		expect(slugHandle(undefined)).toBeUndefined();
	});

	it("prefers the current Claude name, then Codex, Grok, and dg", () => {
		const row = (runtime: DiscoveredAgent["runtime"], handle: string, current: boolean): DiscoveredAgent => ({
			runtime,
			name: handle,
			handle,
			current,
		});
		expect(currentSelfName([row("dg", "dee", true), row("grok", "warren", true), row("claude", "dante", true), row("codex", "merc", true)])).toBe("dante");
		expect(currentSelfName([row("codex", "merc", true), row("grok", "warren", false)])).toBe("merc");
		expect(currentSelfName([row("grok", "warren", true)])).toBe("warren");
		expect(currentSelfName([row("claude", "dante", false)])).toBeUndefined();
		expect(setupSelfName(undefined, undefined, [])).toBe("dg");
		expect(setupSelfName("kit", undefined, [row("claude", "dante", true)])).toBe("kit");
		expect(setupSelfName(undefined, "saved", [row("claude", "dante", true)])).toBe("saved");
	});

	it("reads a Claude session, a Codex thread, and a Grok bot, and ignores a missing tree", () => {
		expect(claudeNameFromJson('{"name":"Dante","id":"sess-1"}', "sess-1")).toEqual({ name: "Dante", current: true });
		expect(claudeNameFromJson('{"name":"Dante","sessionId":"sess-2"}', "sess-2")).toEqual({ name: "Dante", current: true });
		expect(claudeNameFromJson('{"name":"Dante","session_id":"sess-3"}', "sess-3")).toEqual({ name: "Dante", current: true });
		expect(claudeNameFromJson('{"name":"Dante","cwd":"/tmp/sess-9"}', "sess-9")).toEqual({ name: "Dante", current: false });
		expect(claudeNameFromJson('{"name":"Other"}', "sess-1")).toEqual({ name: "Other", current: false });
		expect(claudeNameFromJson('{"name":"Dante","id":"sess-1"}', "   ")?.current).toBe(false);
		expect(claudeNameFromJson("not-json", "sess-1")).toBeUndefined();
		expect(codexNameFromLine('{"id":"thr-1","thread_name":"Merc"}', "thr-1")).toEqual({ name: "Merc", current: true });
		expect(codexNameFromLine('{"thread_id":"thr-2","title":"Other"}', "thr-1")).toEqual({ name: "Other", current: false });
		expect(codexNameFromLine('{"thread_name":"Merc"}', undefined)).toEqual({ name: "Merc", current: false });
		expect(codexNameFromLine('{"thread_name":"Merc","id":""}', "")).toEqual({ name: "Merc", current: false });
		expect(codexNameFromLine("nope", "thr-1")).toBeUndefined();

		const home = tracker.freshHome();
		mkdirSync(join(home, ".claude", "sessions"), { recursive: true });
		writeFileSync(join(home, ".claude", "sessions", "s.json"), JSON.stringify({ name: "Dante", id: "sess-1" }));
		mkdirSync(join(home, ".codex"), { recursive: true });
		writeFileSync(join(home, ".codex", "session_index.jsonl"), `${JSON.stringify({ id: "thr-1", thread_name: "Merc" })}\n`);
		mkdirSync(join(home, ".grok", "agents"), { recursive: true });
		writeFileSync(join(home, ".grok", "agents", "kit.json"), JSON.stringify({ name: "Kit" }));
		const found = discoverAgents({
			env: { CLAUDE_CODE_SESSION_ID: "sess-1", CODEX_THREAD_ID: "thr-1", GROK_AGENT_NAME: "Warren", CODEX_HOME: join(home, ".codex") },
			homeDir: home,
		});
		expect(found.map((agent) => [agent.runtime, agent.handle, agent.current]).sort()).toEqual([
			["claude", "dante", true],
			["codex", "merc", true],
			["grok", "kit", false],
			["grok", "warren", true],
		]);
		expect(discoverAgents({ env: {}, homeDir: join(home, "missing") })).toEqual([]);
	});

	it("keeps the current agent when the cap drops the rest", () => {
		const agents: DiscoveredAgent[] = [
			{ runtime: "grok", name: "Zed", handle: "zed", current: false },
			{ runtime: "claude", name: "Dante", handle: "dante", current: true },
			{ runtime: "codex", name: "Dante", handle: "dante", current: false },
		];
		expect(namesForRoster(agents, 1).map((agent) => agent.runtime)).toEqual(["claude"]);
		expect(namesForRoster(agents, 0)).toEqual([]);
		expect(
			namesForRoster(
				[
					{ runtime: "grok", name: "Aaa", handle: "aaa", current: false },
					{ runtime: "claude", name: "Zed", handle: "zzz", current: true },
				],
				2,
			).map((agent) => agent.handle),
		).toEqual(["zzz", "aaa"]);
	});
});

describe("roster documents", () => {
	it("keeps a valid entry and drops a bad handle, a bad npub, and a duplicate", () => {
		const good = agent("kit", "claude");
		const body = JSON.stringify({
			v: 1,
			note: "ignored",
			agents: [good, { handle: "Bad", npub: good.npub }, { handle: "merc", npub: "nope", runtime: "nope" }, { ...good }, { handle: "ada", npub: freshNpub(), runtime: 3 }],
		});
		expect(parseRosterBody(body)).toEqual([good, { handle: "ada", npub: JSON.parse(body).agents[4].npub }]);
	});

	it("refuses an unknown version, a huge list, and a body that is not a document", () => {
		expect(parseRosterBody(JSON.stringify({ v: 2, agents: [] }))).toBeUndefined();
		expect(parseRosterBody(JSON.stringify({ agents: [] }))).toBeUndefined();
		expect(parseRosterBody("[]")).toBeUndefined();
		const agents = Array.from({ length: ROSTER_HARD_CAP + 1 }, (_, index) => agent(`a${index}`, "dg"));
		expect(parseRosterBody(JSON.stringify({ v: 1, agents }))).toBeUndefined();
		const capped = Array.from({ length: ROSTER_LIMIT + 2 }, (_, index) => agent(`b${index}`, "dg"));
		expect(parseRosterBody(JSON.stringify({ v: 1, agents: capped }))).toHaveLength(ROSTER_LIMIT);
	});

	it("is ignored by a peer that only knows the older kinds, and a chat kind is not ignored", () => {
		expect(legacyPeerDisposition(ROSTER_KIND)).toBe("ignore");
		expect(legacyPeerDisposition(14)).toBe("chat");
		expect(legacyPeerDisposition(15)).toBe("chat");
		for (const kind of LEGACY_CONTROL_KINDS) expect(legacyPeerDisposition(kind)).toBe("control");
		for (const kind of LEGACY_CHAT_KINDS) expect(legacyPeerDisposition(kind)).not.toBe("ignore");
		expect(LEGACY_CONTROL_KINDS).not.toContain(ROSTER_KIND);
	});
});

describe("applying a roster", () => {
	it("rejects a stranger and does not write", () => {
		const home = tracker.freshHome();
		pool = createFakePool();
		out = [];
		const d = deps(home);
		const before = listContacts(d.db);
		expect(applyRoster(d.db, freshNpub(), [agent("kit", "claude")], NOW, new Set())).toEqual({ ok: false, reason: "stranger" });
		expect(listContacts(d.db)).toEqual(before);
	});

	it("skips a duplicate handle and stores the rest under the sender", () => {
		const home = tracker.freshHome();
		pool = createFakePool();
		out = [];
		const d = deps(home);
		createFileKey(d.db, "default");
		const sender = freshNpub();
		pairContact(d.db, sender, "box");
		pairContact(d.db, freshNpub(), "kit");
		const merc = agent("merc", "codex");
		const result = applyRoster(d.db, sender, [agent("kit", "grok"), merc], NOW, new Set());
		expect(result).toMatchObject({ ok: true, added: ["merc"], skipped: ["kit"] });
		expect(findContactByHandle(d.db, "kit")?.originNpub).toBeUndefined();
		expect(findContactByHandle(d.db, "merc")).toMatchObject({ npub: merc.npub, via: "roster", originNpub: sender, runtime: "codex" });
	});

	it("is idempotent, then a smaller roster drops only that machine's contacts", () => {
		const home = tracker.freshHome();
		pool = createFakePool();
		out = [];
		const d = deps(home);
		createFileKey(d.db, "default");
		const sender = freshNpub();
		const other = freshNpub();
		pairContact(d.db, sender, "box");
		pairContact(d.db, other, "other");
		const manual = freshNpub();
		pairContact(d.db, manual, "manual");
		const kit = agent("kit", "claude");
		const merc = agent("merc", "grok");
		const epoch = readAdmissionEpoch(d.db);
		applyRoster(d.db, sender, [kit, merc], NOW, new Set());
		expect(readAdmissionEpoch(d.db)).toBe(epoch + 1);
		applyRoster(d.db, other, [agent("ada", "codex")], NOW, new Set());
		const again = applyRoster(d.db, sender, [kit, merc], NOW, new Set());
		expect(again).toMatchObject({ ok: true, added: [], removed: [] });
		expect(readAdmissionEpoch(d.db)).toBe(epoch + 2);
		expect(applyRoster(d.db, sender, [kit], NOW, new Set())).toMatchObject({ removed: ["merc"] });
		expect(readAdmissionEpoch(d.db)).toBe(epoch + 3);
		applyRoster(d.db, sender, [{ handle: "kite", npub: kit.npub, runtime: "claude" }], NOW, new Set());
		expect(findContactByHandle(d.db, "kite")?.npub).toBe(kit.npub);
		expect(findContactByHandle(d.db, "kit")).toBeUndefined();
		expect(findContactByHandle(d.db, "merc")).toBeUndefined();
		expect(findContactByHandle(d.db, "ada")?.originNpub).toBe(other);
		expect(findContactByHandle(d.db, "manual")).toBeDefined();
		expect(findContactByHandle(d.db, "box")).toBeDefined();
	});

	it("does not apply a roster signed by a contact that arrived via roster", async () => {
		const home = tracker.freshHome();
		pool = createFakePool();
		out = [];
		const d = deps(home);
		createFileKey(d.db, "default");
		const importedSk = generateSecretKey();
		const importedNpub = nip19.npubEncode(getPublicKey(importedSk));
		addContact(d.db, {
			npub: importedNpub,
			handle: "ada",
			relays: ["wss://a.example"],
			keyId: numberKeyId(d.db),
			addedAt: NOW,
			via: "roster",
			originNpub: freshNpub(),
		});
		const kit = agent("kit", "claude");
		expect(applyRoster(d.db, importedNpub, [kit], NOW, new Set())).toEqual({ ok: false, reason: "imported" });
		await handleIncomingRoster(d, {
			id: "imported",
			wrapId: "wrap",
			kind: ROSTER_KIND,
			from: getPublicKey(importedSk),
			keyId: "default",
			createdAt: NOW,
			tags: [
				[ROSTER_TAG, "offer"],
				[ROSTER_BODY_TAG, rosterDocument([kit])],
			],
		});
		expect(findContactByHandle(d.db, "kit")).toBeUndefined();
		expect(d.db.takeHeldRoster(importedNpub)).toBeUndefined();
		expect(pool.events).toEqual([]);
	});

	it("rolls back every roster write when a later insert in the same apply throws", () => {
		const home = tracker.freshHome();
		pool = createFakePool();
		out = [];
		const d = deps(home);
		createFileKey(d.db, "default");
		const sender = freshNpub();
		pairContact(d.db, sender, "box");
		const original = d.db.insertContact.bind(d.db);
		let calls = 0;
		d.db.insertContact = (row) => {
			calls += 1;
			if (calls === 2) throw new Error("boom");
			return original(row);
		};
		expect(() => applyRoster(d.db, sender, [agent("kit", "claude"), agent("merc", "codex")], NOW, new Set())).toThrow("boom");
		expect(findContactByHandle(d.db, "kit")).toBeUndefined();
		expect(findContactByHandle(d.db, "merc")).toBeUndefined();
		expect(findContactByHandle(d.db, "box")?.via).toBe("accept");
	});

	it("skips this machine's own npub and the sender's npub", () => {
		const home = tracker.freshHome();
		pool = createFakePool();
		out = [];
		const d = deps(home);
		createFileKey(d.db, "default");
		const sender = freshNpub();
		pairContact(d.db, sender, "box");
		const epoch = readAdmissionEpoch(d.db);
		const own = agent("self", "dg");
		expect(applyRoster(d.db, sender, [own, { handle: "echo", npub: sender, runtime: "claude" }], NOW, new Set([own.npub]))).toMatchObject({
			added: [],
			skipped: ["self", "echo"],
		});
		expect(readAdmissionEpoch(d.db)).toBe(epoch);
		expect(findContactByHandle(d.db, "self")).toBeUndefined();
		expect(findContactByHandle(d.db, "echo")).toBeUndefined();
	});

	it("clears one machine and the next roster fills it back in", () => {
		const home = tracker.freshHome();
		pool = createFakePool();
		out = [];
		const d = deps(home);
		createFileKey(d.db, "default");
		const sender = freshNpub();
		pairContact(d.db, sender, "box");
		const kit = agent("kit", "claude");
		applyRoster(d.db, sender, [kit], NOW, new Set());
		d.db.writeRosterSent(sender, "stale");
		expect(clearMachineContacts(d.db, "+box")).toEqual({ machine: "+box", removed: ["+kit"] });
		expect(findContactByHandle(d.db, "kit")).toBeUndefined();
		expect(d.db.readRosterSent(sender)).toBeUndefined();
		expect(findContactByHandle(d.db, "box")).toBeDefined();
		applyRoster(d.db, sender, [kit], NOW, new Set());
		expect(findContactByHandle(d.db, "kit")?.npub).toBe(kit.npub);
		expect(clearMachineContacts(d.db, "+kit")).toEqual({ machine: "+box", removed: ["+kit"] });
		expect(findContactByHandle(d.db, "box")).toBeDefined();
		const quiet = readAdmissionEpoch(d.db);
		expect(clearMachineContacts(d.db, "+box")).toEqual({ machine: "+box", removed: [] });
		expect(readAdmissionEpoch(d.db)).toBe(quiet);
		expect(() => clearMachineContacts(d.db, "+missing")).toThrow("no contact +missing");
	});
});

describe("debounce", () => {
	const peer = (count: number) => Array.from({ length: count }, (_, index) => `npub${index}`);

	it("waits out a burst, sends once, and does not send the same hash again", () => {
		const peers = ["b", "a"];
		const first = planRosterFlush({ now: 10, hash: "h1", agentCount: 1, peers, sent: new Map(), state: undefined });
		expect(first.send).toEqual([]);
		expect(first.state.notBefore).toBe(10 + ROSTER_DEBOUNCE_S);
		const early = planRosterFlush({ now: 11, hash: "h1", agentCount: 1, peers, sent: new Map(), state: first.state });
		expect(early.send).toEqual([]);
		const due = planRosterFlush({ now: 12, hash: "h1", agentCount: 1, peers, sent: new Map(), state: early.state });
		expect(due.send).toEqual(["a", "b"]);
		const sent = new Map(due.send.map((npub) => [npub, "h1"]));
		const again = planRosterFlush({ now: 20, hash: "h1", agentCount: 1, peers, sent, state: due.state });
		expect(again.send).toEqual([]);
		expect(again.state.dirty).toBe(false);
	});

	it("collapses two hash changes into the latest roster and caps a long fan-out", () => {
		const start = planRosterFlush({ now: 0, hash: "old", agentCount: 1, peers: ["a"], sent: new Map(), state: undefined });
		const changed = planRosterFlush({ now: 1, hash: "new", agentCount: 2, peers: ["a"], sent: new Map(), state: start.state });
		expect(changed.send).toEqual([]);
		expect(changed.state.hash).toBe("new");
		expect(changed.state.notBefore).toBe(1 + ROSTER_DEBOUNCE_S);
		const peers = peer(ROSTER_FANOUT + 1);
		const waiting = planRosterFlush({ now: 0, hash: "h", agentCount: 1, peers, sent: new Map(), state: undefined });
		const first = planRosterFlush({ now: waiting.state.notBefore, hash: "h", agentCount: 1, peers, sent: new Map(), state: waiting.state });
		expect(first.send).toHaveLength(ROSTER_FANOUT);
		const sent = new Map(first.send.map((npub) => [npub, "h"]));
		const rest = planRosterFlush({ now: first.state.notBefore, hash: "h", agentCount: 1, peers, sent, state: first.state });
		expect(rest.send).toHaveLength(1);
		expect(planRosterFlush({ now: 0, hash: "h", agentCount: 0, peers: ["a"], sent: new Map(), state: undefined }).send).toEqual([]);
	});

	it("sends once the wait has already lasted the maximum", () => {
		const start = planRosterFlush({ now: 0, hash: "old", agentCount: 1, peers: ["a"], sent: new Map(), state: undefined });
		const late = planRosterFlush({ now: ROSTER_DEBOUNCE_MAX_S - 1, hash: "new", agentCount: 1, peers: ["a"], sent: new Map(), state: start.state });
		expect(late.send).toEqual([]);
		expect(late.state.notBefore).toBe(ROSTER_DEBOUNCE_MAX_S);
		const due = planRosterFlush({ now: ROSTER_DEBOUNCE_MAX_S, hash: "new", agentCount: 1, peers: ["a"], sent: new Map(), state: late.state });
		expect(due.send).toEqual(["a"]);
	});
});

describe("machine exchange", () => {
	const pairs = [
		["grok", "claude"],
		["claude", "grok"],
		["grok", "codex"],
		["codex", "grok"],
		["codex", "claude"],
		["claude", "codex"],
	] as const;

	async function side(handle: string, runtime: string): Promise<{ deps: PhoneDeps; sk: Uint8Array; npub: string; agent: RosterAgent }> {
		const d = deps(tracker.freshHome());
		await phoneNumber({}, d);
		const sk = createFileKey(d.db, numberKeyId(d.db)) ?? createFileKey(d.db, "default");
		if (!sk) throw new Error("number key");
		const npub = nip19.npubEncode(getPublicKey(sk));
		const agentNpub = identity(d.db, handle, runtime);
		return { deps: d, sk, npub, agent: { handle, npub: agentNpub, runtime: runtime as RosterAgent["runtime"] } };
	}

	async function deliver(from: { deps: PhoneDeps; sk: Uint8Array }, to: { deps: PhoneDeps; sk: Uint8Array; npub: string }, intent: "offer" | "reply"): Promise<void> {
		const event = pool.events.findLast((item) => item.tags.some((tag) => tag[0] === "p" && tag[1] === getPublicKey(to.sk)));
		if (!event) throw new Error("missing wrap");
		const tags = rumorTags(event, to.sk);
		expect(tags.some((tag) => tag[1]?.includes("nsec") || tag[1]?.includes("dgcall"))).toBe(false);
		expect(JSON.stringify(tags)).not.toContain("nsec");
		await handleIncomingRoster(to.deps, {
			id: "r",
			wrapId: event.id,
			kind: ROSTER_KIND,
			from: getPublicKey(from.sk),
			keyId: numberKeyId(to.deps.db),
			createdAt: NOW,
			tags: tags.filter((tag) => tag[0] === ROSTER_TAG || tag[0] === ROSTER_BODY_TAG),
		});
		expect(tags.find((tag) => tag[0] === ROSTER_TAG)?.[1]).toBe(intent);
	}

	for (const [leftRuntime, rightRuntime] of pairs) {
		it(`exchanges ${leftRuntime} and ${rightRuntime} agents after accept`, async () => {
			pool = createFakePool();
			out = [];
			const left = await side("leftbot", leftRuntime);
			out = [];
			const right = await side("rightbot", rightRuntime);
			const card = (lines()[0] as { card: string }).card;
			out = [];
			pool.events.length = 0;
			await phoneAccept(card, "hello", left.deps);
			expect(JSON.stringify(lines())).not.toContain("nsec");
			expect(lines().some((line) => JSON.stringify(line).includes("dg-agents"))).toBe(false);
			pairContact(right.deps.db, left.npub, "leftbox");
			await deliver(left, right, "offer");
			await deliver(right, left, "reply");
			expect(findContactByHandle(right.deps.db, "leftbot")).toMatchObject({ runtime: leftRuntime, originNpub: left.npub });
			expect(findContactByHandle(left.deps.db, "rightbot")).toMatchObject({ runtime: rightRuntime, originNpub: right.npub });
		});
	}

	it("stores a mixed Claude, Codex, and Grok roster from one machine", async () => {
		pool = createFakePool();
		out = [];
		const box = deps(tracker.freshHome());
		await phoneNumber({}, box);
		const boxSk = createFileKey(box.db, numberKeyId(box.db));
		if (!boxSk) throw new Error("key");
		const boxNpub = nip19.npubEncode(getPublicKey(boxSk));
		const mixed = [
			{ handle: "dante", runtime: "claude" },
			{ handle: "merc", runtime: "codex" },
			{ handle: "warren", runtime: "grok" },
		].map((agent) => ({ ...agent, npub: identity(box.db, agent.handle, agent.runtime) }));
		const peer = deps(tracker.freshHome());
		const peerSk = createFileKey(peer.db, "default");
		if (!peerSk) throw new Error("peer key");
		const peerNpub = nip19.npubEncode(getPublicKey(peerSk));
		pairContact(box.db, peerNpub, "peer");
		pairContact(peer.db, boxNpub, "box");
		pool.events.length = 0;
		await sendRoster(box, peerNpub, "update");
		const event = pool.events.at(-1);
		if (!event) throw new Error("roster");
		const tags = rumorTags(event, peerSk);
		const body = tags.find((tag) => tag[0] === ROSTER_BODY_TAG)?.[1] ?? "";
		expect(JSON.parse(body).v).toBe(1);
		expect(applyRoster(peer.db, boxNpub, parseRosterBody(body) ?? [], NOW, new Set())).toMatchObject({
			ok: true,
			added: ["dante", "merc", "warren"],
		});
		expect(listContacts(peer.db).filter((contact) => contact.via === "roster").map((contact) => contact.runtime).sort()).toEqual(["claude", "codex", "grok"]);
		expect(mixed).toHaveLength(3);
	});

	it("lets a peer with no roster support keep the text and drop the roster", async () => {
		pool = createFakePool();
		out = [];
		const d = deps(tracker.freshHome());
		const sk = createFileKey(d.db, "default");
		if (!sk) throw new Error("key");
		const peerSk = generateSecretKey();
		const peerNpub = nip19.npubEncode(getPublicKey(peerSk));
		pairContact(d.db, peerNpub, "peer");
		const roster = wrapTagged(
			{ kind: ROSTER_KIND, content: "", tags: [[ROSTER_TAG, "offer"], [ROSTER_BODY_TAG, rosterDocument([agent("kit", "claude")])] ] },
			peerSk,
			getPublicKey(sk),
		);
		pool.events.push(roster, wrap("hello from claude", peerSk, getPublicKey(sk)));
		const keys: KeyEntry[] = [{ id: "default", pub: getPublicKey(sk), sk }];
		const caught = await fetchNew(pool, ["wss://a.example"], keys, gateFor(d.db), { cursor: 0, ids: [] }, () => NOW + 10);
		expect(caught.messages.map((message) => message.text)).toEqual(["hello from claude"]);
		expect(caught.controls.map((control) => control.kind)).toEqual([ROSTER_KIND]);
		expect(listContacts(d.db).map((contact) => contact.handle)).toEqual(["peer"]);
		const before = listContacts(d.db);
		await handleIncomingRoster(d, {
			id: "x",
			wrapId: "y",
			kind: ROSTER_KIND,
			from: getPublicKey(peerSk),
			keyId: "default",
			createdAt: NOW,
			tags: [[ROSTER_TAG, "offer"], [ROSTER_BODY_TAG, JSON.stringify({ v: 99, agents: [agent("kit", "claude")] })]],
		});
		expect(listContacts(d.db)).toEqual(before);
	});

	it("names itself from the runtime that is actually running, and falls back when none is", async () => {
		pool = createFakePool();
		out = [];
		const home = tracker.freshHome();
		mkdirSync(join(home, ".claude", "sessions"), { recursive: true });
		writeFileSync(join(home, ".claude", "sessions", "s.json"), JSON.stringify({ name: "Dante", id: "sess-1" }));
		const claude = deps(home, { homeDir: home, env: { CLAUDE_CODE_SESSION_ID: "sess-1" } });
		await phoneNumber({}, claude);
		expect(lines()[0]).toMatchObject({ as: "dante" });
		expect(claude.db.listIdentities()).toEqual([{ handle: "dante", key_id: "agent-dante", runtime: "claude" }]);

		out = [];
		const grok = deps(tracker.freshHome(), { env: { GROK_BOT_NAME: "Warren" } });
		await phoneNumber({}, grok);
		expect(lines()[0]).toMatchObject({ as: "warren" });

		out = [];
		const codexHome = tracker.freshHome();
		mkdirSync(join(codexHome, ".codex"), { recursive: true });
		writeFileSync(join(codexHome, ".codex", "session_index.jsonl"), `${JSON.stringify({ id: "thr-9", thread_name: "Merc" })}\n`);
		const codex = deps(codexHome, { homeDir: codexHome, env: { CODEX_THREAD_ID: "thr-9", CODEX_HOME: join(codexHome, ".codex") } });
		await phoneNumber({}, codex);
		expect(lines()[0]).toMatchObject({ as: "merc" });

		out = [];
		const none = deps(tracker.freshHome(), { env: {}, homeDir: tracker.freshHome() });
		await phoneNumber({}, none);
		expect(lines()[0]).toMatchObject({ as: "dg" });
		expect(none.db.listIdentities()).toEqual([]);
		expect(readNumber(none.db)?.as).toBe("dg");
	});

	it("does not rename a phone that already has a self name", async () => {
		pool = createFakePool();
		out = [];
		const home = tracker.freshHome();
		const d = deps(home, { env: {} });
		await phoneNumber({}, d);
		out = [];
		mkdirSync(join(home, ".claude", "sessions"), { recursive: true });
		writeFileSync(join(home, ".claude", "sessions", "s.json"), JSON.stringify({ name: "Dante", id: "sess-1" }));
		d.homeDir = home;
		d.env = { CLAUDE_CODE_SESSION_ID: "sess-1" };
		await phoneNumber({}, d);
		expect(lines()[0]).toMatchObject({ as: "dg" });
		expect(d.db.listIdentities().map((row) => row.handle)).toEqual(["dante"]);
	});

	it("accept applies a roster held for that card before sending our own", async () => {
		pool = createFakePool();
		out = [];
		const owner = deps(tracker.freshHome());
		await phoneNumber({}, owner);
		const printed = lines()[0] as { card: string; npub: string };
		const peer = deps(tracker.freshHome());
		const kit = agent("kit", "claude");
		peer.db.holdRoster(printed.npub, rosterDocument([kit]), "offer");
		pool.events.length = 0;
		await phoneAccept(printed.card, "hi", peer);
		expect(findContactByHandle(peer.db, "kit")?.npub).toBe(kit.npub);
		expect(peer.db.takeHeldRoster(printed.npub)).toBeUndefined();
		expect(pool.events.length).toBeGreaterThanOrEqual(2);
	});

	it("answers an update from a paired machine and holds one from a stranger", async () => {
		pool = createFakePool();
		out = [];
		const d = deps(tracker.freshHome());
		const sk = createFileKey(d.db, "default");
		if (!sk) throw new Error("key");
		const friend = generateSecretKey();
		const friendNpub = nip19.npubEncode(getPublicKey(friend));
		pairContact(d.db, friendNpub, "box");
		const kit = agent("kit", "claude");
		await handleIncomingRoster(d, {
			id: "u",
			wrapId: "w",
			kind: ROSTER_KIND,
			from: getPublicKey(friend),
			keyId: "default",
			createdAt: NOW,
			tags: [[ROSTER_TAG, "update"], [ROSTER_BODY_TAG, rosterDocument([kit])]],
		});
		expect(findContactByHandle(d.db, "kit")?.originNpub).toBe(friendNpub);
		expect(pool.events).toEqual([]);
		const stranger = generateSecretKey();
		const before = listContacts(d.db).length;
		await handleIncomingRoster(d, {
			id: "s",
			wrapId: "t",
			kind: ROSTER_KIND,
			from: getPublicKey(stranger),
			keyId: "default",
			createdAt: NOW,
			tags: [[ROSTER_TAG, "offer"], [ROSTER_BODY_TAG, rosterDocument([agent("ada", "codex")])]],
		});
		expect(listContacts(d.db)).toHaveLength(before);
		expect(d.db.takeHeldRoster(nip19.npubEncode(getPublicKey(stranger)))?.intent).toBe("offer");
	});

	it("close --with --clear removes that machine and close without it still reports closed", async () => {
		pool = createFakePool();
		out = [];
		const d = deps(tracker.freshHome());
		createFileKey(d.db, "default");
		const sender = freshNpub();
		pairContact(d.db, sender, "box");
		applyRoster(d.db, sender, [agent("kit", "grok")], NOW, new Set());
		await phoneClose(d as OpenCloseDeps, { with: "+box", clear: true });
		expect(lines()[0]).toEqual({ machine: "+box", removed: ["+kit"], status: "cleared" });
		expect(findContactByHandle(d.db, "box")).toBeDefined();
		await expect(phoneClose(d as OpenCloseDeps, { clear: true })).rejects.toThrow("--with");
	});
});

describe("roster hash", () => {
	it("pushes a changed roster once, and not to contacts that came from a roster", async () => {
		pool = createFakePool();
		out = [];
		let clock = 100;
		const home = tracker.freshHome();
		const base = deps(home);
		const d = { ...base, now: () => clock };
		createFileKey(d.db, "default");
		identity(d.db, "warren", "grok");
		pairContact(d.db, freshNpub(), "box");
		const imported = freshNpub();
		addContact(d.db, {
			npub: imported,
			handle: "ada",
			relays: ["wss://a.example"],
			keyId: numberKeyId(d.db),
			addedAt: NOW,
			via: "roster",
			originNpub: freshNpub(),
		});
		expect(await flushRosterPush(d)).toBe(0);
		clock = 102;
		expect(await flushRosterPush(d)).toBe(1);
		expect(await flushRosterPush(d)).toBe(0);
		expect(pool.events).toHaveLength(1);
	});

	it("changes when an agent is added and ignores order", () => {
		const kit = agent("kit", "claude");
		const merc = agent("merc", "codex");
		expect(rosterHash([merc, kit])).toBe(rosterHash([kit, merc]));
		expect(rosterHash([kit])).not.toBe(rosterHash([kit, merc]));
	});
});
