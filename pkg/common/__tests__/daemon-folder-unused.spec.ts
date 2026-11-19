import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { daemonFolderUnused } from "../src/node/sqlite-unused";
import { makeTempDir, removeTempDirs } from "./utils/temp-dirs";

afterEach(removeTempDirs);

function folderWith(files: Record<string, string>): string {
	const dir = makeTempDir("dg-daemon-unused-");
	for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
	return dir;
}

function daemonDbIn(dir: string, rows: number): void {
	const db = new Database(join(dir, "daemon.db"));
	db.run("CREATE TABLE crypto_meta (id INTEGER PRIMARY KEY, key_id TEXT)");
	for (let row = 0; row < rows; row++) db.run("INSERT INTO crypto_meta (id, key_id) VALUES (?, 'k')", [row + 1]);
	db.close();
}

describe("daemonFolderUnused", () => {
	test("is true for a missing path", () => {
		expect(daemonFolderUnused(join(makeTempDir("dg-daemon-unused-"), "missing"))).toBe(true);
	});

	test("is true for a file", () => {
		const dir = folderWith({ plain: "x" });

		expect(daemonFolderUnused(join(dir, "plain"))).toBe(true);
	});

	test("is true for a link", () => {
		const dir = folderWith({ "daemon.db": "bytes that are not sqlite" });
		const link = join(makeTempDir("dg-daemon-unused-"), "link");
		symlinkSync(dir, link);

		expect(daemonFolderUnused(link)).toBe(true);
	});

	test("is true for an empty folder", () => {
		expect(daemonFolderUnused(makeTempDir("dg-daemon-unused-"))).toBe(true);
	});

	test("is true for a folder that holds only config.json", () => {
		expect(daemonFolderUnused(folderWith({ "config.json": '{"services":{}}' }))).toBe(true);
	});

	test.each(["key", "key.dpapi", "credentials.db"])("is false for a folder that holds %s", (name) => {
		expect(daemonFolderUnused(folderWith({ [name]: "x", "config.json": "{}" }))).toBe(false);
	});

	test("is false for a folder that holds a used daemon.db", () => {
		const dir = makeTempDir("dg-daemon-unused-");
		daemonDbIn(dir, 1);

		expect(daemonFolderUnused(dir)).toBe(false);
	});

	test("is true for a folder that holds a daemon.db with no row", () => {
		const dir = makeTempDir("dg-daemon-unused-");
		daemonDbIn(dir, 0);

		expect(daemonFolderUnused(dir)).toBe(true);
	});

	test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"is false and does not throw for a folder that cannot be read",
		() => {
			const dir = makeTempDir("dg-daemon-unused-");
			const locked = join(dir, "locked");
			mkdirSync(locked);
			writeFileSync(join(locked, "config.json"), "{}");
			chmodSync(locked, 0o000);

			try {
				expect(daemonFolderUnused(locked)).toBe(false);
			} finally {
				chmodSync(locked, 0o700);
			}
		},
	);
});
