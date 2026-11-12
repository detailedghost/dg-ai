import { afterEach, describe, expect, it } from "bun:test";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { CHAT_PROTOCOL_VERSION } from "@dg/common";
import { resolveDgPaths, writePidFileAtomic } from "@dg/common/node";
import { parseServices } from "../../src/services/config";
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
	services: Record<
		string,
		{
			argv: string[];
			cwd?: string;
			envFile?: string;
			passEnv?: string[];
			stopTimeoutMs?: number;
			autostart?: boolean;
		}
	>;
};
const storedConfig = (dgHome: string) => readConfigFile(dgHome) as StoredConfig;

const homes: string[] = [];
afterEach(() => {
	for (const home of homes.splice(0)) cleanupDgHome(home);
});

function setup() {
	const dgHome = freshDgHome();
	homes.push(dgHome);
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
		expect(Object.keys(storedConfig(dgHome).services).sort()).toEqual(labels);
	}, 30_000);

	it("stores an absolute argv[0] and autostart, then prints the next line for no daemon", async () => {
		const { dgHome, cwd } = setup();
		const result = await add(dgHome, "bot", ["--cwd", cwd, "--autostart"]);
		expect(result.code).toBe(0);
		expect(lines(result.stdout)).toEqual([
			'added service "bot"',
			"next: dg-daemon start",
		]);
		const entry = storedConfig(dgHome).services.bot;
		expect(entry).toEqual({
			argv: [BUN, "run", "bot.ts"],
			cwd,
			autostart: true,
		});
	});

	it("prints the two-step next line with no --autostart and writes no autostart key", async () => {
		const { dgHome, cwd } = setup();
		const result = await add(dgHome, "bot", ["--cwd", cwd]);
		expect(lines(result.stdout)).toEqual([
			'added service "bot"',
			"next: dg-daemon start, then dg-daemon service start bot",
		]);
		expect(Object.hasOwn(storedConfig(dgHome).services.bot, "autostart")).toBe(
			false,
		);
	});

	it("writes an entry that parseServices accepts, with every option", async () => {
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
		const [parsed] = parseServices(config);
		expect(parsed).toMatchObject({
			ok: true,
			argv: [BUN, "run", "bot.ts"],
			passEnv: ["A", "B"],
			stopTimeoutMs: 30_000,
			grant: "bot",
			envFile,
			autostart: true,
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
		expect(storedConfig(dgHome).services.bot.passEnv).toEqual(["A", "A"]);
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
		const entry = storedConfig(dgHome).services.bot;
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
		const stored = storedConfig(dgHome).services.bot.argv[0];
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
		expect(existsSync(configPathOf(dgHome))).toBe(false);
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
		expect(existsSync(configPathOf(dgHome))).toBe(false);
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
		expect(existsSync(configPathOf(dgHome))).toBe(false);
	});

	it("refuses a missing --cwd directory", async () => {
		const { dgHome, cwd } = setup();
		const missing = join(cwd, "nope");
		const result = await add(dgHome, "bot", ["--cwd", missing]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain(`--cwd: no such directory: ${missing}`);
		expect(existsSync(configPathOf(dgHome))).toBe(false);
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
		expect(existsSync(configPathOf(dgHome))).toBe(false);
	});

	it("refuses an invalid label with the label rule", async () => {
		const { dgHome, cwd } = setup();
		const result = await add(dgHome, "Bad_Label", ["--cwd", cwd]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			"label must be 1-64 lowercase letters, digits or hyphens",
		);
		expect(existsSync(configPathOf(dgHome))).toBe(false);
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
			expect(existsSync(configPathOf(dgHome))).toBe(false);
		},
	);

	it("converts --stop-timeout 30s and refuses 5m, 30 and 0s", async () => {
		const { dgHome, cwd } = setup();
		expect(
			(await add(dgHome, "ok", ["--cwd", cwd, "--stop-timeout", "30s"])).code,
		).toBe(0);
		expect(storedConfig(dgHome).services.ok.stopTimeoutMs).toBe(30_000);
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
		expect(Object.keys(storedConfig(dgHome).services)).toEqual(["ok"]);
	});

	it("keeps pinnedOrigin and the first service when it adds a second", async () => {
		const { dgHome, cwd } = setup();
		const first = { argv: ["/bin/x"], cwd: "/srv" };
		writeConfigFile(dgHome, { pinnedOrigin: "https://x", services: { first } });
		const result = await add(dgHome, "second", ["--cwd", cwd]);
		expect(result.code).toBe(0);
		const config = storedConfig(dgHome);
		expect(config.pinnedOrigin).toBe("https://x");
		expect(config.services.first).toEqual(first);
		expect(config.services.second).toBeDefined();
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

	it("exits 1 and leaves the file alone when services is not an object", async () => {
		const { dgHome, cwd } = setup();
		const file = writeConfigFile(dgHome, '{"services":[1]}');
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
		expect(added.code).toBe(1);
		expect(added.stderr).toContain('"services" must be an object');
		const removed = await runCli(dgHome, ["service", "rm", "0"]);
		expect(removed.code).toBe(1);
		expect(removed.stderr).toContain('no service labelled "0"');
		expect(readFileSync(file, "utf8")).toBe('{"services":[1]}');
	});

	it("writes through a symlinked config and keeps the link", async () => {
		const { dgHome, cwd } = setup();
		const file = configPathOf(dgHome);
		const target = join(cwd, "real-config.json");
		writeFileSync(target, "{}");
		mkdirSync(join(file, ".."), { recursive: true });
		symlinkSync(target, file);
		await add(dgHome, "bot", ["--cwd", cwd]);
		expect(lstatSync(file).isSymbolicLink()).toBe(true);
		expect(JSON.parse(readFileSync(target, "utf8")).services.bot).toBeDefined();
	});

	it("gives a new config file mode 0600 and keeps the mode of an existing one", async () => {
		if (process.platform === "win32") return;
		const fresh = setup();
		await add(fresh.dgHome, "bot", ["--cwd", fresh.cwd]);
		expect(statSync(configPathOf(fresh.dgHome)).mode & 0o777).toBe(0o600);
		const existing = setup();
		const file = writeConfigFile(existing.dgHome, {});
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
			"next: dg-daemon start",
		]);
	});
});

describe("service rm", () => {
	it("removes the entry and keeps every other key", async () => {
		const { dgHome } = setup();
		writeConfigFile(dgHome, {
			pinnedOrigin: "p",
			services: { bot: { argv: ["/bin/x"], cwd: "/srv" } },
		});
		const result = await runCli(dgHome, ["service", "rm", "bot"]);
		expect(result.code).toBe(0);
		expect(lines(result.stdout)).toEqual(['removed service "bot"']);
		expect(readConfigFile(dgHome)).toEqual({ pinnedOrigin: "p", services: {} });
	});

	it("removes an entry whose declaration is invalid", async () => {
		const { dgHome } = setup();
		writeConfigFile(dgHome, { services: { bot: { argv: [] } } });
		const result = await runCli(dgHome, ["service", "rm", "bot"]);
		expect(result.code).toBe(0);
		expect(storedConfig(dgHome).services).toEqual({});
	});

	it("refuses and keeps the entry when the daemon pid runs but does not answer", async () => {
		const { dgHome } = setup();
		writeConfigFile(dgHome, {
			services: { bot: { argv: ["/bin/x"], cwd: "/srv" } },
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
				`dg-daemon (pid ${silent.pid}) does not answer, so the state of service "bot" is unknown`,
			);
			expect(Object.keys(storedConfig(dgHome).services)).toEqual(["bot"]);
		} finally {
			silent.kill("SIGKILL");
		}
	});

	it("refuses while an earlier instance of the service still runs with no daemon", async () => {
		const { dgHome } = setup();
		writeConfigFile(dgHome, {
			services: { bot: { argv: ["/bin/x"], cwd: "/srv" } },
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
			expect(Object.keys(storedConfig(dgHome).services)).toEqual(["bot"]);
		} finally {
			orphan.kill("SIGKILL");
		}
	});

	it("refuses an unknown label", async () => {
		const { dgHome } = setup();
		writeConfigFile(dgHome, { services: {} });
		const result = await runCli(dgHome, ["service", "rm", "ghost"]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('no service labelled "ghost"');
	});

	it("refuses with no config file and creates none", async () => {
		const { dgHome } = setup();
		const result = await runCli(dgHome, ["service", "rm", "ghost"]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('no service labelled "ghost"');
		expect(existsSync(configPathOf(dgHome))).toBe(false);
	});

	it("removes the entry when the pid file is of a dead daemon", async () => {
		const { dgHome } = setup();
		writeConfigFile(dgHome, {
			services: { bot: { argv: ["/bin/x"], cwd: "/srv" } },
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
		expect(storedConfig(dgHome).services).toEqual({});
	});
});

describe("service add then service rm", () => {
	it("leaves the first config plus an empty services table", async () => {
		const { dgHome, cwd } = setup();
		writeConfigFile(dgHome, { pinnedOrigin: "p" });
		await add(dgHome, "bot", ["--cwd", cwd]);
		await runCli(dgHome, ["service", "rm", "bot"]);
		expect(readConfigFile(dgHome)).toEqual({ pinnedOrigin: "p", services: {} });
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
				"no live dg-daemon — services run inside it, so start it with dg-daemon start",
			);
		},
	);
});
