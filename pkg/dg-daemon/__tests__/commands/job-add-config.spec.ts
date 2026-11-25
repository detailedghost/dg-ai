import { afterEach, describe, expect, it } from "bun:test";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { resolveDgPaths, writePidFileAtomic } from "@dg/common/node";
import { CHAT_PROTOCOL_VERSION } from "@dg/common";
import {
	allocatePort,
	cleanupDgHome,
	freshDgHome,
	freshTempDir,
} from "../utils/daemon-harness";
import { configPathOf, writeConfigFile } from "../utils/service-daemon";
import { lines, readConfigFile, runCli } from "./service-cli-helpers";

type StoredConfig = {
	pinnedOrigin?: string;
	jobs: Record<
		string,
		{
			argv: string[];
			cwd?: string;
			envFile?: string;
			stopTimeoutMs?: number;
			continuous?: boolean;
		}
	>;
};
const storedConfig = (dgHome: string) => readConfigFile(dgHome) as StoredConfig;

const homes: string[] = [];
afterEach(() => {
	for (const home of homes.splice(0)) cleanupDgHome(home);
});

const SEED = JSON.stringify({ jobsVersion: 2 });

function setup() {
	const dgHome = freshDgHome();
	homes.push(dgHome);
	writeConfigFile(dgHome, SEED);
	return { dgHome, cwd: freshTempDir("job-cwd") };
}

const BUN = Bun.which("bun") ?? "";
if (BUN === "") throw new Error("bun is not on PATH");
const add = (
	dgHome: string,
	name: string,
	flags: string[],
	command = ["bun", "run", "bot.ts"],
	opts: { cwd?: string } = {},
) =>
	runCli(
		dgHome,
		["job", "add", "--name", name, "--continuous", ...flags, "--", ...command],
		opts,
	);

