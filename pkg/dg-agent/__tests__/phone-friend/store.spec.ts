import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DgCliError } from "@dg/common";
import { type DgPaths, resolveDgPaths } from "@dg/common/node";
import {
	appendInbox,
	DEFAULT_RELAYS,
	loadOrCreateKey,
	readConfig,
	readSeen,
	SEEN_ID_LIMIT,
	writeConfig,
	writeSeen,
} from "../../src/phone-friend/store";

let home: string;
let paths: DgPaths;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "dg-phone-friend-"));
	paths = resolveDgPaths({ env: { DG_HOME: home } });
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

describe("loadOrCreateKey", () => {
	it("creates a 0600 key in a 0700 dir and returns the same key later", () => {
		const first = loadOrCreateKey(paths);
		const second = loadOrCreateKey(paths);

		expect(Buffer.from(second).toString("hex")).toBe(Buffer.from(first).toString("hex"));
		expect(statSync(paths.phoneFriendKeyPath).mode & 0o777).toBe(0o600);
		expect(statSync(paths.phoneFriendDir).mode & 0o777).toBe(0o700);
		expect(readFileSync(paths.phoneFriendKeyPath, "utf8").trim()).toStartWith("nsec1");
	});
});

describe("loadOrCreateKey with a corrupt key file", () => {
	it("names the file and never echoes its contents", () => {
		loadOrCreateKey(paths);
		const broken = `${readFileSync(paths.phoneFriendKeyPath, "utf8").trim()}x`;
		writeFileSync(paths.phoneFriendKeyPath, broken);

		expect(() => loadOrCreateKey(paths)).toThrow(DgCliError);
		try {
			loadOrCreateKey(paths);
		} catch (err) {
			expect(String(err)).toContain(paths.phoneFriendKeyPath);
			expect(String(err)).not.toContain(broken);
		}
	});
});

describe("config", () => {
	it("defaults to no contact and the three public relays", () => {
		expect(readConfig(paths)).toEqual({ relays: DEFAULT_RELAYS });
		expect(DEFAULT_RELAYS).toHaveLength(3);
	});

	it("round-trips a saved config", () => {
		writeConfig(paths, { contact: "npub1peer", relays: ["wss://x.example"] });

		expect(readConfig(paths)).toEqual({ contact: "npub1peer", relays: ["wss://x.example"] });
	});
});

describe("seen", () => {
	it("defaults to cursor 0 and no ids", () => {
		expect(readSeen(paths)).toEqual({ cursor: 0, ids: [] });
	});

	it("keeps only the newest ids past the limit", () => {
		const ids = Array.from({ length: SEEN_ID_LIMIT + 5 }, (_, i) => `id${i}`);

		writeSeen(paths, { cursor: 7, ids });

		const seen = readSeen(paths);
		expect(seen.cursor).toBe(7);
		expect(seen.ids).toHaveLength(SEEN_ID_LIMIT);
		expect(seen.ids[0]).toBe("id5");
	});
});

describe("appendInbox", () => {
	it("appends one JSON line per message", () => {
		appendInbox(paths, { id: "a", ts: 1, from: "npub1x", text: "one" });
		appendInbox(paths, { id: "b", ts: 2, from: "npub1x", text: "two" });

		const lines = readFileSync(paths.phoneFriendInboxPath, "utf8").trim().split("\n");
		expect(lines.map((line) => JSON.parse(line).text)).toEqual(["one", "two"]);
	});
});
