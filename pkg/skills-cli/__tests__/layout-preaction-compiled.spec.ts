import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDgPaths } from "@dg/common/node/dg-paths";
import { ensureLayout } from "@dg/common/node/layout";
import {
	FIXTURE_IDENTITY,
	fixtureHome,
	legacyHomeFixture,
	perOsPaths,
	runProgram,
	serveUntilPidFile,
	stopFixtureSleepers,
} from "./layout-fixtures";

const CASE_TIMEOUT_MS = 180_000;
const SKILLS_SRC = join(import.meta.dir, "..", "src");

setDefaultTimeout(CASE_TIMEOUT_MS);

const posix = describe.skipIf(process.platform === "win32");

const loadHooksFor = async () => (await import("../src/main")).hooksFor;

const homes: string[] = [];

afterEach(() => {
	for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
	stopFixtureSleepers();
});

async function legacyHome(options: { fakeLiveDaemon?: boolean } = {}) {
	const home = fixtureHome();
	homes.push(home);
	const rows = await legacyHomeFixture(home, options);
	return { home, rows, paths: perOsPaths(home), legacy: join(home, ".dg") };
}

function treeOf(root: string): string[] {
	if (!existsSync(root)) return [];
	return readdirSync(root, { recursive: true, encoding: "utf8" })
		.sort()
		.map((name) => {
			const file = join(root, name);
			const stat = lstatSync(file);
			if (!stat.isFile()) return `${name}/`;
			return `${name}:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
		});
}

function rootsExist(paths: ReturnType<typeof perOsPaths>): string[] {
	return [paths.dataDir, paths.stateDir, paths.configDir, paths.cacheDir].filter((root) => existsSync(root));
}

function lines(stderr: string): string[] {
	return stderr.split("\n").filter((line) => line.trim() !== "");
}

posix("commands that skip the layout move", () => {
	it.each([
		["dg-skills hooks run", "dg-skills", ["hooks", "run", "nothing"]],
		["dg-skills --help", "dg-skills", ["--help"]],
		["dg-skills --version", "dg-skills", ["--version"]],
		["dg-daemon status", "dg-daemon", ["status"]],
	] as const)("%s leaves the legacy tree byte-identical and creates no per-OS root", async (_label, program, args) => {
		const { home, paths, legacy } = await legacyHome();
		const before = treeOf(legacy);

		await runProgram(home, program, [...args]);

		expect(treeOf(legacy)).toEqual(before);
		expect(rootsExist(paths)).toEqual([]);
	});

	it("dg-daemon status exits 1 with the has-not-moved text for daemon", async () => {
		const { home, paths, legacy } = await legacyHome();

		const status = await runProgram(home, "dg-daemon", ["status"]);

		expect(status.code).toBe(1);
		expect(status.stderr).toContain(`dg: ${join(legacy, "daemon")} has not moved to ${paths.daemonDir}; run dg-skills install`);
		expect(existsSync(paths.dbPath)).toBe(false);
	});

	it("dg-skills hooks run opens no guarded store", () => {
		const sources = readdirSync(SKILLS_SRC, { recursive: true, encoding: "utf8" })
			.filter((name) => name.endsWith(".ts"))
			.map((name) => readFileSync(join(SKILLS_SRC, name), "utf8"));

		expect(sources.length).toBeGreaterThan(0);
		for (const source of sources) expect(source).not.toMatch(/\b(?:ChatStore|MemoryStore|PhoneDb)\.open\(/);
	});
});

posix("commands that run the layout move", () => {
	it("dg-skills spec slugify leaves runtime and lib where the legacy launchers read them, without a line", async () => {
		const { home, paths, legacy } = await legacyHome();
		for (const name of ["runtime", "lib"]) {
			mkdirSync(join(legacy, name, "1.0.0"), { recursive: true });
			writeFileSync(join(legacy, name, "1.0.0", "file"), name);
		}

		const run = await runProgram(home, "dg-skills", ["spec", "slugify", "x"]);

		expect(run.code).toBe(0);
		expect(existsSync(join(legacy, "runtime", "1.0.0", "file"))).toBe(true);
		expect(existsSync(join(legacy, "lib", "1.0.0", "file"))).toBe(true);
		expect(existsSync(paths.runtimeDir)).toBe(false);
		expect(existsSync(paths.libDir)).toBe(false);
		expect(lines(run.stderr)).toEqual([]);
	});

	it("dg-skills spec slugify moves daemon, memory, grants and config and leaves phone and ssms silent", async () => {
		const { home, paths, legacy } = await legacyHome();
		mkdirSync(join(legacy, "ssms"), { recursive: true });
		writeFileSync(join(legacy, "ssms", "config.yaml"), "allow_send: true\n");

		const run = await runProgram(home, "dg-skills", ["spec", "slugify", "x"]);

		expect(existsSync(paths.dbPath)).toBe(true);
		expect(existsSync(paths.memoryDbPath)).toBe(true);
		expect(existsSync(join(paths.grantsDir, "fixture.json"))).toBe(true);
		expect(existsSync(paths.configPath)).toBe(true);
		expect(existsSync(join(legacy, "daemon"))).toBe(false);
		expect(existsSync(join(legacy, "phone", "phone.db"))).toBe(true);
		expect(existsSync(join(legacy, "ssms", "config.yaml"))).toBe(true);
		expect(run.stderr).not.toContain(join(legacy, "phone"));
		expect(run.stderr).not.toContain(join(legacy, "ssms"));
	});

	it("dg-daemon serve moves daemon before daemon.db opens and keeps the fixture crypto_meta row", async () => {
		const { home, paths, legacy } = await legacyHome();
		const legacyDb = new Database(join(legacy, "daemon", "daemon.db"), { readonly: true });
		const legacyKey = (legacyDb.query("SELECT key_id FROM crypto_meta WHERE id = 1").get() as { key_id: string }).key_id;
		legacyDb.close();

		const served = await serveUntilPidFile(home);

		expect(served.pidFileGone).toBe(true);
		const db = new Database(paths.dbPath, { readonly: true });
		const rows = db.query("SELECT key_id FROM crypto_meta").all() as { key_id: string }[];
		db.close();
		expect(rows).toEqual([{ key_id: legacyKey }]);
		expect(readdirSync(paths.stateDir).filter((name) => name.startsWith("daemon.empty-"))).toEqual([]);
		expect(existsSync(join(legacy, "daemon"))).toBe(false);
	});
});

posix("a live legacy daemon", () => {
	it("dg-daemon job list reports the kept text for daemon through the memoized paths, not the has-not-moved text", async () => {
		const { home, paths, legacy } = await legacyHome({ fakeLiveDaemon: true });

		const jobs = await runProgram(home, "dg-daemon", ["job", "list"]);

		expect(jobs.code).not.toBe(0);
		expect(jobs.stderr).toContain(`dg: kept ${join(legacy, "daemon")}; a process that writes it is running. Stop it, then run dg-skills install again`);
		expect(jobs.stderr).not.toContain("has not moved");
		expect(existsSync(paths.dbPath)).toBe(false);
	});

	it("dg-agent memory search moves memory and blocks daemon with one stderr line, then dg-daemon serve moves daemon and stops nothing", async () => {
		const { home, rows, paths, legacy } = await legacyHome({ fakeLiveDaemon: true });
		const sleeper = (JSON.parse(readFileSync(join(legacy, "daemon", "daemon.pid"), "utf8")) as { pid: number }).pid;

		const search = await runProgram(home, "dg-agent", ["memory", "search", rows.token, "--identity", FIXTURE_IDENTITY]);

		expect(existsSync(paths.memoryDbPath)).toBe(true);
		expect(existsSync(join(legacy, "daemon", "daemon.db"))).toBe(true);
		expect(lines(search.stderr)).toHaveLength(1);
		expect(search.stderr).toContain(`dg: kept ${join(legacy, "daemon")}; a process that writes it is running`);

		const served = await serveUntilPidFile(home);

		expect(served.pidFileGone).toBe(true);
		expect(existsSync(paths.dbPath)).toBe(true);
		expect(existsSync(join(legacy, "daemon"))).toBe(false);
		expect(() => process.kill(sleeper, 0)).not.toThrow();
	});
});

describe("dg-skills hooksFor", () => {
	it("install composes daemon.stop and ssms.configDir, and spec composes neither", async () => {
		const hooksFor = await loadHooksFor();
		const install = hooksFor("install");
		await install.load?.();
		const spec = hooksFor("spec");
		await spec.load?.();

		expect(typeof install["daemon.stop"]).toBe("function");
		expect(typeof install["ssms.configDir"]).toBe("function");
		expect(install["ssms.configDir"]?.()).toBeString();
		expect(spec["daemon.stop"]).toBeUndefined();
		expect(spec["ssms.configDir"]).toBeUndefined();
		expect(install.launchers).toBe(true);
		expect(spec.launchers).toBeUndefined();
	});

	it("install composes no phone-friend hook", async () => {
		const hooksFor = await loadHooksFor();
		const install = hooksFor("install");
		await install.load?.();

		expect(Object.keys(install).filter((key) => key.includes("phone-friend"))).toEqual([]);
	});

	it("install passes the injected platform through to daemon.stop", async () => {
		const hooksFor = await loadHooksFor();
		const hooks = hooksFor("install", { platform: "win32" });
		await hooks.load?.();
		const dir = mkdtempSync(join(tmpdir(), "dg-hooks-for-"));
		homes.push(dir);

		expect(await hooks["daemon.stop"]?.(dir)).toBe("refused");
	});

	it("install on a clean home never loads the owner hooks", async () => {
		const home = mkdtempSync(join(tmpdir(), "dg-hooks-clean-"));
		homes.push(home);
		const paths = resolveDgPaths({ platform: process.platform, homeDir: home, env: {} });
		const hooksFor = await loadHooksFor();
		const hooks = hooksFor("install");
		const load = hooks.load;
		let loads = 0;
		hooks.load = () => {
			loads += 1;
			return (load as NonNullable<typeof load>)();
		};

		await ensureLayout(paths, hooks);

		expect(load).toBeFunction();
		expect(loads).toBe(0);
	});

	it("install moves ssms/config.yaml into the folder the ssms.configDir hook names and ssms/ to the state root", async () => {
		const home = mkdtempSync(join(tmpdir(), "dg-hooks-ssms-"));
		homes.push(home);
		const paths = resolveDgPaths({ platform: process.platform, homeDir: home, env: {} });
		const legacy = join(paths.legacyHome, "ssms");
		mkdirSync(legacy, { recursive: true });
		writeFileSync(join(legacy, "config.yaml"), "allow_send: true\n");
		writeFileSync(join(legacy, "log.txt"), "line\n");
		const trusted = join(home, "trusted");
		const hooksFor = await loadHooksFor();
		const hooks = hooksFor("install");
		const load = hooks.load as NonNullable<typeof hooks.load>;
		hooks.load = async () => {
			await load();
			hooks["ssms.configDir"] = () => trusted;
		};
		hooks.log = () => {};

		await ensureLayout(paths, hooks);

		expect(readFileSync(join(trusted, "ssms", "config.yaml"), "utf8")).toBe("allow_send: true\n");
		expect(existsSync(join(paths.stateDir, "ssms", "log.txt"))).toBe(true);
		expect(existsSync(join(legacy, "config.yaml"))).toBe(false);
	});

	it("the compiled dg-skills package resolves @dg/dg-daemon/layout-hooks", () => {
		expect(() => Bun.resolveSync("@dg/dg-daemon/layout-hooks", SKILLS_SRC)).not.toThrow();
	});
});
