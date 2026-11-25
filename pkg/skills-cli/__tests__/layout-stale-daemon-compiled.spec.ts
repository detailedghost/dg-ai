import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureHome, legacyHomeFixture, perOsPaths, runProgram, stopFixtureSleepers } from "./layout-fixtures";

const CASE_TIMEOUT_MS = 180_000;
const RENAME_SENTENCE = "Move the folder that you do not want to a different name, then run the command again";
const STALE_CONFIG = '{"services":{"stale":{"port":1}}}';

setDefaultTimeout(CASE_TIMEOUT_MS);

const homes: string[] = [];

afterEach(() => {
	for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
	stopFixtureSleepers();
});

async function staleHome(): Promise<string> {
	const home = fixtureHome();
	homes.push(home);
	await legacyHomeFixture(home);
	const { daemonDir } = perOsPaths(home);
	mkdirSync(daemonDir, { recursive: true });
	writeFileSync(join(daemonDir, "config.json"), STALE_CONFIG);
	return home;
}

const bytesOf = (dir: string): Record<string, string> =>
	Object.fromEntries(
		readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => [entry.name, readFileSync(join(dir, entry.name)).toString("hex")]),
	);

const asideFolders = (home: string): string[] => {
	const { daemonDir } = perOsPaths(home);
	const parent = join(daemonDir, "..");
	return readdirSync(parent).filter((name) => /^daemon\.empty-\d+$/.test(name));
};

describe("a stale state daemon folder through the compiled programs", () => {
	it("moves the legacy daemon data in, sets the stale folder aside and names it on one line", async () => {
		const home = await staleHome();
		const paths = perOsPaths(home);
		const legacy = join(paths.legacyHome, "daemon");
		const legacyFiles = bytesOf(legacy);
		expect(Object.keys(legacyFiles)).toContain("daemon.db");

		const first = await runProgram(home, "dg-skills", ["spec", "slugify", "x"]);

		const asides = asideFolders(home);
		const live = bytesOf(paths.daemonDir);
		const problems: string[] = [];
		for (const [name, hex] of Object.entries(legacyFiles))
			if (name !== "daemon.pid" && live[name] !== hex) problems.push(`${name} in ${paths.daemonDir} is not the legacy file`);
		if (asides.length !== 1) problems.push(`expected one set-aside folder, found ${asides.length}`);
		const aside = join(paths.daemonDir, "..", asides[0] ?? "missing");
		if (!existsSync(join(aside, "config.json"))) problems.push("the set-aside folder holds no config.json");
		else if (readFileSync(join(aside, "config.json"), "utf8") !== STALE_CONFIG) problems.push("the stale config.json is not in the set-aside folder");
		if (live["config.json"] !== undefined && Buffer.from(live["config.json"], "hex").toString().includes("stale")) problems.push("a stale key is in the live config.json");
		const lines = first.stderr.split("\n").filter((line) => line.includes("set aside"));
		if (lines.length !== 1 || !lines[0]?.includes(aside) || !lines[0]?.includes("dg copied no file from it")) problems.push(`set-aside lines: ${JSON.stringify(lines)}`);
		expect(problems).toEqual([]);
	});

	it("plans absent and moves nothing on the second start", async () => {
		const home = await staleHome();
		const paths = perOsPaths(home);
		await runProgram(home, "dg-skills", ["spec", "slugify", "x"]);
		const before = { live: bytesOf(paths.daemonDir), asides: asideFolders(home) };

		const second = await runProgram(home, "dg-skills", ["spec", "slugify", "x"]);

		expect(bytesOf(paths.daemonDir)).toEqual(before.live);
		expect(asideFolders(home)).toEqual(before.asides);
		expect(second.stderr).not.toContain("set aside");
		expect(existsSync(join(paths.legacyHome, "daemon"))).toBe(false);
	});
});

describe("two used daemon folders through the compiled programs", () => {
	async function twoUsedHome(): Promise<{ home: string; text: string }> {
		const home = await staleHome();
		const paths = perOsPaths(home);
		writeFileSync(join(paths.daemonDir, "key"), "target-key");
		return {
			home,
			text: `dg: two daemon folders hold data: ${join(paths.legacyHome, "daemon")} and ${paths.daemonDir}. dg does not choose one and does not merge them. ${RENAME_SENTENCE}`,
		};
	}

	it("keeps both folders, prints the text, and exits 78 for serve and job remove, and 1 for clean", async () => {
		const { home, text } = await twoUsedHome();
		const paths = perOsPaths(home);
		const before = { legacy: bytesOf(join(paths.legacyHome, "daemon")), target: bytesOf(paths.daemonDir) };

		const serve = await runProgram(home, "dg-daemon", ["serve"]);
		const remove = await runProgram(home, "dg-daemon", ["job", "remove", "x"]);
		const clean = await runProgram(home, "dg-skills", ["clean"]);

		expect(serve.code).toBe(78);
		expect(serve.stderr).toContain(text);
		expect(remove.code).toBe(78);
		expect(remove.stderr).toContain(text);
		expect(clean.code).toBe(1);
		expect(clean.stderr).toContain(text);
		expect({ legacy: bytesOf(join(paths.legacyHome, "daemon")), target: bytesOf(paths.daemonDir) }).toEqual(before);
		expect(asideFolders(home)).toEqual([]);
	});

	it("moves the legacy folder in after the owner renames the state folder", async () => {
		const { home } = await twoUsedHome();
		const paths = perOsPaths(home);
		const legacyKey = readFileSync(join(paths.legacyHome, "daemon", "key"), "utf8");
		await runProgram(home, "dg-skills", ["spec", "slugify", "x"]);
		renameSync(paths.daemonDir, `${paths.daemonDir}-old`);

		await runProgram(home, "dg-skills", ["spec", "slugify", "x"]);

		expect(readFileSync(join(paths.daemonDir, "key"), "utf8")).toBe(legacyKey);
		expect(existsSync(join(paths.legacyHome, "daemon"))).toBe(false);
	});
});