describe("job add --continuous config writes", () => {
	it("keeps every entry when several job add runs write at once", async () => {
		const { dgHome, cwd } = setup();
		const names = Array.from({ length: 8 }, (_, i) => `bot${i}`);
		const [first, ...rest] = names;
		const results = [
			await add(dgHome, first, ["--cwd", cwd]),
			...(await Promise.all(rest.map((name) => add(dgHome, name, ["--cwd", cwd])))),
		];
		expect(results.map((result) => result.code)).toEqual(names.map(() => 0));
		expect(Object.keys(storedConfig(dgHome).jobs).sort()).toEqual(names);
	}, 30_000);

	it("stores an absolute argv[0] and prints the next line", async () => {
		const { dgHome, cwd } = setup();
		const result = await add(dgHome, "bot", ["--cwd", cwd]);
		expect(result.code).toBe(0);
		expect(lines(result.stdout)).toEqual([
			'added job "bot"',
			"next: dg job enable bot",
		]);
		expect(storedConfig(dgHome).jobs.bot).toEqual({
			argv: [BUN, "run", "bot.ts"],
			cwd,
			continuous: true,
		});
	});

	it("resolves a relative --cwd and --env-file from the caller's directory", async () => {
		const { dgHome, cwd } = setup();
		mkdirSync(join(cwd, "app"));
		writeFileSync(join(cwd, "env.txt"), "");
		const result = await add(
			dgHome,
			"bot",
			["--cwd", "app", "--env-file", "env.txt"],
			["bun", "x.ts"],
			{ cwd },
		);
		expect(result.code).toBe(0);
		const entry = storedConfig(dgHome).jobs.bot;
		expect(entry.cwd).toBe(resolve(cwd, "app"));
		expect(entry.envFile).toBe(resolve(cwd, "env.txt"));
	});

	it("stores the absolute path of ./run.sh and keeps a symbolic link as a link", async () => {
		const { dgHome, cwd } = setup();
		const real = join(cwd, "real.sh");
		writeFileSync(real, "#!/bin/sh\n");
		chmodSync(real, 0o755);
		symlinkSync(real, join(cwd, "run.sh"));
		const result = await add(dgHome, "bot", ["--cwd", cwd], ["./run.sh"], { cwd });
		expect(result.code).toBe(0);
		const stored = storedConfig(dgHome).jobs.bot.argv[0];
		expect(stored).toBe(join(cwd, "run.sh"));
		expect(lstatSync(stored).isSymbolicLink()).toBe(true);
		expect(readlinkSync(stored)).toBe(real);
	});

	it("refuses ./run.sh without an execute bit and writes nothing", async () => {
		const { dgHome, cwd } = setup();
		writeFileSync(join(cwd, "run.sh"), "#!/bin/sh\n");
		chmodSync(join(cwd, "run.sh"), 0o644);
		const result = await add(dgHome, "bot", ["--cwd", cwd], ["./run.sh"], { cwd });
		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			`job add: file is not executable: ${join(cwd, "run.sh")}`,
		);
		expect(readFileSync(configPathOf(dgHome), "utf8")).toBe(SEED);
	});

	it("refuses a path that does not exist", async () => {
		const { dgHome, cwd } = setup();
		const result = await add(dgHome, "bot", ["--cwd", cwd], ["./missing.sh"], { cwd });
		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			`job add: executable not found: ${join(cwd, "missing.sh")}`,
		);
		expect(readFileSync(configPathOf(dgHome), "utf8")).toBe(SEED);
	});

	it("converts --stop-timeout 30s and refuses 5m, 30 and 0s", async () => {
		const { dgHome, cwd } = setup();
		expect(
			(await add(dgHome, "ok", ["--cwd", cwd, "--stop-timeout", "30s"])).code,
		).toBe(0);
		expect(storedConfig(dgHome).jobs.ok.stopTimeoutMs).toBe(30_000);
		const five = await add(dgHome, "five", ["--cwd", cwd, "--stop-timeout", "5m"]);
		expect(five.code).toBe(1);
		expect(five.stderr).toContain(
			'"stopTimeoutMs" must be an integer from 1 to 240000',
		);
		const bare = await add(dgHome, "bare", ["--cwd", cwd, "--stop-timeout", "30"]);
		expect(bare.stderr).toContain(
			'--stop-timeout: expected a count and a unit of s, m or h (for example 15m), got "30"',
		);
		const zero = await add(dgHome, "zero", ["--cwd", cwd, "--stop-timeout", "0s"]);
		expect(zero.stderr).toContain(
			'--stop-timeout: interval must be greater than zero, got "0s"',
		);
		expect(Object.keys(storedConfig(dgHome).jobs)).toEqual(["ok"]);
	});

	it("keeps pinnedOrigin and the first job when it adds a second", async () => {
		const { dgHome, cwd } = setup();
		const first = { argv: ["/bin/x"], cwd: "/srv", continuous: true };
		writeConfigFile(dgHome, {
			pinnedOrigin: "https://x",
			jobsVersion: 2,
			jobs: { first },
		});
		const result = await add(dgHome, "second", ["--cwd", cwd]);
		expect(result.code).toBe(0);
		const config = storedConfig(dgHome);
		expect(config.pinnedOrigin).toBe("https://x");
		expect(config.jobs.first).toEqual(first);
		expect(config.jobs.second).toBeDefined();
	});

	it("exits 1, names the file and leaves invalid JSON untouched", async () => {
		const { dgHome, cwd } = setup();
		const file = writeConfigFile(dgHome, '{"jobs":');
		for (const args of [
			["job", "add", "--name", "bot", "--continuous", "--cwd", cwd, "--", "bun", "x"],
			["job", "remove", "bot"],
		]) {
			const result = await runCli(dgHome, args);
			expect(result.code).toBe(1);
			expect(result.stderr).toContain(file);
			expect(readFileSync(file, "utf8")).toBe('{"jobs":');
		}
	});

	it("writes jobs.x and keeps a services value that is not an object", async () => {
		const { dgHome, cwd } = setup();
		const file = writeConfigFile(dgHome, '{"jobsVersion":2,"services":[1]}');
		const added = await add(dgHome, "bot", ["--cwd", cwd], ["bun", "x"]);
		expect(added.code).toBe(0);
		expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
			services: [1],
			jobs: { bot: { continuous: true } },
		});
	});

	it("writes through a symlinked config and keeps the link", async () => {
		const { dgHome, cwd } = setup();
		const file = configPathOf(dgHome);
		const target = join(cwd, "real-config.json");
		writeFileSync(target, SEED);
		rmSync(file);
		symlinkSync(target, file);
		await add(dgHome, "bot", ["--cwd", cwd]);
		expect(lstatSync(file).isSymbolicLink()).toBe(true);
		expect(JSON.parse(readFileSync(target, "utf8")).jobs.bot).toBeDefined();
	});

	it.skipIf(process.platform === "win32")("keeps the mode of an existing config file", async () => {
		const existing = setup();
		const file = configPathOf(existing.dgHome);
		chmodSync(file, 0o640);
		await add(existing.dgHome, "bot", ["--cwd", existing.cwd]);
		expect(statSync(file).mode & 0o777).toBe(0o640);
	});

	it("treats a pid file of a dead daemon as no daemon", async () => {
		const { dgHome, cwd } = setup();
		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
		mkdirSync(join(paths.pidPath, ".."), { recursive: true });
		writePidFileAtomic(paths, {
			pid: 2_000_000_000,
			port: allocatePort(),
			instanceId: "dead",
			versions: { package: "0.0.0", protocol: CHAT_PROTOCOL_VERSION },
		});
		const result = await add(dgHome, "bot", ["--cwd", cwd]);
		expect(result.code).toBe(0);
		expect(lines(result.stdout)).toEqual([
			'added job "bot"',
			"next: dg job enable bot",
		]);
	});
});

describe("job remove config writes", () => {
	it("removes an entry whose declaration is invalid", async () => {
		const { dgHome } = setup();
		writeConfigFile(dgHome, {
			jobsVersion: 2,
			jobs: { bot: { argv: [], continuous: true } },
		});
		const result = await runCli(dgHome, ["job", "remove", "bot"]);
		expect(result.code).toBe(0);
		expect(storedConfig(dgHome).jobs).toEqual({});
	});

	it("refuses with an empty config and leaves it as it was", async () => {
		const { dgHome } = setup();
		const result = await runCli(dgHome, ["job", "remove", "ghost"]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('no job named "ghost"');
		expect(readFileSync(configPathOf(dgHome), "utf8")).toBe(SEED);
	});
});

describe("job verbs on a home with no config file", () => {
	it("remove refuses and creates no file", async () => {
		const dgHome = freshDgHome();
		homes.push(dgHome);
		const result = await runCli(dgHome, ["job", "remove", "ghost"]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('no job named "ghost"');
	});
});
