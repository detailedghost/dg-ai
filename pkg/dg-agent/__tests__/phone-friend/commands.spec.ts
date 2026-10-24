import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DgCliError } from "@dg/common";
import { Command } from "commander";
import { type DgPaths, resolveDgPaths } from "@dg/common/node";
import { generateSecretKey, getPublicKey, type NostrEvent, nip19, nip59 } from "nostr-tools";
import { fetchNew, ring, wrap } from "../../src/phone-friend/chat";
import {
	type PhoneFriendDeps,
	phoneAnswer,
	phoneDial,
	phoneCard,
	phoneContacts,
	phoneDeliverOff,
	phoneDeliverOn,
	phoneInvite,
	phoneName,
	phoneNumber,
	phoneSay,
	phoneVoicemail,
	isListenerArgs,
	registerPhoneFriendCommands,
	phoneOn,
	phoneOff,
} from "../../src/phone-friend/commands";
import { PHONE_FRIEND_SAFETY_REF } from "../../src/phone-friend/deliver";
import {
	DEFAULT_RELAYS,
	claimStart,
	createFileKey,
	readFileKey,
	readConfig,
	readInvite,
	writeConfig,
} from "../../src/phone-friend/store";
import { decodeCard, encodeCard } from "../../src/phone-friend/card";
import { PhoneFriendDb } from "../../src/phone-friend/db";
import { type LinePaths, linePaths } from "../../src/phone-friend/line";
import { createFakePool, type FakePool } from "./fake-pool";

let home: string;
let paths: DgPaths;
let line: LinePaths;
let out: string[];
let spawned: number;
let alive: Set<number>;
let pool: FakePool;
const NOW = Math.floor(Date.now() / 1000);
const contactSk = generateSecretKey();
const contactNpub = nip19.npubEncode(getPublicKey(contactSk));

function deps(overrides: Partial<PhoneFriendDeps> = {}): PhoneFriendDeps {
	return {
		paths,
		line,
		createPool: () => ({ ...pool, close: () => {} }),
		spawnListener: () => {
			spawned += 1;
			alive.add(4242);
			return 4242;
		},
		isAlive: (pid) => alive.has(pid),
		kill: (pid) => {
			alive.delete(pid);
		},
		write: (text) => {
			out.push(text);
		},
		sleep: async () => {},
		now: () => NOW,
		sessionClient: async () => undefined,
		grantClient: () => {
			throw new Error("no grant in file-mode tests");
		},
		readStdin: async () => "from stdin\n",
		...overrides,
	};
}

function stored(message: { id: string; ts: number; from: string; text: string }): void {
	const inbox = PhoneFriendDb.open(line, () => NOW);
	inbox.add(message, "in", message.from);
	inbox.close();
}

function history() {
	const inbox = PhoneFriendDb.open(line, () => NOW);
	const all = inbox.history();
	inbox.close();
	return all;
}

function myKey(): Uint8Array {
	return (readFileKey(line) ?? createFileKey(line)) as Uint8Array;
}

function pair(): void {
	writeConfig(line, { contact: contactNpub, relays: DEFAULT_RELAYS });
}

function lines(): unknown[] {
	return out.join("").trim().split("\n").filter(Boolean).map((row) => JSON.parse(row));
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "dg-phone-friend-cli-"));
	paths = resolveDgPaths({ env: { DG_HOME: home } });
	line = linePaths(paths);
	out = [];
	spawned = 0;
	alive = new Set();
	pool = createFakePool();
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

