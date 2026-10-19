import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DgCliError } from "@dg/common";
import { type DgPaths, resolveDgPaths } from "@dg/common/node";
import {
	DEFAULT_RELAYS,
	loadOrCreateKey,
	readConfig,
	writeConfig,
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
