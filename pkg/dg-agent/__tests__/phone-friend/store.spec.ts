import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DgCliError } from "@dg/common";
import { resolveDgPaths } from "@dg/common/node";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { type LinePaths, linePaths } from "../../src/phone-friend/line";
import {
	acceptCall,
	claimStart,
	releaseStart,
	START_CLAIM_SECONDS,
	clearInvite,
	createFileKey,
	DEFAULT_RELAYS,
	handleFor,
	isKeyInStore,
	lineForHandle,
	markKeyInStore,
	readConfig,
	readFileKey,
	readInvite,
	resolveLine,
	withDb,
	writeConfig,
	writeInvite,
} from "../../src/phone-friend/store";

let home: string;
let paths: ReturnType<typeof resolveDgPaths>;
let line: LinePaths;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "dg-phone-friend-store-"));
	paths = resolveDgPaths({ env: { DG_HOME: home } });
	line = linePaths(paths);
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

describe("claimStart", () => {
	it("lets one command start the listener until it releases the claim", () => {
		const token = claimStart(line, 1_000) as string;
		expect(token).toBeDefined();
		expect(claimStart(line, 1_001)).toBeUndefined();
		releaseStart(line, token);
		expect(claimStart(line, 1_002)).toBeDefined();
	});

	it("takes over a claim left by a command that died, and the stale holder cannot clear it", () => {
		const stale = claimStart(line, 1_000) as string;
		const fresh = claimStart(line, 1_000 + START_CLAIM_SECONDS);
		expect(fresh).toBeDefined();
		expect(fresh).not.toBe(stale);

		releaseStart(line, stale);
		expect(claimStart(line, 1_000 + START_CLAIM_SECONDS)).toBeUndefined();
	});
});

describe("acceptCall", () => {
	it("clears the invite and saves the caller, keeping the relays", () => {
		writeInvite(line, { secret: "ab".repeat(32), expiresAt: 99 }, ["wss://x.example"]);

		acceptCall(paths, line, "npub1caller");

		expect(readInvite(line)).toBeUndefined();
		expect(readConfig(line)).toEqual({ contact: "npub1caller", relays: ["wss://x.example"] });
	});

	it("carries the invite's name over to the config when it is still free", () => {
		writeInvite(line, { secret: "ab".repeat(32), expiresAt: 99, name: "velora" }, DEFAULT_RELAYS);

		acceptCall(paths, line, "npub1caller");

		expect(readConfig(line).name).toBe("velora");
	});

	it("drops the invite's name instead of taking it from another line that claimed it since", () => {
		writeConfig(linePaths(paths, "other"), { name: "velora", relays: DEFAULT_RELAYS });
		writeInvite(line, { secret: "ab".repeat(32), expiresAt: 99, name: "velora" }, DEFAULT_RELAYS);

		acceptCall(paths, line, "npub1caller");

		expect(readConfig(line)).toEqual({ contact: "npub1caller", relays: DEFAULT_RELAYS });
	});
});

describe("resolveLine", () => {
	const npub = nip19.npubEncode(getPublicKey(generateSecretKey()));
	const paths = () => resolveDgPaths({ env: { DG_HOME: home } });

	it("finds a line by its name, its contact name, or its contact npub", () => {
		writeConfig(linePaths(paths(), "consolidation"), { contact: npub, name: "velora", relays: DEFAULT_RELAYS });

		expect(resolveLine(paths(), "consolidation").name).toBe("consolidation");
		expect(resolveLine(paths(), "velora").name).toBe("consolidation");
		expect(resolveLine(paths(), npub).name).toBe("consolidation");
	});

	it("treats an unknown name as a new line and refuses an unknown npub", () => {
		expect(resolveLine(paths(), "fresh").name).toBe("fresh");
		expect(() => resolveLine(paths(), npub)).toThrow("no line has contact");
	});

	it("refuses a contact that two lines share, and names both lines", () => {
		writeConfig(linePaths(paths(), "a"), { contact: npub, relays: DEFAULT_RELAYS });
		writeConfig(linePaths(paths(), "b"), { contact: npub, relays: DEFAULT_RELAYS });

		expect(() => resolveLine(paths(), npub)).toThrow("matches lines a, b");
	});

	it("accepts a leading @ on a line name or a contact name", () => {
		writeConfig(linePaths(paths(), "consolidation"), { contact: npub, name: "velora", relays: DEFAULT_RELAYS });

		expect(resolveLine(paths(), "@consolidation").name).toBe("consolidation");
		expect(resolveLine(paths(), "@velora").name).toBe("consolidation");
		expect(resolveLine(paths(), "@fresh").name).toBe("fresh");
	});
});

describe("lineForHandle", () => {
	const npub = nip19.npubEncode(getPublicKey(generateSecretKey()));
	const otherNpub = nip19.npubEncode(getPublicKey(generateSecretKey()));
	const paths = () => resolveDgPaths({ env: { DG_HOME: home } });

	it("picks a new line by name, with no side effect on disk", () => {
		const picked = lineForHandle(paths(), "velora", npub);

		expect(picked.name).toBe("velora");
		expect(existsSync(picked.dbPath)).toBe(false);
	});

	it("reuses the same-named line when it is already paired with this contact", () => {
		writeConfig(linePaths(paths(), "velora"), { contact: npub, relays: DEFAULT_RELAYS });

		expect(lineForHandle(paths(), "velora", npub).name).toBe("velora");
	});

	it("refuses the same-named line when it already has a different contact", () => {
		writeConfig(linePaths(paths(), "velora"), { contact: otherNpub, relays: DEFAULT_RELAYS });

		expect(() => lineForHandle(paths(), "velora", npub)).toThrow("different contact");
	});

	it("refuses a same-named line that has no contact yet, rather than guess it is the same one", () => {
		writeConfig(linePaths(paths(), "velora"), { relays: DEFAULT_RELAYS });

		expect(() => lineForHandle(paths(), "velora", npub)).toThrow("different contact");
	});

	it("refuses a handle another line already claims by its saved contact name", () => {
		writeConfig(linePaths(paths(), "work"), { contact: otherNpub, name: "velora", relays: DEFAULT_RELAYS });

		expect(() => lineForHandle(paths(), "velora", npub)).toThrow("already used by line work");
	});
});

describe("handleFor", () => {
	it("is the contact name when one is set, else the line name", () => {
		expect(handleFor({ relays: DEFAULT_RELAYS }, line)).toBe("@default");
		expect(handleFor({ name: "velora", relays: DEFAULT_RELAYS }, line)).toBe("@velora");
	});
});