describe("phoneOn", () => {
	it("waits for another command that is starting the listener, then gives up", async () => {
		pair();
		claimStart(line, NOW);
		let spawned = 0;

		await expect(phoneOn(deps({ spawnListener: () => ++spawned }))).rejects.toThrow(
			"another phone-friend command is starting the listener",
		);
		expect(spawned).toBe(0);
	});

	it("releases its start claim, so the next start does not wait", async () => {
		pair();
		await phoneOn(deps());

		expect(claimStart(line, NOW)).toBeDefined();
	});

	it("stops the new listener when the pid file cannot be written", async () => {
		pair();
		const killed: number[] = [];
		const spawnListener = () => {
			mkdirSync(line.pidPath);
			return 77;
		};

		await expect(phoneOn(deps({ spawnListener, kill: (pid) => killed.push(pid) }))).rejects.toThrow();
		expect(killed).toEqual([77]);
	});

	it("spawns the listener once for a saved contact and prints our npub", async () => {
		pair();
		await phoneOn(deps());
		await phoneOn(deps());

		expect(spawned).toBe(1);
		const npub = nip19.npubEncode(getPublicKey(myKey()));
		expect(lines()).toEqual([
			{ npub, contact: contactNpub, pid: 4242, status: "started" },
			{ npub, contact: contactNpub, pid: 4242, status: "running" },
		]);
	});

	it("respawns when the saved pid is no longer alive", async () => {
		pair();
		await phoneOn(deps());
		alive.clear();

		await phoneOn(deps());

		expect(spawned).toBe(2);
	});

	it("is a no-op once invite already started the listener with no contact", async () => {
		await phoneInvite({}, deps());
		expect(spawned).toBe(1);

		await phoneOn(deps());

		expect(spawned).toBe(1);
		expect(lines().at(-1)).toMatchObject({ contact: null, status: "running" });
	});

	it("refuses with no contact and no invite, and says how to pair", async () => {
		await expect(phoneOn(deps())).rejects.toThrow("phone-friend invite");
		expect(spawned).toBe(0);
	});

	it("refuses when the only invite has expired", async () => {
		await phoneInvite({ ttl: "1" }, deps());

		await expect(phoneOn(deps({ now: () => NOW + 3601 }))).rejects.toThrow("phone-friend invite");
	});
});

describe("phoneInvite", () => {
	it("prints a card with our npub, the relays, and a fresh secret, and saves the invite", async () => {
		await phoneInvite({ relay: ["wss://x.example"] }, deps());

		const [{ card, expires_at, handle }] = lines() as { card: string; expires_at: string; handle: string }[];
		const decoded = decodeCard(card, NOW);
		expect(decoded.npub).toBe(nip19.npubEncode(getPublicKey(myKey())));
		expect(decoded.relays).toEqual(["wss://x.example"]);
		expect(decoded.exp).toBe(NOW + 24 * 3600);
		expect(expires_at).toBe(new Date((NOW + 24 * 3600) * 1000).toISOString());
		expect(handle).toBe("@default");
		expect(readInvite(line)).toEqual({ secret: decoded.secret, expiresAt: decoded.exp });
		expect(readConfig(line).relays).toEqual(["wss://x.example"]);
	});

	it("keeps the line's own handle at invite time; --name only takes effect once answered", async () => {
		await phoneInvite({ name: "grok" }, deps());

		const [{ handle }] = lines() as { handle: string }[];
		expect(handle).toBe("@default");
	});

	it("starts the listener right away, so the card can ring without a separate on", async () => {
		await phoneInvite({}, deps());

		expect(spawned).toBe(1);
		expect(existsSync(line.pidPath)).toBe(true);
		expect(alive.has(4242)).toBe(true);
	});

	it("refuses relays that the other side could not dial, and saves nothing", async () => {
		const tooMany = Array.from({ length: 11 }, (_, i) => `wss://r${i}.example`);

		for (const relay of [["http://x.example"], ["wss://x.example/ bad"], tooMany]) {
			await expect(phoneInvite({ relay }, deps())).rejects.toThrow("--relay must be 1 to 10 wss:// URLs");
		}
		expect(readInvite(line)).toBeUndefined();
	});

	it("makes a new secret each time", async () => {
		await phoneInvite({}, deps());
		await phoneInvite({}, deps());

		const [first, second] = (lines() as { card: string }[]).map((l) => decodeCard(l.card, NOW).secret);
		expect(first).not.toBe(second);
	});

	it("restarts a running listener so it sees the new invite", async () => {
		pair();
		await phoneOn(deps());

		await phoneInvite({}, deps());

		expect(spawned).toBe(2);
	});

	it("rejects a ttl that is not a positive number of hours", async () => {
		await expect(phoneInvite({ ttl: "0" }, deps())).rejects.toThrow("ttl");
		await expect(phoneInvite({ ttl: "abc" }, deps())).rejects.toThrow("ttl");
	});
});

