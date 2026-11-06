import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { bundleCommand } from "./bundle-build";
import {
	fixtureHome,
	legacyHomeFixture,
	type FixtureRows,
	perOsPaths,
	runProgram,
	stopFixtureSleepers,
	FIXTURE_IDENTITY,
} from "./layout-fixtures";

const CASE_TIMEOUT_MS = 180_000;
const REPO_PKG = join(import.meta.dir, "..", "..");
const REMOVED_VERB = ["__rollback", "home"].join("-");
const REMOVED_SYMBOLS = [REMOVED_VERB, ["phoneRollback", "Home"].join(""), ["rollbackPhone", "State"].join(""), ["ROLLBACK", "LINE"].join("_")];

setDefaultTimeout(CASE_TIMEOUT_MS);

const posix = describe.skipIf(process.platform === "win32");

const homes: string[] = [];
const listenerPids: number[] = [];
const LISTENER_STOP_CAP_MS = 5_000;

async function stopListener(pid: number): Promise<void> {
	for (const [signal, cap] of [["SIGTERM", LISTENER_STOP_CAP_MS], ["SIGKILL", LISTENER_STOP_CAP_MS]] as const) {
		if (!alive(pid)) return;
		try {
			process.kill(pid, signal);
		} catch {
			return;
		}
		for (let waited = 0; alive(pid) && waited < cap; waited += 50) await Bun.sleep(50);
	}
}

afterEach(async () => {
	await Promise.all(listenerPids.splice(0).map(stopListener));
	for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
	stopFixtureSleepers();
});

async function legacyHome(options: { fakeLiveListener?: boolean } = {}): Promise<{ home: string; rows: FixtureRows }> {
	const home = fixtureHome();
	homes.push(home);
	return { home, rows: await legacyHomeFixture(home, options) };
}

const pidOf = (file: string): number => (JSON.parse(readFileSync(file, "utf8")) as { pid: number }).pid;

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function stderrLines(stderr: string): string[] {
	return stderr.split("\n").filter((line) => line.trim() !== "");
}

function sourceFiles(root: string): string[] {
	return readdirSync(root, { recursive: true, encoding: "utf8" })
		.filter((name) => /\.(ts|tsx)$/.test(name) && !name.split("/").includes("node_modules"))
		.map((name) => join(root, name));
}

posix("dg-agent phone verbs and the legacy phone folder", () => {
	it("leaves phone in place with no stderr line under dg-skills spec slugify, then dg-agent phone status moves it", async () => {
		const { home } = await legacyHome();
		const paths = perOsPaths(home);

		const slug = await runProgram(home, "dg-skills", ["spec", "slugify", "x"]);

		expect(existsSync(join(paths.legacyHome, "phone", "phone.db"))).toBe(true);
		expect(stderrLines(slug.stderr).filter((line) => line.includes("phone"))).toEqual([]);

		await runProgram(home, "dg-agent", ["phone", "status"]);

		expect(existsSync(join(paths.legacyHome, "phone"))).toBe(false);
		expect(existsSync(join(paths.phoneRoot, "phone.db"))).toBe(true);
	});

	it("moves phone from a non-phone dg-agent command when no listener is live", async () => {
		const { home, rows } = await legacyHome();
		const paths = perOsPaths(home);

		await runProgram(home, "dg-agent", ["memory", "search", rows.token, "--identity", FIXTURE_IDENTITY]);

		expect(existsSync(join(paths.legacyHome, "phone"))).toBe(false);
		expect(existsSync(join(paths.phoneRoot, "phone.db"))).toBe(true);
	});

	it("keeps phone with one stderr line, moves memory, and leaves a live legacy listener running for a memory command", async () => {
		const { home, rows } = await legacyHome({ fakeLiveListener: true });
		const paths = perOsPaths(home);
		const pidFile = join(paths.legacyHome, "phone", "listener.pid");
		const pid = pidOf(pidFile);

		const search = await runProgram(home, "dg-agent", ["memory", "search", rows.token, "--identity", FIXTURE_IDENTITY]);

		expect(search.code).toBe(0);
		expect(search.stdout).toContain(rows.memoryId);
		expect(existsSync(paths.memoryDbPath)).toBe(true);
		expect(existsSync(join(paths.legacyHome, "phone", "phone.db"))).toBe(true);
		expect(existsSync(join(paths.phoneRoot, "phone.db"))).toBe(false);
		expect(stderrLines(search.stderr).filter((line) => line.includes(join(paths.legacyHome, "phone")))).toHaveLength(1);
		expect(alive(pid)).toBe(true);
	});

	it("exits 1 with the has-not-moved text and creates no phone.db for phone __run on an unmoved legacy phone", async () => {
		const { home } = await legacyHome();
		const paths = perOsPaths(home);

		const run = await runProgram(home, "dg-agent", ["phone", "__run"]);

		expect(run.code).toBe(1);
		const text = `dg: ${join(paths.legacyHome, "phone")} has not moved to ${paths.phoneRoot}; run dg-skills install`;
		expect(stderrLines(run.stderr).filter((line) => line.includes(text))).toHaveLength(1);
		expect(existsSync(join(paths.phoneRoot, "phone.db"))).toBe(false);
	});

	it("reports an unknown command for the removed rollback verb and copies nothing", async () => {
		const { home } = await legacyHome();
		const paths = perOsPaths(home);
		await runProgram(home, "dg-agent", ["phone", "status"]);
		const before = readdirSync(paths.legacyHome).sort();

		const run = await runProgram(home, "dg-agent", ["phone", REMOVED_VERB]);

		expect(run.code).not.toBe(0);
		expect(run.stderr).toContain(`unknown command '${REMOVED_VERB}'`);
		expect(readdirSync(paths.legacyHome).sort()).toEqual(before);
		expect(existsSync(join(paths.legacyHome, "phone"))).toBe(false);
	});
});

