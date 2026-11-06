import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	FIXTURE_IDENTITY,
	type FixtureRows,
	fixtureHome,
	legacyHomeFixture,
	perOsPaths,
	phoneKeyIds,
	precreatePhoneRoot,
	runProgram,
	serveUntilPidFile,
	stopFixtureSleepers,
} from "./layout-fixtures";

const CASE_TIMEOUT_MS = 180_000;

setDefaultTimeout(CASE_TIMEOUT_MS);

type Step = { name: string; run: (home: string, rows: FixtureRows) => Promise<string> };

const slugify: Step = {
	name: "dg-skills spec slugify",
	run: async (home) => (await runProgram(home, "dg-skills", ["spec", "slugify", "x"])).stderr,
};

const agent: Step = {
	name: "dg-agent memory search then phone status",
	run: async (home, rows) => {
		const search = await runProgram(home, "dg-agent", ["memory", "search", rows.token, "--identity", FIXTURE_IDENTITY]);
		const status = await runProgram(home, "dg-agent", ["phone", "status"]);
		return search.stderr + status.stderr;
	},
};

const daemon: Step = {
	name: "dg-daemon __serve until pid file",
	run: async (home) => (await serveUntilPidFile(home)).stderr,
};

const STEPS = [slugify, agent, daemon];

function orders<T>(items: T[]): T[][] {
	if (items.length <= 1) return [items];
	return items.flatMap((item, index) => orders([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]));
}

function everyName(root: string): string[] {
	if (!existsSync(root)) return [];
	return readdirSync(root, { recursive: true, encoding: "utf8" });
}

function emptySetAsides(home: string): string[] {
	const paths = perOsPaths(home);
	const roots = [paths.legacyHome, paths.dataDir, paths.stateDir, paths.configDir, paths.cacheDir, paths.logDir];
	return [...new Set(roots)].flatMap((root) => everyName(root).filter((name) => /\.empty-/.test(name)).map((name) => join(root, name)));
}

function legacyResidue(home: string): string[] {
	const legacy = perOsPaths(home).legacyHome;
	return existsSync(legacy) ? readdirSync(legacy).filter((name) => name !== "bin" && !name.startsWith("dg-ai-") && !name.startsWith(".")) : [];
}

async function killListener(home: string): Promise<void> {
	const file = join(perOsPaths(home).phoneRoot, "listener.pid");
	if (!existsSync(file)) return;
	await runProgram(home, "dg-agent", ["phone", "close"]);
}

const homes: string[] = [];

afterEach(async () => {
	for (const home of homes.splice(0)) {
		await killListener(home);
		rmSync(home, { recursive: true, force: true });
	}
	stopFixtureSleepers();
});

async function freshHome(): Promise<{ home: string; rows: FixtureRows }> {
	const home = fixtureHome();
	homes.push(home);
	return { home, rows: await legacyHomeFixture(home) };
}

describe("legacy home upgrade through the compiled programs", () => {
	for (const order of orders(STEPS)) {
		it(`moves every legacy folder to its per-OS root when started in order ${order.map((step) => step.name).join(" -> ")}`, async () => {
			const { home, rows } = await freshHome();
			const paths = perOsPaths(home);
			const stderr: string[] = [];
			for (const step of order) stderr.push(await step.run(home, rows));

			const problems: string[] = [];
			for (const [label, file] of [
				["daemon.db", paths.dbPath],
				["memory.db", paths.memoryDbPath],
				["phone.db", join(paths.phoneRoot, "phone.db")],
			] as const)
				if (!existsSync(file)) problems.push(`missing per-OS row ${label} at ${file}`);
			const found = await runProgram(home, "dg-agent", ["memory", "search", rows.token, "--identity", FIXTURE_IDENTITY]);
			if (!found.stdout.includes(rows.memoryId)) problems.push(`memory record ${rows.memoryId} not found by search`);
			const number = await runProgram(home, "dg-agent", ["phone", "number"]);
			if (!number.stdout.includes(rows.npub)) problems.push(`phone number does not print ${rows.npub}`);
			for (const name of legacyResidue(home)) problems.push(`legacy folder still present: ${name}`);
			for (const path of emptySetAsides(home)) problems.push(`unexpected set-aside copy ${path}`);
			for (const line of stderr.join("\n").split("\n")) if (line.includes("already exists")) problems.push(`stderr line: ${line}`);
			expect(problems).toEqual([]);
		}, CASE_TIMEOUT_MS);
	}
});

describe("legacy phone folder beside a pre-created per-OS phone root", () => {
	it("sets an unused per-OS phone root aside and moves the legacy phone folder in", async () => {
		const { home, rows } = await freshHome();
		const paths = perOsPaths(home);
		precreatePhoneRoot(home, "unused");
		await runProgram(home, "dg-skills", ["spec", "slugify", "x"]);
		await runProgram(home, "dg-agent", ["phone", "status"]);

		const parent = dirname(paths.phoneRoot);
		const asides = readdirSync(parent).filter((name) => name.startsWith("phone.empty-"));
		const number = await runProgram(home, "dg-agent", ["phone", "number"]);
		const problems: string[] = [];
		if (asides.length !== 1) problems.push(`expected one phone.empty-<ts> beside ${paths.phoneRoot}, found ${asides.length}`);
		if (existsSync(join(perOsPaths(home).legacyHome, "phone"))) problems.push("legacy folder still present: phone");
		if (!number.stdout.includes(rows.npub)) problems.push(`phone number does not print ${rows.npub}`);
		expect(problems).toEqual([]);
	}, CASE_TIMEOUT_MS);

	it("keeps both phone folders when the per-OS phone root holds data and names both paths once per process", async () => {
		const { home } = await freshHome();
		const paths = perOsPaths(home);
		const legacyPhone = join(paths.legacyHome, "phone");
		precreatePhoneRoot(home, "used");
		const runs = [
			await runProgram(home, "dg-skills", ["spec", "slugify", "x"]),
			await runProgram(home, "dg-agent", ["phone", "status"]),
		];

		const problems: string[] = [];
		if (!existsSync(legacyPhone)) problems.push("legacy phone folder was removed");
		if (JSON.stringify(phoneKeyIds(join(paths.phoneRoot, "phone.db"))) !== JSON.stringify(["precreated"])) problems.push("the per-OS phone root lost its key row");
		runs.forEach((result, index) => {
			const kept = result.stderr.split("\n").filter((line) => line.includes("kept"));
			if (kept.length !== 1) problems.push(`process ${index} wrote ${kept.length} kept lines`);
			else if (!kept[0]?.includes(legacyPhone) || !kept[0]?.includes(paths.phoneRoot)) problems.push(`process ${index} kept line misses a path: ${kept[0]}`);
		});
		expect(problems).toEqual([]);
	}, CASE_TIMEOUT_MS);
});