describe("phoneDial", () => {
	const secret = "ab".repeat(32);

	function cardFor(relays = ["wss://x.example"]) {
		return encodeCard({ npub: contactNpub, relays, secret, exp: NOW + 100 });
	}

	it("saves the card owner as the contact, uses its relays, and rings with the secret", async () => {
		await phoneDial(cardFor(), undefined, deps());

		expect(readConfig(line)).toEqual({ contact: contactNpub, relays: ["wss://x.example"] });
		const rumor = nip59.unwrapEvent(pool.events[0] as NostrEvent, contactSk);
		expect(rumor.content).toBe("hello");
		expect(rumor.tags).toContainEqual(["dg-call", secret]);
		expect(lines()).toMatchObject([{ contact: contactNpub, relays_ok: ["wss://x.example"], handle: "@default" }]);
	});

	it("names the card owner when dial gets a name, and uses it as the handle", async () => {
		await phoneDial(cardFor(), undefined, deps(), "dante");

		expect(readConfig(line)).toMatchObject({ contact: contactNpub, name: "dante" });
		expect(lines()).toMatchObject([{ handle: "@dante" }]);
	});

	it("starts the listener right away, so a reply is not missed", async () => {
		await phoneDial(cardFor(), undefined, deps());

		expect(spawned).toBe(1);
		expect(existsSync(line.pidPath)).toBe(true);
		expect(alive.has(4242)).toBe(true);
	});

	it("refuses a dial name that another line uses before it rings", async () => {
		writeConfig(linePaths(paths, "work"), { contact: contactNpub, name: "dante", relays: DEFAULT_RELAYS });

		await expect(phoneDial(cardFor(), undefined, deps(), "dante")).rejects.toThrow("already used by line work");
		expect(pool.events).toHaveLength(0);
		expect(readConfig(line).contact).toBeUndefined();
	});

	it("reads the card from stdin when the argument is -", async () => {
		await phoneDial("-", undefined, deps({ readStdin: async () => `${cardFor()}\n` }));

		expect(readConfig(line).contact).toBe(contactNpub);
	});

	it("rejects empty stdin for a card", async () => {
		await expect(phoneDial("-", undefined, deps({ readStdin: async () => "" }))).rejects.toThrow("no call card");
	});

	it("saves the ring in the history as an outgoing call", async () => {
		await phoneDial(cardFor(), "hi", deps());

		expect(history()).toMatchObject([{ text: "hi", direction: "out", call: true, contact: contactNpub }]);
	});

	it("sends custom first words", async () => {
		await phoneDial(cardFor(), "hi, it is grok", deps());

		expect(nip59.unwrapEvent(pool.events[0] as NostrEvent, contactSk).content).toBe("hi, it is grok");
	});

	it("keeps the old config when no relay accepts the ring", async () => {
		pair();
		pool = createFakePool([]);

		await expect(phoneDial(cardFor(), undefined, deps())).rejects.toThrow("no relay");

		expect(readConfig(line).relays).not.toEqual(["wss://x.example"]);
	});

	it("rejects an expired card", async () => {
		await expect(phoneDial(cardFor(), undefined, deps({ now: () => NOW + 101 }))).rejects.toThrow("expired");
	});
});

describe("accepting a call", () => {
	it("voicemail pairs the caller, clears the invite, and marks the line as a call", async () => {
		await phoneInvite({}, deps());
		alive.clear();
		const { secret } = readInvite(line) as { secret: string };
		const mine = getPublicKey(myKey());
		await Promise.allSettled(pool.publish(["wss://a"], ring("hello", contactSk, mine, secret)));
		out = [];

		await phoneVoicemail(deps());

		expect(lines()).toMatchObject([{ from: contactNpub, text: "hello", call: true, handle: "@default" }]);
		expect(readConfig(line).contact).toBe(contactNpub);
		expect(readInvite(line)).toBeUndefined();
	});

	it("names the caller with the name the invite was made for, and prints that handle on the call", async () => {
		await phoneInvite({ name: "grok" }, deps());
		alive.clear();
		const { secret } = readInvite(line) as { secret: string };
		await Promise.allSettled(pool.publish(["wss://a"], ring("hello", contactSk, getPublicKey(myKey()), secret)));
		out = [];

		await phoneVoicemail(deps());

		expect(readConfig(line)).toMatchObject({ contact: contactNpub, name: "grok" });
		expect(lines()).toMatchObject([{ call: true, handle: "@grok" }]);
	});

	it("refuses an invite name that another line already uses, and saves no invite", async () => {
		writeConfig(linePaths(paths, "work"), { contact: contactNpub, name: "grok", relays: DEFAULT_RELAYS });

		await expect(phoneInvite({ name: "grok" }, deps())).rejects.toThrow("already used by line work");
		expect(readInvite(line)).toBeUndefined();
	});
});

