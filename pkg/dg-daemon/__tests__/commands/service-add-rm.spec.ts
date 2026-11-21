import { afterEach, describe, expect, it } from "bun:test";
import {
	chmodSync,
	existsSync,
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
import { CHAT_PROTOCOL_VERSION } from "@dg/common";
import { resolveDgPaths, writePidFileAtomic } from "@dg/common/node";
import { parseJobs } from "../../src/jobs/config";
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
	jobsVersion?: number;
	jobs: Record<
		string,
		{
			argv: string[];
			cwd?: string;
			envFile?: string;
			passEnv?: string[];
			stopTimeoutMs?: number;
			continuous?: boolean;
			enabled?: boolean;
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
	return { dgHome, cwd: freshTempDir("svc-cwd") };
}

const BUN = Bun.which("bun") as string;
const add = (
	dgHome: string,
	label: string,
	flags: string[],
	command = ["bun", "run", "bot.ts"],
	opts: { cwd?: string } = {},
) =>
	runCli(dgHome, ["service", "add", label, ...flags, "--", ...command], opts);

describe("service add", () => {
	it("keeps every entry when several service add runs write at once", async () => {
		const { dgHome, cwd } = setup();
		const labels = Array.from({ length: 8 }, (_, i) => `bot${i}`);
		const results = await Promise.all(
			labels.map((label) => add(dgHome, label, ["--cwd", cwd])),
		);
		expect(results.map((result) => result.code)).toEqual(labels.map(() => 0));
		expect(Object.keys(storedConfig(dgHome).jobs).sort()).toEqual(labels);
	}, 30_000);

	it("stores an absolute argv[0] and enabled, then prints the next line for no daemon", async () => {
		const { dgHome, cwd } = setup();
		const result = await add(dgHome, "bot", ["--cwd", cwd, "--autostart"]);
		expect(result.code).toBe(0);
		expect(lines(result.stdout)).toEqual([
			'added service "bot"',
			"next: dg daemon start",
		]);
		const entry = storedConfig(dgHome).jobs.bot;
		expect(entry).toEqual({
			argv: [BUN, "run", "bot.ts"],
			cwd,
			continuous: true,
			enabled: true,
		});
	});

	it("prints the two-step next line with no --autostart and writes no enabled key", async () => {
		const { dgHome, cwd } = setup();
		const result = await add(dgHome, "bot", ["--cwd", cwd]);
		expect(lines(result.stdout)).toEqual([
			'added service "bot"',
			"next: dg daemon start, then dg service start bot",
		]);
		expect(Object.hasOwn(storedConfig(dgHome).jobs.bot, "enabled")).toBe(false);
	});

	it("writes an entry that parseJobs accepts, with every option", async () => {
		const { dgHome, cwd } = setup();
		const envFile = join(cwd, ".env");
		writeFileSync(envFile, "A=1\n");
		const result = await add(dgHome, "bot", [
			"--cwd",
			cwd,
			"--autostart",
			"--env-file",
			envFile,
			"--pass-env",
			"A",
			"--pass-env",
			"B",
			"--stop-timeout",
			"30s",
			"--grant",
			"bot",
		]);
		expect(result.code).toBe(0);
		const config = storedConfig(dgHome);
		const [parsed] = parseJobs(config);
		expect(parsed).toMatchObject({
			ok: true,
			argv: [BUN, "run", "bot.ts"],
			passEnv: ["A", "B"],
			stopTimeoutMs: 30_000,
			grant: "bot",
			envFile,
			enabled: true,
		});
	});

	it("stores a repeated --pass-env as given", async () => {
		const { dgHome, cwd } = setup();
		await add(dgHome, "bot", [
			"--cwd",
			cwd,
			"--pass-env",
			"A",
			"--pass-env",
			"A",
		]);
		expect(storedConfig(dgHome).jobs.bot.passEnv).toEqual(["A", "A"]);
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
		const result = await add(dgHome, "bot", ["--cwd", cwd], ["./run.sh"], {
			cwd,
		});
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
		const result = await add(dgHome, "bot", ["--cwd", cwd], ["./run.sh"], {
			cwd,
		});
		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			`service add: file is not executable: ${join(cwd, "run.sh")}`,
		);
		expect(readFileSync(configPathOf(dgHome), "utf8")).toBe(SEED);
	});

	it("refuses a path that is not a file", async () => {
		const { dgHome, cwd } = setup();
		const result = await add(dgHome, "bot", ["--cwd", cwd], ["./missing.sh"], {
			cwd,
		});
		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			`service add: executable not found: ${join(cwd, "missing.sh")}`,
		);
		expect(readFileSync(configPathOf(dgHome), "utf8")).toBe(SEED);
	});

	it("refuses a bare name that does not resolve on PATH", async () => {
		const { dgHome, cwd } = setup();
		const result = await add(
			dgHome,
			"bot",
			["--cwd", cwd],
			["no-such-binary-xyz"],
		);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			'service add: executable "no-such-binary-xyz" does not resolve on PATH',
		);
		expect(readFileSync(configPathOf(dgHome), "utf8")).toBe(SEED);
	});

	it("refuses a missing --cwd directory", async () => {
		const { dgHome, cwd } = setup();
		const missing = join(cwd, "nope");
		const result = await add(dgHome, "bot", ["--cwd", missing]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain(`--cwd: no such directory: ${missing}`);
		expect(readFileSync(configPathOf(dgHome), "utf8")).toBe(SEED);
	});

	it("refuses an empty command", async () => {
		const { dgHome, cwd } = setup();
		const result = await runCli(dgHome, [
			"service",
			"add",
			"bot",
			"--cwd",
			cwd,
		]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			"service add: no command given — put it after a bare --",
		);
		expect(readFileSync(configPathOf(dgHome), "utf8")).toBe(SEED);
	});

	it("refuses an invalid label with the label rule", async () => {
		const { dgHome, cwd } = setup();
		const result = await add(dgHome, "Bad_Label", ["--cwd", cwd]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			"label must be 1-64 lowercase letters, digits or hyphens",
		);
		expect(readFileSync(configPathOf(dgHome), "utf8")).toBe(SEED);
	});

	it("refuses a label that already exists and leaves the entry alone", async () => {
		const { dgHome, cwd } = setup();
		await add(dgHome, "bot", ["--cwd", cwd]);
		const before = readFileSync(configPathOf(dgHome), "utf8");
		const result = await add(
			dgHome,
			"bot",
			["--cwd", cwd, "--autostart"],
			["bun", "other.ts"],
		);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('a service labelled "bot" already exists');
		expect(readFileSync(configPathOf(dgHome), "utf8")).toBe(before);
	});

	it.each([
		[
			["--pass-env", "1BAD"],
			'"passEnv" must be an array of environment variable names',
		],
		[["--grant", "UPPER"], '"grant" must be a credential grant prefix'],
	])(
		"refuses %p with the validator error and writes nothing",
		async (flags, message) => {
			const { dgHome, cwd } = setup();
			const result = await add(dgHome, "bot", ["--cwd", cwd, ...flags]);
			expect(result.code).toBe(1);
			expect(result.stderr).toContain(`service add: ${message}`);
			expect(readFileSync(configPathOf(dgHome), "utf8")).toBe(SEED);
		},
	);

	it("converts --stop-timeout 30s and refuses 5m, 30 and 0s", async () => {
		const { dgHome, cwd } = setup();
		expect(
			(await add(dgHome, "ok", ["--cwd", cwd, "--stop-timeout", "30s"])).code,
		).toBe(0);
		expect(storedConfig(dgHome).jobs.ok.stopTimeoutMs).toBe(30_000);
		const five = await add(dgHome, "five", [
			"--cwd",
			cwd,
			"--stop-timeout",
			"5m",
		]);
		expect(five.code).toBe(1);
		expect(five.stderr).toContain(
			'"stopTimeoutMs" must be an integer from 1 to 240000',
		);
		const bare = await add(dgHome, "bare", [
			"--cwd",
			cwd,
			"--stop-timeout",
			"30",
		]);
		expect(bare.stderr).toContain(
			'--stop-timeout: expected a count and a unit of s, m or h (for example 15m), got "30"',
		);
		const zero = await add(dgHome, "zero", [
			"--cwd",
			cwd,
			"--stop-timeout",
			"0s",
		]);
		expect(zero.stderr).toContain(
			'--stop-timeout: interval must be greater than zero, got "0s"',
		);
		expect(Object.keys(storedConfig(dgHome).jobs)).toEqual(["ok"]);
	});

	it("keeps pinnedOrigin and the first service when it adds a second", async () => {
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
		const file = writeConfigFile(dgHome, '{"services":');
		for (const args of [
			["service", "add", "bot", "--cwd", cwd, "--", "bun", "x"],
			["service", "rm", "bot"],
		]) {
			const result = await runCli(dgHome, args);
			expect(result.code).toBe(1);
			expect(result.stderr).toContain(file);
			expect(readFileSync(file, "utf8")).toBe('{"services":');
		}
	});

	it("writes jobs.x and keeps a services value that is not an object", async () => {
		const { dgHome, cwd } = setup();
		const body = '{"jobsVersion":2,"services":[1]}';
		const file = writeConfigFile(dgHome, body);
		const added = await runCli(dgHome, [
			"service",
			"add",
			"bot",
			"--cwd",
			cwd,
			"--",
			"bun",
			"x",
		]);
		expect(added.code).toBe(0);
		expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
			services: [1],
			jobs: { bot: { continuous: true } },
		});
		const removed = await runCli(dgHome, ["service", "rm", "0"]);
		expect(removed.code).toBe(1);
		expect(removed.stderr).toContain('no service labelled "0"');
		expect(JSON.parse(readFileSync(file, "utf8")).services).toEqual([1]);
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

	it("keeps the mode of an existing config file", async () => {
		if (process.platform === "win32") return;
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
		writeFileSync(
			paths.pidPath,
			JSON.stringify({
				pid: 2_000_000_000,
				port: allocatePort(),
				instanceId: "dead",
				versions: { package: "0.0.0", protocol: 1 },
			}),
		);
		const result = await add(dgHome, "bot", ["--cwd", cwd, "--autostart"]);
		expect(lines(result.stdout)).toEqual([
			'added service "bot"',
			"next: dg daemon start",
		]);
	});
});

