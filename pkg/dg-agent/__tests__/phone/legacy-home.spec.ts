import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDgPaths } from "@dg/common/node";
import { Command } from "commander";
import { PhoneDb } from "../../src/phone/db";
import { createFileKey } from "../../src/phone/keys";
import { registerLazyPhoneCommands } from "../../src/phone/register";

let dir: string;
let savedHome: string | undefined;
let stdout: ReturnType<typeof spyOn>;
let written: string[];

function legacyRoot(): string {
	return join(dir, "phone");
}

function newRoot(): string {
	return resolveDgPaths({ platform: process.platform, homeDir: "/home/u", env: { DG_HOME: dir } }).phoneRoot;
}

function seed(root: string, withContact: boolean): void {
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const db = PhoneDb.openAt(join(root, "phone.db"), root);
	if (withContact) {
		createFileKey(db, "number");
		db.insertContact({ npub: "npub1x", handle: "+dg", relays: "[]", key_id: "number", added_at: 1, via: "card" });
	}
	db.close();
}

function contactsAt(root: string): string[] {
	const db = PhoneDb.openAt(join(root, "phone.db"), root);
	try {
		return db.listContacts().map((row) => row.handle);
	} finally {
		db.close();
	}
}

async function run(...argv: string[]): Promise<void> {
	const program = new Command().exitOverride();
	registerLazyPhoneCommands(program);
	await program.parseAsync(["phone", ...argv], { from: "user" });
}

beforeEach(() => {
	dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "dg-phone-legacy-"));
	savedHome = process.env.DG_HOME;
	process.env.DG_HOME = dir;
	written = [];
	stdout = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
		written.push(String(chunk));
		return true;
	});
});

afterEach(() => {
	stdout.mockRestore();
	if (savedHome === undefined) delete process.env.DG_HOME;
	else process.env.DG_HOME = savedHome;
	rmSync(dir, { recursive: true, force: true });
});

describe("legacy phone home through the command wiring", () => {
	it("moves the legacy data when a command runs before __refresh", async () => {
		seed(legacyRoot(), true);

		await run("contacts");

		expect(existsSync(legacyRoot())).toBe(false);
		expect(contactsAt(newRoot())).toEqual(["+dg"]);
		expect(written.join("")).toContain("+dg");
	});

	it("moves the legacy data when __refresh runs first", async () => {
		seed(legacyRoot(), true);

		await run("__refresh");

		expect(existsSync(legacyRoot())).toBe(false);
		expect(contactsAt(newRoot())).toEqual(["+dg"]);
	});

	it("sets an unused new root aside and moves the legacy data", async () => {
		seed(legacyRoot(), true);
		seed(newRoot(), false);

		await run("contacts");

		expect(existsSync(legacyRoot())).toBe(false);
		expect(contactsAt(newRoot())).toEqual(["+dg"]);
		const aside = readdirSync(join(newRoot(), "..")).filter((name) => name.startsWith("phone.empty-"));
		expect(aside).toHaveLength(1);
		expect(existsSync(join(newRoot(), "..", aside[0] ?? "", "phone.db"))).toBe(true);
	});

	it("never touches a new root that holds data", async () => {
		seed(legacyRoot(), true);
		seed(newRoot(), true);
		const db = PhoneDb.openAt(join(newRoot(), "phone.db"), newRoot());
		db.putContact({ npub: "npub1y", handle: "+other", relays: "[]", key_id: "number", added_at: 2, via: "card" });
		db.close();

		await run("contacts");

		expect(existsSync(join(legacyRoot(), "phone.db"))).toBe(true);
		expect(contactsAt(newRoot())).toEqual(["+dg", "+other"]);
		expect(readdirSync(join(newRoot(), "..")).filter((name) => name.startsWith("phone.empty-"))).toEqual([]);
	});

	it("never touches a new root that has other files, even with an empty database", async () => {
		seed(legacyRoot(), true);
		seed(newRoot(), false);
		writeFileSync(join(newRoot(), "listener.pid"), "{}");

		await run("contacts");

		expect(existsSync(join(legacyRoot(), "phone.db"))).toBe(true);
		expect(readdirSync(join(newRoot(), "..")).filter((name) => name.startsWith("phone.empty-"))).toEqual([]);
	});
});