describe("phoneNumber", () => {
	it("prints our npub, the contact, the key store, and the listener pid", async () => {
		await phoneNumber(deps());
		pair();
		await phoneOn(deps());
		out = [];

		await phoneNumber(deps());

		const npub = nip19.npubEncode(getPublicKey(myKey()));
		expect(lines()).toEqual([
			{ line: "default", npub, contact: contactNpub, name: null, handle: "@default", key_store: "file", listener: 4242 },
		]);
	});

	it("reports no contact and no listener before pairing", async () => {
		await phoneNumber(deps());

		expect(lines()).toMatchObject([{ contact: null, listener: null }]);
	});
});

describe("phoneName and phoneContacts", () => {
	it("names the contact and lists it with its line and listener", async () => {
		pair();
		await phoneOn(deps());
		out = [];

		phoneName("velora", deps());
		phoneContacts(deps());

		expect(lines()).toEqual([
			{ line: "default", name: "velora", contact: contactNpub },
			{ line: "default", name: "velora", contact: contactNpub, handle: "@velora", listener: 4242 },
		]);
		expect(readConfig(line).name).toBe("velora");
	});

	it("refuses a name with no contact, a bad name, or a name another line uses", () => {
		expect(() => phoneName("velora", deps())).toThrow("no contact saved");
		pair();
		expect(() => phoneName("Velora!", deps())).toThrow("lowercase");
		const other = linePaths(paths, "work");
		writeConfig(other, { contact: contactNpub, name: "velora", relays: DEFAULT_RELAYS });
		expect(() => phoneName("velora", deps())).toThrow("already used by line work");
		expect(() => phoneName("work", deps())).toThrow("already used by line work");
	});
});

describe("phoneCard", () => {
	it("prints the open card again with the same secret, relays, and expiry", async () => {
		await phoneInvite({ relay: ["wss://x.example"] }, deps());
		const [first] = lines() as { card: string; expires_at: string; safety: string }[];
		out = [];

		await phoneCard(deps());

		expect(lines()).toEqual([first]);
		expect(first.safety).toBe(PHONE_FRIEND_SAFETY_REF);
	});

	it("shows the open card's expiry in phoneNumber, and hides it once no card is open", async () => {
		await phoneInvite({ ttl: "1" }, deps());
		out = [];

		await phoneNumber(deps());
		await phoneNumber(deps({ now: () => NOW + 3601 }));

		const [open, expired] = lines() as Record<string, unknown>[];
		expect(open.card_expires_at).toBe(new Date((NOW + 3600) * 1000).toISOString());
		expect(expired).not.toHaveProperty("card_expires_at");
	});

	it("refuses with no open card and says how to make one", async () => {
		await expect(phoneCard(deps())).rejects.toThrow("phone-friend invite");
		await phoneInvite({ ttl: "1" }, deps());
		await expect(phoneCard(deps({ now: () => NOW + 3601 }))).rejects.toThrow("no open call card");
	});
});

describe("phoneOff", () => {
	it("kills the listener and removes the pid file", async () => {
		pair();
		await phoneOn(deps());

		await phoneOff(deps());

		expect(alive.has(4242)).toBe(false);
		expect(existsSync(line.pidPath)).toBe(false);
	});

	it("cleans up a stale pid without error", async () => {
		pair();
		await phoneOn(deps());
		alive.clear();

		await phoneOff(deps());

		expect(existsSync(line.pidPath)).toBe(false);
	});
});