describe("service rm", () => {
	it("removes the entry and keeps every other key", async () => {
		const { dgHome } = setup();
		writeConfigFile(dgHome, {
			pinnedOrigin: "p",
			jobsVersion: 2,
			jobs: { bot: { argv: ["/bin/x"], cwd: "/srv", continuous: true } },
		});
		const result = await runCli(dgHome, ["service", "rm", "bot"]);
		expect(result.code).toBe(0);
		expect(lines(result.stdout)).toEqual(['removed service "bot"']);
		expect(readConfigFile(dgHome)).toEqual({
			pinnedOrigin: "p",
			jobsVersion: 2,
			jobs: {},
		});
	});

	it("removes an entry whose declaration is invalid", async () => {
		const { dgHome } = setup();
		writeConfigFile(dgHome, {
			jobsVersion: 2,
			jobs: { bot: { argv: [], continuous: true } },
		});
		const result = await runCli(dgHome, ["service", "rm", "bot"]);
		expect(result.code).toBe(0);
		expect(storedConfig(dgHome).jobs).toEqual({});
	});

	it("refuses and keeps the entry when the daemon pid runs but does not answer", async () => {
		const { dgHome } = setup();
		writeConfigFile(dgHome, {
			jobsVersion: 2,
			jobs: { bot: { argv: ["/bin/x"], cwd: "/srv", continuous: true } },
		});
		const silent = Bun.spawn(
			[process.execPath, "-e", "setInterval(()=>{},1000)"],
			{ stdout: "ignore", stderr: "ignore" },
		);
		try {
			writePidFileAtomic(resolveDgPaths({ env: { DG_HOME: dgHome } }), {
				pid: silent.pid,
				port: await allocatePort(),
				instanceId: crypto.randomUUID(),
				versions: { package: "9.9.9", protocol: CHAT_PROTOCOL_VERSION },
			});
			const result = await runCli(dgHome, ["service", "rm", "bot"]);
			expect(result.code).toBe(1);
			expect(result.stderr).toContain(
				`dg daemon (pid ${silent.pid}) does not answer, so the state of service "bot" is unknown`,
			);
			expect(Object.keys(storedConfig(dgHome).jobs)).toEqual(["bot"]);
		} finally {
			silent.kill("SIGKILL");
		}
	});

	it("refuses while an earlier instance of the service still runs with no daemon", async () => {
		const { dgHome } = setup();
		writeConfigFile(dgHome, {
			jobsVersion: 2,
			jobs: { bot: { argv: ["/bin/x"], cwd: "/srv", continuous: true } },
		});
		const orphan = Bun.spawn(
			[process.execPath, "-e", "setInterval(()=>{},1000)"],
			{ stdout: "ignore", stderr: "ignore" },
		);
		try {
			const { daemonDir } = resolveDgPaths({ env: { DG_HOME: dgHome } });
			mkdirSync(join(daemonDir, "services"), { recursive: true });
			writeFileSync(join(daemonDir, "services", "bot.pid"), String(orphan.pid));
			const result = await runCli(dgHome, ["service", "rm", "bot"]);
			expect(result.code).toBe(1);
			expect(result.stderr).toContain(
				`service "bot" still runs as pid ${orphan.pid}`,
			);
			expect(Object.keys(storedConfig(dgHome).jobs)).toEqual(["bot"]);
		} finally {
			orphan.kill("SIGKILL");
		}
	});

	it("refuses an unknown label", async () => {
		const { dgHome } = setup();
		writeConfigFile(dgHome, { jobsVersion: 2, jobs: {} });
		const result = await runCli(dgHome, ["service", "rm", "ghost"]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('no service labelled "ghost"');
	});

	it("refuses with an empty config and leaves it as it was", async () => {
		const { dgHome } = setup();
		const result = await runCli(dgHome, ["service", "rm", "ghost"]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('no service labelled "ghost"');
		expect(readFileSync(configPathOf(dgHome), "utf8")).toBe(SEED);
	});

	it("removes the entry when the pid file is of a dead daemon", async () => {
		const { dgHome } = setup();
		writeConfigFile(dgHome, {
			jobsVersion: 2,
			jobs: { bot: { argv: ["/bin/x"], cwd: "/srv", continuous: true } },
		});
		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
		mkdirSync(join(paths.pidPath, ".."), { recursive: true });
		writeFileSync(
			paths.pidPath,
			JSON.stringify({
				pid: 2_000_000_000,
				port: allocatePort(),
				instanceId: "dead",
				versions: { package: "0.0.0", protocol: 1 },
			}),
		);
		const result = await runCli(dgHome, ["service", "rm", "bot"]);
		expect(result.code).toBe(0);
		expect(storedConfig(dgHome).jobs).toEqual({});
	});
});

describe("service add then service rm", () => {
	it("leaves the first config plus an empty jobs table", async () => {
		const { dgHome, cwd } = setup();
		writeConfigFile(dgHome, { pinnedOrigin: "p", jobsVersion: 2 });
		await add(dgHome, "bot", ["--cwd", cwd]);
		await runCli(dgHome, ["service", "rm", "bot"]);
		expect(readConfigFile(dgHome)).toEqual({
			pinnedOrigin: "p",
			jobsVersion: 2,
			jobs: {},
		});
	});
});

function bareHome() {
	const dgHome = freshDgHome();
	homes.push(dgHome);
	const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
	return { dgHome, paths, cwd: freshTempDir("svc-cwd") };
}

const noDaemonStarted = (paths: ReturnType<typeof resolveDgPaths>) => {
	expect(existsSync(paths.daemonConfigPath)).toBe(false);
	expect(existsSync(paths.pidPath)).toBe(false);
};

describe("service commands on a home with no config file", () => {
	it("rm refuses, starts no daemon and creates no file", async () => {
		const { dgHome, paths } = bareHome();
		const result = await runCli(dgHome, ["service", "rm", "ghost"]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('no service labelled "ghost"');
		noDaemonStarted(paths);
	});

	it.each([["start"], ["stop"]])(
		"%s refuses, starts no daemon and creates no file",
		async (verb) => {
			const { dgHome, paths } = bareHome();
			const result = await runCli(dgHome, ["service", verb, "ghost"]);
			expect(result.code).toBe(1);
			expect(result.stdout).toBe("");
			noDaemonStarted(paths);
		},
	);
});

describe("service add argument checks run before the migration step", () => {
	const unmarked = (dgHome: string) => {
		const body = JSON.stringify({
			services: { old: { argv: ["/b"], cwd: "/c" } },
		});
		writeConfigFile(dgHome, body);
		return body;
	};

	it.each([
		[
			"a missing --cwd directory",
			(cwd: string) => ({
				flags: ["--cwd", join(cwd, "nope")],
				command: ["bun", "x.ts"],
			}),
			"--cwd: no such directory",
		],
		[
			"a bad label",
			(cwd: string) => ({
				flags: ["--cwd", cwd],
				command: ["bun", "x.ts"],
				label: "Bad_Label",
			}),
			"label must be 1-64 lowercase letters, digits or hyphens",
		],
		[
			"an executable that does not resolve",
			(cwd: string) => ({
				flags: ["--cwd", cwd],
				command: ["no-such-binary-xyz"],
			}),
			'executable "no-such-binary-xyz" does not resolve on PATH',
		],
		[
			"a bad --stop-timeout",
			(cwd: string) => ({
				flags: ["--cwd", cwd, "--stop-timeout", "0s"],
				command: ["bun", "x.ts"],
			}),
			"--stop-timeout: interval must be greater than zero",
		],
	])(
		"refuses %s on an unmarked config and starts no daemon",
		async (_name, build, message) => {
			const { dgHome, paths, cwd } = bareHome();
			const body = unmarked(dgHome);
			const { flags, command, label } = build(cwd) as {
				flags: string[];
				command: string[];
				label?: string;
			};
			const result = await add(dgHome, label ?? "bot", flags, command);
			expect(result.code).toBe(1);
			expect(result.stderr).toContain(message);
			expect(readFileSync(paths.daemonConfigPath, "utf8")).toBe(body);
			expect(existsSync(paths.pidPath)).toBe(false);
		},
	);

	it("refuses an empty command on a home with no config file and starts no daemon", async () => {
		const { dgHome, paths, cwd } = bareHome();
		const result = await runCli(dgHome, [
			"service",
			"add",
			"bot",
			"--cwd",
			cwd,
		]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("service add: no command given");
		noDaemonStarted(paths);
	});
});

describe("service commands with no live daemon", () => {
	it.each([[["status"]], [["start", "bot"]], [["stop", "bot"]]])(
		"service %p exits 1 with the start hint",
		async (args) => {
			const { dgHome } = setup();
			const result = await runCli(dgHome, ["service", ...args]);
			expect(result.code).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain(
				"no live dg daemon — services run inside it, so start it with dg daemon start",
			);
		},
	);
});
