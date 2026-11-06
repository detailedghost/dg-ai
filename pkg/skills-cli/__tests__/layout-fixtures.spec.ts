import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	fixtureHome,
	legacyHomeFixture,
	perOsPaths,
	serveUntilPidFile,
	spawnEnv,
	stopFixtureSleepers,
} from "./layout-fixtures";

setDefaultTimeout(180_000);

const homes: string[] = [];

afterEach(() => {
	stopFixtureSleepers();
	for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function home(): string {
	const dir = fixtureHome();
	homes.push(dir);
	return dir;
}

function listing(root: string): string[] {
	return readdirSync(root, { recursive: true, encoding: "utf8" }).sort();
}

describe("legacyHomeFixture", () => {
	it("builds the legacy tree under the given home only and leaves the process home untouched", async () => {
		const target = home();
		const before = listing(process.env.HOME as string);
		const rows = await legacyHomeFixture(target);
		const legacy = join(target, ".dg");

		expect(listing(process.env.HOME as string)).toEqual(before);
		expect(readdirSync(target)).toEqual([".dg"]);
		for (const path of ["daemon/daemon.db", "agents/memory.db", "phone/phone.db", "config.json", "grants"])
			expect(existsSync(join(legacy, path))).toBe(true);
		expect(rows.token.length).toBeGreaterThan(0);
		expect(rows.npub.startsWith("npub1")).toBe(true);
	});

	it("leaves no pid or lock file and no role folder in the legacy tree", async () => {
		const target = home();
		await legacyHomeFixture(target);
		const names = listing(join(target, ".dg"));

		expect(names.filter((name) => /\.(pid|lock)$/.test(name))).toEqual([]);
		for (const role of ["bin", "config", "data", "state", "cache", "log"]) expect(names).not.toContain(role);
	});

	it("writes a pid file naming a live process when asked for a live daemon or listener", async () => {
		const target = home();
		await legacyHomeFixture(target, { fakeLiveDaemon: true, fakeLiveListener: true });
		const legacy = join(target, ".dg");

		for (const file of ["daemon/daemon.pid", "phone/listener.pid"]) {
			const { pid } = JSON.parse(readFileSync(join(legacy, file), "utf8")) as { pid: number };
			expect(() => process.kill(pid, 0)).not.toThrow();
		}
	});
});

describe("spawnEnv", () => {
	it("holds HOME and sets no DG_HOME or XDG variable", () => {
		const env = spawnEnv("/tmp/some-home");

		expect(env.HOME).toBe("/tmp/some-home");
		expect(env.DG_KEY_SOURCE).toBe("file");
		expect(Object.keys(env).filter((key) => key === "DG_HOME" || key.startsWith("XDG_"))).toEqual([]);
	});

	it.skipIf(process.platform !== "linux")("makes a child resolve the legacy home and the per-OS roots from HOME", () => {
		const target = home();
		const module = join(import.meta.dir, "..", "..", "common", "src", "node", "dg-paths.ts");
		const child = Bun.spawnSync(
			[process.execPath, "-e", `import { resolveDgPaths } from ${JSON.stringify(module)}; console.log(JSON.stringify(resolveDgPaths()));`],
			{ env: spawnEnv(target), cwd: target },
		);
		const paths = JSON.parse(child.stdout.toString()) as { legacyHome: string; dataDir: string; stateDir: string };

		expect(paths.legacyHome).toBe(join(target, ".dg"));
		expect(paths.dataDir).toBe(join(target, ".local", "share", "dg"));
		expect(paths.stateDir).toBe(join(target, ".local", "state", "dg"));
		expect(perOsPaths(target).stateDir).toBe(paths.stateDir);
	});
});

describe("serveUntilPidFile", () => {
	it("stops the daemon within 10 s of SIGTERM and leaves no pid file", async () => {
		const target = home();
		const started = Date.now();
		const served = await serveUntilPidFile(target);

		expect(Date.now() - started).toBeLessThan(60_000);
		expect(served.pidFileGone).toBe(true);
		expect(served.port).toBeGreaterThan(0);
	});
});

describe("the quarantined upgrade matrix file", () => {
	it("has a name bun test discovery does not match", () => {
		const file = "layout-upgrade-compiled.red.ts";

		expect(readdirSync(import.meta.dir)).toContain(file);
		expect(file).not.toMatch(/[._](test|spec)\.[cm]?[jt]sx?$/);
	});

	it("carries no red, green or slice- word in its describe and it labels", () => {
		const text = readFileSync(join(import.meta.dir, "layout-upgrade-compiled.red.ts"), "utf8");
		const labels = [...text.matchAll(/\b(?:describe|it)\(\s*[`"]([^`"]*)[`"]/g)].map((match) => match[1] as string);

		expect(labels.length).toBeGreaterThan(0);
		expect(labels.filter((label) => /\b(red|green)\b|slice-/i.test(label))).toEqual([]);
	});
});