describe("phoneVoicemail and phoneAnswer", () => {
	it("fetches from relays when no listener runs and prints each message once", async () => {
		pair();
		await phoneOn(deps({ spawnListener: () => 1 }));
		const mine = getPublicKey(myKey());
		await Promise.allSettled(pool.publish(["wss://a"], wrap("hello", contactSk, mine)));
		out = [];

		await phoneVoicemail(deps());
		await phoneVoicemail(deps());

		expect(lines()).toMatchObject([{ from: contactNpub, text: "hello" }]);
	});

	it("reads only the inbox when the listener runs", async () => {
		pair();
		await phoneOn(deps());
		stored({ id: "x", ts: NOW, from: contactNpub, text: "from listener" });
		out = [];

		await phoneVoicemail(deps());

		expect(pool.filters).toEqual([]);
		expect(lines()).toMatchObject([{ text: "from listener", title: "from listener" }]);
	});

	it("adds a non-empty feed title and leaves the stored text unchanged", async () => {
		pair();
		await phoneOn(deps());
		stored({ id: "pad", ts: NOW, from: contactNpub, text: "  hello  " });
		stored({ id: "blank", ts: NOW, from: contactNpub, text: "   " });
		out = [];

		await phoneVoicemail(deps());

		expect(lines()).toEqual([
			expect.objectContaining({ id: "blank", text: "   ", title: "(empty)" }),
			expect.objectContaining({ id: "pad", text: "  hello  ", title: "hello" }),
		]);
	});

	it("follows the inbox until the listener stops", async () => {
		pair();
		await phoneOn(deps());
		out = [];
		let ticks = 0;
		const follow = deps({
			sleep: async () => {
				ticks += 1;
				if (ticks === 1) stored({ id: "y", ts: NOW, from: contactNpub, text: "live" });
				if (ticks === 2) alive.clear();
			},
		});

		await expect(phoneAnswer(follow)).rejects.toThrow("stopped");

		expect(lines()).toMatchObject([{ text: "live" }]);
		expect(lines()[0]).not.toHaveProperty("title");
	});

	it("refuses to follow when no listener runs", async () => {
		await expect(phoneAnswer(deps())).rejects.toThrow("dg-agent phone-friend on");
	});

	it("with --restart, starts the listener itself instead of refusing", async () => {
		pair();
		out = [];

		const stop = new Error("test stop");
		const restart = deps({
			sleep: async () => {
				throw stop;
			},
		});

		await expect(phoneAnswer(restart, { restart: true })).rejects.toBe(stop);

		expect(spawned).toBe(1);
		expect(lines()).toMatchObject([{ pid: 4242 }]);
	});

	it("with --restart, respawns the listener when it stops and keeps answering", async () => {
		pair();
		await phoneOn(deps());
		out = [];
		let ticks = 0;
		const stop = new Error("test stop");
		const restart = deps({
			sleep: async () => {
				ticks += 1;
				if (ticks === 1) stored({ id: "y", ts: NOW, from: contactNpub, text: "live" });
				if (ticks === 2) alive.clear();
				if (ticks === 4) throw stop;
			},
		});

		await expect(phoneAnswer(restart, { restart: true })).rejects.toBe(stop);

		expect(spawned).toBe(2);
		expect(lines()).toMatchObject([{ text: "live" }, { pid: 4242 }]);
	});

	it("with --restart, gives up after repeated dead-on-arrival restarts", async () => {
		pair();
		await phoneOn(deps());
		out = [];
		let ticks = 0;
		const flaky = deps({
			spawnListener: () => {
				spawned += 1;
				return 9999;
			},
			sleep: async () => {
				ticks += 1;
				if (ticks === 1) alive.clear();
			},
		});

		await expect(phoneAnswer(flaky, { restart: true })).rejects.toThrow("keeps dying");

		expect(spawned).toBe(4);
	});

	it("with --restart, gives up on a listener that flaps instead of restarting forever", async () => {
		pair();
		let ticks = 0;
		const FLAP_PID = 5555;
		const flapping = deps({
			spawnListener: () => {
				spawned += 1;
				return FLAP_PID;
			},
			isAlive: (pid) => pid === FLAP_PID && ticks % 2 === 0,
			sleep: async () => {
				ticks += 1;
			},
		});

		await expect(phoneAnswer(flapping, { restart: true })).rejects.toThrow("keeps dying");

		expect(spawned).toBe(3);
	});

	it("with --restart, still refuses when there is no contact or live invite to restart with", async () => {
		out = [];

		await expect(phoneAnswer(deps(), { restart: true })).rejects.toThrow("dg-agent phone-friend on");

		expect(spawned).toBe(0);
	});

	it("with --restart, refuses mid-loop once the invite expires with no contact saved", async () => {
		const base = deps();
		await phoneInvite({}, base);
		await phoneOn(base);
		out = [];
		let ticks = 0;
		const restart = deps({
			now: () => (ticks >= 1 ? NOW + 100_000_000 : NOW),
			sleep: async () => {
				ticks += 1;
				if (ticks === 1) alive.clear();
			},
		});

		await expect(phoneAnswer(restart, { restart: true })).rejects.toThrow(
			"no contact or live invite to restart it with",
		);
	});

	it("with --restart, does not give up early once the listener has been stable again", async () => {
		pair();
		out = [];
		let ticks = 0;
		const STABLE_PID = 7777;
		const stop = new Error("test stop");
		const settling = deps({
			spawnListener: () => {
				spawned += 1;
				return STABLE_PID;
			},
			isAlive: (pid) => pid === STABLE_PID && ticks <= 3,
			sleep: async () => {
				ticks += 1;
				if (ticks === 7) throw stop;
			},
		});

		await expect(phoneAnswer(settling, { restart: true })).rejects.toBe(stop);

		expect(spawned).toBe(4);
	});
});

