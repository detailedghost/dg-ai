import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DgCliError } from "@dg/common";
import { type DgPaths, resolveDgPaths } from "@dg/common/node";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { fetchNew, wrap } from "../../src/phone-friend/chat";
import {
	type PhoneFriendDeps,
	phoneAnswer,
	phoneNumber,
	phoneSay,
	phoneVoicemail,
	phoneOn,
	phoneOff,
} from "../../src/phone-friend/commands";
import { appendInbox, loadOrCreateKey, readConfig } from "../../src/phone-friend/store";
import { createFakePool, type FakePool } from "./fake-pool";

let home: string;
let paths: DgPaths;
let out: string[];
let spawned: number;
let alive: Set<number>;
let pool: FakePool;
const contactSk = generateSecretKey();
const contactNpub = nip19.npubEncode(getPublicKey(contactSk));

function deps(overrides: Partial<PhoneFriendDeps> = {}): PhoneFriendDeps {
	return {
		paths,
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
		write: (line) => {
			out.push(line);
		},
		sleep: async () => {},
		readStdin: async () => "from stdin\n",
		...overrides,
	};
}

function lines(): unknown[] {
	return out.join("").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "dg-phone-friend-cli-"));
	paths = resolveDgPaths({ env: { DG_HOME: home } });
	out = [];
	spawned = 0;
	alive = new Set();
	pool = createFakePool();
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

describe("phoneOn", () => {
	it("saves the contact, spawns the listener once, and prints our npub", async () => {
		await phoneOn({ contact: contactNpub }, deps());
		await phoneOn({}, deps());

		expect(spawned).toBe(1);
		expect(readConfig(paths).contact).toBe(contactNpub);
		const npub = nip19.npubEncode(getPublicKey(loadOrCreateKey(paths)));
		expect(lines()).toEqual([
			{ npub, contact: contactNpub, pid: 4242, status: "started" },
			{ npub, contact: contactNpub, pid: 4242, status: "running" },
		]);
	});

	it("respawns when the saved pid is no longer alive", async () => {
		await phoneOn({ contact: contactNpub }, deps());
		alive.clear();

		await phoneOn({}, deps());

		expect(spawned).toBe(2);
	});

	it("restarts a running listener when the contact changes", async () => {
		await phoneOn({ contact: contactNpub }, deps());
		const other = nip19.npubEncode(getPublicKey(generateSecretKey()));
		let killed = 0;

		await phoneOn({ contact: other }, deps({ kill: (pid) => {
			killed += 1;
			alive.delete(pid);
		} }));

		expect(killed).toBe(1);
		expect(spawned).toBe(2);
		expect(readConfig(paths).contact).toBe(other);
		expect(lines().at(-1)).toMatchObject({ contact: other, status: "restarted" });
	});

	it("fails and keeps the old contact when the running listener does not stop", async () => {
		await phoneOn({ contact: contactNpub }, deps());
		const other = nip19.npubEncode(getPublicKey(generateSecretKey()));

		await expect(phoneOn({ contact: other }, deps({ kill: () => {} }))).rejects.toThrow("did not stop");

		expect(readConfig(paths).contact).toBe(contactNpub);
		expect(spawned).toBe(1);
	});

	it("saves custom relays", async () => {
		await phoneOn({ contact: contactNpub, relay: ["wss://x.example"] }, deps());

		expect(readConfig(paths).relays).toEqual(["wss://x.example"]);
	});

	it("rejects a start with no contact and names our npub so it can be shared", async () => {
		const failure = phoneOn({}, deps());

		await expect(failure).rejects.toBeInstanceOf(DgCliError);
		const npub = nip19.npubEncode(getPublicKey(loadOrCreateKey(paths)));
		await expect(failure).rejects.toThrow(npub);
		expect(spawned).toBe(0);
	});

	it("rejects a contact that is not an npub", async () => {
		await expect(phoneOn({ contact: "nope" }, deps())).rejects.toThrow("npub");
	});
});