describe.skipIf(process.platform !== "linux")("legacy phone folder with a live listener through the compiled programs", () => {
	it("stops the live legacy listener, moves phone, and restarts the listener for dg-agent phone status", async () => {
		const home = fixtureHome();
		homes.push(home);
		const rows = await legacyHomeFixture(home, { fakeLiveListener: true });
		const paths = perOsPaths(home);
		const legacyPidFile = join(paths.legacyHome, "phone", "listener.pid");
		const newPidFile = join(paths.phoneRoot, "listener.pid");
		const [bun, entry] = bundleCommand("dg-agent");
		const runtimeBun = join(paths.dataDir, "runtime", "current", "bun");
		const libCurrent = join(paths.dataDir, "lib", "current");
		mkdirSync(dirname(runtimeBun), { recursive: true });
		mkdirSync(dirname(libCurrent), { recursive: true });
		symlinkSync(bun, runtimeBun);
		symlinkSync(dirname(entry), libCurrent);
		const legacyPid = (JSON.parse(readFileSync(legacyPidFile, "utf8")) as { pid: number }).pid;

		const status = await runProgram(home, "dg-agent", ["phone", "status"]);
		for (let wait = 0; wait < 100 && !existsSync(newPidFile); wait++) await Bun.sleep(100);
		if (existsSync(newPidFile)) listenerPids.push(pidOf(newPidFile));

		const problems: string[] = [];
		if (status.code !== 0) problems.push(`phone status exited ${status.code}: ${status.stderr}`);
		if (existsSync(join(paths.legacyHome, "phone"))) problems.push("legacy phone folder still present");
		if (!existsSync(join(paths.phoneRoot, "phone.db"))) problems.push("phone.db missing at the per-OS root");
		if (!existsSync(newPidFile)) problems.push(`no listener restarted: ${newPidFile} is missing`);
		else if ((JSON.parse(readFileSync(newPidFile, "utf8")) as { pid: number }).pid === legacyPid) problems.push("the restarted listener reuses the legacy pid");
		const number = await runProgram(home, "dg-agent", ["phone", "number"]);
		if (!number.stdout.includes(rows.npub)) problems.push(`phone number does not print ${rows.npub}`);
		expect(problems).toEqual([]);
	}, CASE_TIMEOUT_MS);
});

describe("removed rollback and migration symbols", () => {
	it("leaves no source or test file under pkg naming a removed symbol", () => {
		const hits = sourceFiles(REPO_PKG).flatMap((file) =>
			REMOVED_SYMBOLS.filter((symbol) => readFileSync(file, "utf8").includes(symbol)).map((symbol) => `${file}: ${symbol}`),
		);

		expect(hits).toEqual([]);
	});

	it("keeps no pending-fix test file under any pkg/*/__tests__", () => {
		const reds = readdirSync(REPO_PKG)
			.map((pkg) => join(REPO_PKG, pkg, "__tests__"))
			.filter((dir) => existsSync(dir) && statSync(dir).isDirectory())
			.flatMap((dir) => readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((name) => name.endsWith(".red.ts")));

		expect(reds).toEqual([]);
	});
});