describe("phoneSay", () => {
	it("publishes a wrap the contact can read and prints the accepting relays", async () => {
		pair();
		await phoneOn(deps());
		out = [];

		await phoneSay("ping", deps());

		const [result] = lines() as { id: string; relays_ok: string[] }[];
		expect(result.relays_ok).toEqual(readConfig(line).relays);
		expect(pool.events[0]?.id).toBe(result.id);
	});

	it("saves the sent message in the history, never as unread", async () => {
		pair();

		await phoneSay("ping", deps());

		expect(history()).toMatchObject([{ text: "ping", direction: "out", contact: contactNpub }]);
		out = [];
		await phoneVoicemail(deps());
		expect(lines().filter((row) => (row as { text?: string }).text === "ping")).toEqual([]);
	});

	it("reads the text from stdin when the argument is -", async () => {
		pair();
		await phoneOn(deps());
		const mine = getPublicKey(myKey());
		const reader = createFakePool();

		await phoneSay("-", deps());
		reader.events.push(...pool.events);
		const { messages } = await fetchNew(reader, ["wss://a"], contactSk, { contact: mine }, { cursor: 0, ids: [] });

		expect(messages.map((m) => m.text)).toEqual(["from stdin"]);
	});

	it("rejects empty stdin", async () => {
		pair();
		await phoneOn(deps());

		await expect(phoneSay("-", deps({ readStdin: async () => "" }))).rejects.toThrow("empty");
	});

	it("fails when no relay accepts the message", async () => {
		pair();
		await phoneOn(deps());
		pool = createFakePool([]);

		await expect(phoneSay("ping", deps())).rejects.toThrow("no relay");
	});

	it("fails when no contact is saved", async () => {
		await expect(phoneSay("ping", deps())).rejects.toBeInstanceOf(DgCliError);
	});
});

describe("registerPhoneFriendCommands", () => {
	it("passes the global --session to the deps of the command that runs", async () => {
		const program = new Command().exitOverride().option("-s, --session <id>");
		const sessions: (string | undefined)[] = [];
		registerPhoneFriendCommands(program, (session) => {
			sessions.push(session);
			return deps();
		});

		await program.parseAsync(["node", "dg-agent", "--session", "abc", "phone-friend", "number"]);

		expect(sessions).toEqual(["abc"]);
		expect(lines()).toMatchObject([{ key_store: "file", line: "default" }]);
	});

	it("passes --line to the deps, so each line is its own number", async () => {
		const program = new Command().exitOverride().option("-s, --session <id>");
		const seen: (string | undefined)[] = [];
		registerPhoneFriendCommands(program, (_session, name) => {
			seen.push(name);
			return { ...deps(), line: linePaths(paths, name) };
		});

		await program.parseAsync(["node", "dg-agent", "phone-friend", "--line", "work", "number"]);
		await program.parseAsync(["node", "dg-agent", "phone-friend", "number"]);

		expect(seen).toEqual(["work", "default"]);
		const [work, main] = lines() as { npub: string; line: string }[];
		expect(work.line).toBe("work");
		expect(main.line).toBe("default");
		expect(work.npub).not.toBe(main.npub);
	});
});

