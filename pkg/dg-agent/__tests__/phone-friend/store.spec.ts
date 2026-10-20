import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DgCliError } from "@dg/common";
import { resolveDgPaths } from "@dg/common/node";
import { generateSecretKey, nip19 } from "nostr-tools";
import { type LinePaths, linePaths } from "../../src/phone-friend/line";
import {
	acceptCall,
	clearInvite,
	createFileKey,
	DEFAULT_RELAYS,
	isKeyInStore,
	markKeyInStore,
	readConfig,
	readFileKey,
	readInvite,
	withDb,
	writeConfig,
	writeInvite,
} from "../../src/phone-friend/store";

let home: string;
let line: LinePaths;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "dg-phone-friend-store-"));
	line = linePaths(resolveDgPaths({ env: { DG_HOME: home } }));
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

describe("file-mode key", () => {
	it("is made once and read back the same", () => {
		const first = createFileKey(line);

		expect(first).toBeDefined();
		expect(Buffer.from(createFileKey(line) ?? []).equals(Buffer.from(first ?? []))).toBe(true);
		expect(Buffer.from(readFileKey(line) ?? []).equals(Buffer.from(first ?? []))).toBe(true);
	});

	it("is not made once the key lives in the store", () => {
		markKeyInStore(line, generateSecretKey());

		expect(createFileKey(line)).toBeUndefined();
		expect(readFileKey(line)).toBeUndefined();
	});

	it("names the db and never echoes a corrupt value", () => {
		withDb(line, (db) => db.set("nsec", "nsec1brokenbutsecret"));

		expect(() => readFileKey(line)).toThrow(DgCliError);
		expect(() => readFileKey(line)).toThrow(line.dbPath);
		expect(() => readFileKey(line)).not.toThrow("nsec1brokenbutsecret");
	});
});

describe("markKeyInStore", () => {
	it("drops the matching file key and records store mode", () => {
		const sk = createFileKey(line) as Uint8Array;

		expect(markKeyInStore(line, sk)).toBe(true);

		expect(isKeyInStore(line)).toBe(true);
		expect(readFileKey(line)).toBeUndefined();
	});

	it("refuses when a different file key exists, so a racing file key is never lost", () => {
		const fileKey = createFileKey(line) as Uint8Array;

		expect(markKeyInStore(line, generateSecretKey())).toBe(false);

		expect(isKeyInStore(line)).toBe(false);
		expect(nip19.nsecEncode(readFileKey(line) as Uint8Array)).toBe(nip19.nsecEncode(fileKey));
	});
});

describe("config", () => {
	it("defaults to no contact and the three public relays", () => {
		expect(readConfig(line)).toEqual({ relays: DEFAULT_RELAYS });
		expect(DEFAULT_RELAYS).toHaveLength(3);
	});

	it("round-trips a saved config", () => {
		writeConfig(line, { contact: "npub1contact", relays: ["wss://x.example"] });

		expect(readConfig(line)).toEqual({ contact: "npub1contact", relays: ["wss://x.example"] });
	});
});

describe("invite", () => {
	it("round-trips and clears", () => {
		writeInvite(line, { secret: "ab".repeat(32), expiresAt: 99 }, DEFAULT_RELAYS);

		expect(readInvite(line)).toEqual({ secret: "ab".repeat(32), expiresAt: 99 });
		clearInvite(line);
		expect(readInvite(line)).toBeUndefined();
	});

	it("saves the card relays with the invite and keeps the contact", () => {
		writeConfig(line, { contact: "npub1contact", relays: DEFAULT_RELAYS });
		writeInvite(line, { secret: "ab".repeat(32), expiresAt: 99 }, ["wss://x.example"]);

		expect(readConfig(line)).toEqual({ contact: "npub1contact", relays: ["wss://x.example"] });
	});
});

describe("acceptCall", () => {
	it("clears the invite and saves the caller, keeping the relays", () => {
		writeInvite(line, { secret: "ab".repeat(32), expiresAt: 99 }, ["wss://x.example"]);

		acceptCall(line, "npub1caller");

		expect(readInvite(line)).toBeUndefined();
		expect(readConfig(line)).toEqual({ contact: "npub1caller", relays: ["wss://x.example"] });
	});
});
