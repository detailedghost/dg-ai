import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompanionMissing, companionDir, loadCompanion } from "../src/node/companion";

const roots: string[] = [];

function dataDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "dg-companion-"));
	roots.push(dir);
	return dir;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("loadCompanion", () => {
	test("imports playwright-core directly when the build does not externalize companions", async () => {
		const pw = await loadCompanion("pw", { external: false });
		expect(typeof pw.chromium.launch).toBe("function");
	});

	test("imports pg and snowflake-sdk directly when the build does not externalize companions", async () => {
		const db = await loadCompanion("db", { external: false });
		expect(typeof db.pg.Client).toBe("function");
		expect(typeof db.snowflake.createConnection).toBe("function");
	});

	test("throws CompanionMissing when the companion is not installed", async () => {
		const error = await loadCompanion("pw", { external: true, version: "9.9.9", paths: { dataDir: dataDir() } }).catch(
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(CompanionMissing);
		const { message, name } = error as CompanionMissing;
		expect(name).toBe("CompanionMissing");
		expect(message).toContain("pw");
		expect(message).toContain("9.9.9");
	});

	test("imports the installed companion entry from the data dir", async () => {
		const paths = { dataDir: dataDir() };
		const dir = companionDir(paths, "db", "9.9.9");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "index.js"), "export const marker = 'from-disk';\n");
		const loaded = (await loadCompanion("db", { external: true, version: "9.9.9", paths })) as unknown as { marker: string };
		expect(loaded.marker).toBe("from-disk");
	});

	test("does not accept a companion installed for another version", async () => {
		const paths = { dataDir: dataDir() };
		const dir = companionDir(paths, "pw", "1.0.0");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "index.js"), "export const marker = 'old';\n");
		await expect(loadCompanion("pw", { external: true, version: "2.0.0", paths })).rejects.toBeInstanceOf(CompanionMissing);
	});
});