describe("phoneDeliver", () => {
	function recordingDeps(calls: string[][]): PhoneFriendDeps {
		return {
			...deps(),
			runJobCli: async (args) => {
				calls.push(args);
				return { code: 0, stdout: "", stderr: "" };
			},
		};
	}

	it("registers the default line without --line and prints the stored argv", async () => {
		const calls: string[][] = [];

		await phoneDeliverOn({ notify: "  reviewer  ", every: " 1m " }, recordingDeps(calls));

		expect(calls[0]).toEqual([
			"job",
			"add",
			"--label",
			"phone-friend:default",
			"--every",
			"1m",
			"--cwd",
			paths.stateDir,
			"--notify",
			"reviewer",
			"--",
			"dg-agent",
			"phone-friend",
			"voicemail",
		]);
		expect(lines()[0]).toMatchObject({
			line: "default",
			delivery: "on",
			status: "added",
			notify: "reviewer",
			argv: ["dg-agent", "phone-friend", "voicemail"],
		});
	});

	it("pauses the line job", async () => {
		const calls: string[][] = [];

		await phoneDeliverOff(recordingDeps(calls));

		expect(calls).toEqual([["job", "disable", "phone-friend:default"]]);
		expect(lines()[0]).toMatchObject({ delivery: "off", status: "disabled", label: "phone-friend:default" });
	});

	it("uses the session identity when --notify is omitted", async () => {
		const calls: string[][] = [];
		const recorded = recordingDeps(calls);

		await phoneDeliverOn({}, { ...recorded, lookupIdentity: () => "claude" }, "sess");

		expect(calls[0]).toContain("claude");
		expect(lines()[0]).toMatchObject({ notify: "claude" });
	});

	it("stores the dg home directory as the job cwd, not the invoking directory", async () => {
		const calls: string[][] = [];

		await phoneDeliverOn({ notify: "reviewer" }, recordingDeps(calls));

		const cwdIndex = calls[0]?.indexOf("--cwd") ?? -1;
		expect(cwdIndex).toBeGreaterThan(-1);
		expect(calls[0]?.[cwdIndex + 1]).toBe(paths.stateDir);
		expect(calls[0]).not.toContain(process.cwd());
	});

	it("keeps the stored settings on the enabled path instead of restating the request", async () => {
		const calls: string[][] = [];
		const responses: { code: number; stdout: string; stderr: string }[] = [
			{ code: 1, stdout: "", stderr: 'a job labelled "phone-friend:default" already exists' },
			{ code: 0, stdout: "", stderr: "" },
		];
		const recorded: PhoneFriendDeps = {
			...deps(),
			runJobCli: async (args) => {
				calls.push(args);
				return responses.shift() ?? { code: 1, stdout: "", stderr: "unexpected job cli call" };
			},
		};

		await phoneDeliverOn({ notify: "reviewer", every: "5m" }, recorded);

		expect(calls).toHaveLength(2);
		expect(calls[1]).toEqual(["job", "enable", "phone-friend:default"]);
		expect(lines()[0]).toMatchObject({
			line: "default",
			delivery: "on",
			status: "enabled",
			label: "phone-friend:default",
			kept_existing_settings: true,
		});
		expect(lines()[0]).not.toHaveProperty("every");
		expect(lines()[0]).not.toHaveProperty("notify");
	});

	it("wires deliver on and off through the line and the session", async () => {
		const calls: string[][] = [];
		const program = new Command().exitOverride().option("-s, --session <id>");
		registerPhoneFriendCommands(program, (session, name) => ({
			...deps(),
			line: linePaths(paths, name),
			lookupIdentity: () => {
				if (session !== "abc") throw new Error(`session ${session}`);
				return "from-session";
			},
			runJobCli: async (args) => {
				calls.push(args);
				return { code: 0, stdout: "", stderr: "" };
			},
		}));

		await program.parseAsync([
			"node",
			"dg-agent",
			"--session",
			"abc",
			"phone-friend",
			"--line",
			"work",
			"deliver",
			"on",
		]);
		await program.parseAsync(["node", "dg-agent", "phone-friend", "deliver", "off"]);

		expect(calls[0]?.slice(0, 8)).toEqual([
			"job",
			"add",
			"--label",
			"phone-friend:work",
			"--every",
			"1m",
			"--cwd",
			paths.stateDir,
		]);
		expect(calls[0]).toContain("from-session");
		expect(calls[0]?.slice(-5)).toEqual(["dg-agent", "phone-friend", "--line", "work", "voicemail"]);
		expect(calls[1]).toEqual(["job", "disable", "phone-friend:default"]);
	});
});

describe("isListenerArgs", () => {
	it("matches the listener argv with and without --line", () => {
		expect(isListenerArgs(["/bin/dg-agent", "phone-friend", "__run"])).toBe(true);
		expect(isListenerArgs("/bin/dg-agent phone-friend --line work __run".split(" "))).toBe(true);
	});

	it("rejects an unrelated process that reuses the pid", () => {
		expect(isListenerArgs(["/usr/bin/vim", "notes.txt"])).toBe(false);
		expect(isListenerArgs(["/bin/dg-agent", "phone-friend", "number"])).toBe(false);
	});
});