describe("phoneNumber", () => {
	it("prints our npub, the contact, the key store, and the listener pid", async () => {
		await phoneNumber(deps());
		await phoneOn({ contact: contactNpub }, deps());
		out = [];

		await phoneNumber(deps());

		const npub = nip19.npubEncode(getPublicKey(loadOrCreateKey(paths)));
		expect(lines()).toEqual([{ npub, contact: contactNpub, key_store: "file", listener: 4242 }]);
	});

	it("reports no contact and no listener before pairing", async () => {
		await phoneNumber(deps());

		expect(lines()).toMatchObject([{ contact: null, listener: null }]);
	});
});

describe("phoneOff", () => {
	it("kills the listener and removes the pid file", async () => {
		await phoneOn({ contact: contactNpub }, deps());

		await phoneOff(deps());

		expect(alive.has(4242)).toBe(false);
		expect(existsSync(paths.phoneFriendPidPath)).toBe(false);
	});

	it("cleans up a stale pid without error", async () => {
		await phoneOn({ contact: contactNpub }, deps());
		alive.clear();

		await phoneOff(deps());

		expect(existsSync(paths.phoneFriendPidPath)).toBe(false);
	});
});

describe("phoneVoicemail and phoneAnswer", () => {
	it("fetches from relays when no listener runs and prints each message once", async () => {
		await phoneOn({ contact: contactNpub }, deps({ spawnListener: () => 1 }));
		const mine = getPublicKey(loadOrCreateKey(paths));
		await Promise.allSettled(pool.publish(["wss://a"], wrap("hello", contactSk, mine)));
		out = [];

		await phoneVoicemail(deps());
		await phoneVoicemail(deps());

		expect(lines()).toMatchObject([{ from: contactNpub, text: "hello" }]);
	});

	it("reads only the inbox when the listener runs", async () => {
		await phoneOn({ contact: contactNpub }, deps());
		appendInbox(paths, { id: "x", ts: 1, from: contactNpub, text: "from listener" });
		out = [];

		await phoneVoicemail(deps());

		expect(pool.filters).toEqual([]);
		expect(lines()).toMatchObject([{ text: "from listener" }]);
	});

	it("follows the inbox until the listener stops", async () => {
		await phoneOn({ contact: contactNpub }, deps());
		out = [];
		let ticks = 0;
		const follow = deps({
			sleep: async () => {
				ticks += 1;
				if (ticks === 1) appendInbox(paths, { id: "y", ts: 2, from: contactNpub, text: "live" });
				if (ticks === 2) alive.clear();
			},
		});

		await expect(phoneAnswer(follow)).rejects.toThrow("stopped");

		expect(lines()).toMatchObject([{ text: "live" }]);
	});

	it("refuses to follow when no listener runs", async () => {
		await expect(phoneAnswer(deps())).rejects.toThrow("dg-agent phone-friend on");
	});
});

describe("phoneSay", () => {
	it("publishes a wrap the contact can read and prints the accepting relays", async () => {
		await phoneOn({ contact: contactNpub }, deps());
		out = [];

		await phoneSay("ping", deps());

		const [result] = lines() as { id: string; relays_ok: string[] }[];
		expect(result.relays_ok).toEqual(readConfig(paths).relays);
		expect(pool.events[0]?.id).toBe(result.id);
	});

	it("reads the text from stdin when the argument is -", async () => {
		await phoneOn({ contact: contactNpub }, deps());
		const mine = getPublicKey(loadOrCreateKey(paths));
		const reader = createFakePool();

		await phoneSay("-", deps());
		reader.events.push(...pool.events);
		const { messages } = await fetchNew(reader, ["wss://a"], contactSk, mine, { cursor: 0, ids: [] });

		expect(messages.map((m) => m.text)).toEqual(["from stdin"]);
	});

	it("rejects empty stdin", async () => {
		await phoneOn({ contact: contactNpub }, deps());

		await expect(phoneSay("-", deps({ readStdin: async () => "" }))).rejects.toThrow("empty");
	});

	it("fails when no relay accepts the message", async () => {
		await phoneOn({ contact: contactNpub }, deps());
		pool = createFakePool([]);

		await expect(phoneSay("ping", deps())).rejects.toThrow("no relay");
	});

	it("fails when no contact is saved", async () => {
		await expect(phoneSay("ping", deps())).rejects.toBeInstanceOf(DgCliError);
	});
});
