import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DgCliError } from "@dg/common";
import { type DgPaths, resolveDgPaths } from "@dg/common/node";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { wrap } from "../../src/phone/chat";
import {
	type PhoneDeps,
	phoneListen,
	phoneSend,
	phoneStart,
	phoneStop,
} from "../../src/phone/commands";
import { appendInbox, loadOrCreateKey, readConfig } from "../../src/phone/store";
import { createFakePool, type FakePool } from "./fake-pool";

let home: string;
let paths: DgPaths;
let out: string[];
let spawned: number;
let alive: Set<number>;
let pool: FakePool;
const peerSk = generateSecretKey();
const peerNpub = nip19.npubEncode(getPublicKey(peerSk));

function deps(overrides: Partial<PhoneDeps> = {}): PhoneDeps {
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
		...overrides,
	};
}

function lines(): unknown[] {
	return out.join("").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "dg-phone-cli-"));
	paths = resolveDgPaths({ env: { DG_HOME: home } });
	out = [];
	spawned = 0;
	alive = new Set();
	pool = createFakePool();
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

describe("phoneStart", () => {
	it("saves the peer, spawns the listener once, and prints our npub", async () => {
		await phoneStart({ peer: peerNpub }, deps());
		await phoneStart({}, deps());

		expect(spawned).toBe(1);
		expect(readConfig(paths).peer).toBe(peerNpub);
		const npub = nip19.npubEncode(getPublicKey(loadOrCreateKey(paths)));
		expect(lines()).toEqual([
			{ npub, peer: peerNpub, pid: 4242, status: "started" },
			{ npub, peer: peerNpub, pid: 4242, status: "running" },
		]);
	});

	it("respawns when the saved pid is no longer alive", async () => {
		await phoneStart({ peer: peerNpub }, deps());
		alive.clear();

		await phoneStart({}, deps());

		expect(spawned).toBe(2);
	});

	it("saves custom relays", async () => {
		await phoneStart({ peer: peerNpub, relay: ["wss://x.example"] }, deps());

		expect(readConfig(paths).relays).toEqual(["wss://x.example"]);
	});

	it("rejects a start with no peer saved or given", async () => {
		await expect(phoneStart({}, deps())).rejects.toBeInstanceOf(DgCliError);
		expect(spawned).toBe(0);
	});

	it("rejects a peer that is not an npub", async () => {
		await expect(phoneStart({ peer: "nope" }, deps())).rejects.toThrow("npub");
	});
});

describe("phoneStop", () => {
	it("kills the listener and removes the pid file", async () => {
		await phoneStart({ peer: peerNpub }, deps());

		await phoneStop(deps());

		expect(alive.has(4242)).toBe(false);
		expect(existsSync(paths.phonePidPath)).toBe(false);
	});

	it("cleans up a stale pid without error", async () => {
		await phoneStart({ peer: peerNpub }, deps());
		alive.clear();

		await phoneStop(deps());

		expect(existsSync(paths.phonePidPath)).toBe(false);
	});
});

describe("phoneListen", () => {
	it("fetches from relays when no listener runs and prints each message once", async () => {
		await phoneStart({ peer: peerNpub }, deps({ spawnListener: () => 1 }));
		const mine = getPublicKey(loadOrCreateKey(paths));
		await Promise.allSettled(pool.publish(["wss://a"], wrap("hello", peerSk, mine)));
		out = [];

		await phoneListen({}, deps());
		await phoneListen({}, deps());

		expect(lines()).toMatchObject([{ from: peerNpub, text: "hello" }]);
	});

	it("reads only the inbox when the listener runs", async () => {
		await phoneStart({ peer: peerNpub }, deps());
		appendInbox(paths, { id: "x", ts: 1, from: peerNpub, text: "from listener" });
		out = [];

		await phoneListen({}, deps());

		expect(pool.filters).toEqual([]);
		expect(lines()).toMatchObject([{ text: "from listener" }]);
	});

	it("follows the inbox until the listener stops", async () => {
		await phoneStart({ peer: peerNpub }, deps());
		out = [];
		let ticks = 0;
		const follow = deps({
			sleep: async () => {
				ticks += 1;
				if (ticks === 1) appendInbox(paths, { id: "y", ts: 2, from: peerNpub, text: "live" });
				if (ticks === 2) alive.clear();
			},
		});

		await expect(phoneListen({ follow: true }, follow)).rejects.toThrow("stopped");

		expect(lines()).toMatchObject([{ text: "live" }]);
	});

	it("refuses to follow when no listener runs", async () => {
		await expect(phoneListen({ follow: true }, deps())).rejects.toThrow("dg-agent phone start");
	});
});

describe("phoneSend", () => {
	it("publishes a wrap the peer can read and prints the accepting relays", async () => {
		await phoneStart({ peer: peerNpub }, deps());
		out = [];

		await phoneSend("ping", deps());

		const [result] = lines() as { id: string; relays_ok: string[] }[];
		expect(result.relays_ok).toEqual(readConfig(paths).relays);
		expect(pool.events[0]?.id).toBe(result.id);
	});

	it("fails when no relay accepts the message", async () => {
		await phoneStart({ peer: peerNpub }, deps());
		pool = createFakePool([]);

		await expect(phoneSend("ping", deps())).rejects.toThrow("no relay");
	});

	it("fails when no peer is saved", async () => {
		await expect(phoneSend("ping", deps())).rejects.toBeInstanceOf(DgCliError);
	});
});
