import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	CHAT_PROTOCOL_VERSION,
	type DaemonHandle,
	DgCliError,
} from "@dg/common";
import {
	type AutostartDeps,
	type DgPaths,
	launchdPlistPath,
	resolveDgPaths,
	systemdUnitPath,
	windowsTaskXmlPath,
	writePidFileAtomic,
} from "@dg/common/node";
import { assertNotBlocked } from "@dg/common/node/layout";
import { shouldSkip } from "@dg/common/node/layout-preaction";
import { launcherCommand } from "@dg/common/node/program";
import type { Command } from "commander";
import {
	cmdAutostartInstall,
	cmdAutostartRemove,
	cmdAutostartStatus,
	installDaemonAutostart,
} from "../../src/commands/autostart";

type Ran = string[];
type Reply = { code: number; stdout?: string; stderr?: string };
type Written = { path: string; data: string | Uint8Array; mode?: number };

const HAND_OVER =
	"a daemon is already running outside the service manager; run dg-daemon restart to hand it over";
const STOP_FIRST =
	"hint: run dg-daemon stop first; the service manager has a shorter stop limit";

let root: string;
let paths: DgPaths;
let events: string[];
let ran: Ran[];
let written: Written[];
let replies: (argv: string[]) => Reply;
let missing: Set<string>;
let stops: (() => void)[];
const saved: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined): void {
	if (!(key in saved)) saved[key] = process.env[key];
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "dg-autostart-cmd-"));
	setEnv("DG_HOME", join(root, "dg"));
	setEnv("WSL_DISTRO_NAME", undefined);
	paths = resolveDgPaths();
	events = [];
	ran = [];
	written = [];
	missing = new Set();
	stops = [];
	replies = () => ({ code: 0 });
});

afterEach(() => {
	for (const stop of stops.splice(0)) stop();
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(root, { recursive: true, force: true });
});

function makeDeps(overrides: Partial<AutostartDeps> = {}): AutostartDeps {
	const [bun, dgJs] = launcherCommand(paths.dataDir, "dg-daemon", ["serve"]);
	return {
		platform: "linux",
		homeDir: join(root, "home"),
		env: { DG_HOME: paths.legacyHome },
		uid: 501,
		writeFile: (path, data, mode) => {
			written.push({ path, data, mode });
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, data);
		},
		removeFile: (path) => rmSync(path, { force: true }),
		fileExists: (path) =>
			path === bun || path === dgJs ? !missing.has(path) : existsSync(path),
		run: async (argv) => {
			ran.push(argv);
			events.push(`run ${argv.join(" ")}`);
			const reply = replies(argv);
			return {
				code: reply.code,
				stdout: reply.stdout ?? "",
				stderr: reply.stderr ?? "",
			};
		},
		...overrides,
	};
}

function captureLines(): () => string[] {
	const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		events.push(`say ${args.join(" ")}`);
	});
	stops.push(() => spy.mockRestore());
	return () =>
		events
			.filter((event) => event.startsWith("say "))
			.map((event) => event.slice(4));
}

function liveDaemon(): DaemonHandle {
	const instanceId = crypto.randomUUID();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => Response.json({ instanceId }),
	});
	stops.push(() => server.stop(true));
	const handle: DaemonHandle = {
		pid: process.pid,
		port: server.port as number,
		instanceId,
		versions: { package: "9.9.9", protocol: CHAT_PROTOCOL_VERSION },
	};
	writePidFileAtomic(paths, handle);
	return handle;
}

const unitPathFor = (deps: AutostartDeps): string =>
	systemdUnitPath(deps.homeDir, deps.env, "dg-daemon");
const failure = async (action: Promise<unknown>): Promise<DgCliError> => {
	const error = await action.then(
		() => undefined,
		(err: unknown) => err,
	);
	expect(error).toBeInstanceOf(DgCliError);
	return error as DgCliError;
};

describe("dg-daemon autostart install", () => {
	it("writes the unit with mode 0600, then reloads, enables with --now and enables linger, in that order", async () => {
		const deps = makeDeps();
		const lines = captureLines();

		await cmdAutostartInstall(deps);

		expect(written[0]?.path).toBe(unitPathFor(deps));
		expect(written[0]?.mode).toBe(0o600);
		expect(ran.map((argv) => argv.join(" "))).toEqual([
			"systemctl --user daemon-reload",
			"systemctl --user enable --now dg-daemon.service",
			"loginctl enable-linger",
		]);
		expect(lines()).toEqual([
			"autostart installed (systemd): dg-daemon starts at login",
		]);
	});

	it("starts dg-daemon serve through the stable current links", async () => {
		const deps = makeDeps();

		await installDaemonAutostart(deps, paths);

		const unit = readFileSync(unitPathFor(deps), "utf8");
		const execStart =
			unit.split("\n").find((line) => line.startsWith("ExecStart=")) ?? "";
		expect(execStart).toContain(
			`"${join(paths.dataDir, "runtime", "current", "bun")}"`,
		);
		expect(execStart).toContain(
			`"${join(paths.dataDir, "lib", "current", "dg.js")}" "dg-daemon" "serve"`,
		);
		expect(unit).toContain("RestartPreventExitStatus=3 78");
	});

	it("installDaemonAutostart prints nothing and returns the kind", async () => {
		const lines = captureLines();

		const result = await installDaemonAutostart(makeDeps(), paths);

		expect(result).toEqual({ kind: "systemd" });
		expect(lines()).toEqual([]);
	});

	it("gives one unit file and exit 0 when it runs two times", async () => {
		const deps = makeDeps();

		await cmdAutostartInstall(deps);
		await cmdAutostartInstall(deps);

		expect(readFileSync(unitPathFor(deps), "utf8")).toContain("ExecStart=");
		expect(new Set(written.map((entry) => entry.path)).size).toBe(1);
	});

	it("on darwin writes the dg-daemon plist and bootstraps it", async () => {
		const deps = makeDeps({ platform: "darwin" });
		const lines = captureLines();

		await cmdAutostartInstall(deps);

		const plist = launchdPlistPath(deps.homeDir, "dg-daemon");
		expect(written[0]?.path).toBe(plist);
		expect(ran).toContainEqual(["launchctl", "bootstrap", "gui/501", plist]);
		expect(readFileSync(plist, "utf8")).toContain(
			join(paths.logDir, "dg-daemon-autostart.log"),
		);
		expect(lines()).toEqual([
			"autostart installed (launchd): dg-daemon starts at login",
		]);
	});

	it("on win32 writes the task XML in daemonDir and prints the task kind", async () => {
		const deps = makeDeps({ platform: "win32", env: {} });
		const lines = captureLines();

		await cmdAutostartInstall(deps);

		expect(written.map((entry) => entry.path)).toContain(
			windowsTaskXmlPath(paths, "dg-daemon"),
		);
		expect(lines()).toEqual([
			"autostart installed (task): dg-daemon starts at login",
		]);
	});

	it("on win32 with DG_HOME set exits 1 and writes no task XML", async () => {
		const deps = makeDeps({
			platform: "win32",
			env: { DG_HOME: paths.legacyHome },
		});

		const error = await failure(cmdAutostartInstall(deps));

		expect(error.exitCode).toBe(1);
		expect(error.message).toBe(
			"autostart install: a scheduled task cannot pass DG_HOME; unset DG_HOME, then run the command again",
		);
		expect(written).toEqual([]);
	});

	it("on an unsupported platform exits 1 and writes nothing", async () => {
		const error = await failure(
			cmdAutostartInstall(makeDeps({ platform: "freebsd" as NodeJS.Platform })),
		);

		expect(error.exitCode).toBe(1);
		expect(error.message).toBe(
			'autostart install: unsupported platform "freebsd"',
		);
		expect(written).toEqual([]);
	});

	it("when the service manager is unavailable exits 1 with the first stderr line and leaves no unit file", async () => {
		replies = (argv) =>
			argv[2] === "daemon-reload"
				? { code: 1, stderr: "no user bus\nmore" }
				: { code: 0 };
		const deps = makeDeps();

		const error = await failure(cmdAutostartInstall(deps));

		expect(error.exitCode).toBe(1);
		expect(error.message).toBe("autostart install: no user bus");
		expect(existsSync(unitPathFor(deps))).toBe(false);
	});

	it("a failed systemctl enable --now exits 1 and leaves no unit file", async () => {
		replies = (argv) =>
			argv[2] === "enable"
				? { code: 1, stderr: "bad unit\nmore" }
				: { code: 0 };
		const deps = makeDeps();

		const error = await failure(cmdAutostartInstall(deps));

		expect(error.exitCode).toBe(1);
		expect(error.message).toBe(
			"autostart install: systemctl --user enable --now dg-daemon.service failed: bad unit",
		);
		expect(existsSync(unitPathFor(deps))).toBe(false);
	});

	it("a failed loginctl enable-linger exits 1 and removes the unit as remove does", async () => {
		replies = (argv) =>
			argv[0] === "loginctl"
				? { code: 1, stderr: "denied\nmore" }
				: { code: 0 };
		const deps = makeDeps();

		const error = await failure(cmdAutostartInstall(deps));

		expect(error.exitCode).toBe(1);
		expect(error.message).toBe(
			"autostart install: loginctl enable-linger failed: denied",
		);
		expect(existsSync(unitPathFor(deps))).toBe(false);
		expect(ran).toContainEqual([
			"systemctl",
			"--user",
			"disable",
			"--now",
			"dg-daemon.service",
		]);
	});

	for (const missingIndex of [0, 1]) {
		it(`exits 1 with no unit file when ${missingIndex === 0 ? "argv[0]" : "the dg.js path"} is absent`, async () => {
			const target = launcherCommand(paths.dataDir, "dg-daemon", ["serve"])[
				missingIndex
			] as string;
			missing.add(target);
			const deps = makeDeps();

			const error = await failure(cmdAutostartInstall(deps));

			expect(error.exitCode).toBe(1);
			expect(error.message).toBe(
				`autostart install: ${target} is missing; install dg first`,
			);
			expect(written).toEqual([]);
			expect(ran).toEqual([]);
		});
	}

	it("prints the hand over line after the installed line when a live daemon exists", async () => {
		liveDaemon();
		const lines = captureLines();

		await cmdAutostartInstall(makeDeps());

		expect(lines()).toEqual([
			"autostart installed (systemd): dg-daemon starts at login",
			HAND_OVER,
		]);
	});

	it("prints no hand over line when the unit was already installed", async () => {
		const deps = makeDeps();
		await cmdAutostartInstall(deps);
		liveDaemon();
		const lines = captureLines();

		await cmdAutostartInstall(deps);

		expect(lines()).toEqual([
			"autostart installed (systemd): dg-daemon starts at login",
		]);
	});

	it("reports an unsupported platform before it checks the launcher files", async () => {
		missing.add(
			launcherCommand(paths.dataDir, "dg-daemon", ["serve"])[0] as string,
		);

		const error = await failure(
			installDaemonAutostart(
				makeDeps({ platform: "freebsd" as NodeJS.Platform }),
				paths,
			),
		);

		expect(error.message).toBe('unsupported platform "freebsd"');
	});

	it("prints no hand over line when no daemon is live", async () => {
		const lines = captureLines();

		await cmdAutostartInstall(makeDeps());

		expect(lines()).not.toContain(HAND_OVER);
	});

	it("leaves the dg-phone unit bytes unchanged and names no dg-phone service", async () => {
		const deps = makeDeps();
		const phoneUnit = systemdUnitPath(deps.homeDir, deps.env, "dg-phone");
		mkdirSync(dirname(phoneUnit), { recursive: true });
		writeFileSync(phoneUnit, "phone");
		captureLines();

		await cmdAutostartInstall(deps);

		expect(readFileSync(phoneUnit, "utf8")).toBe("phone");
		expect(ran.flat().some((arg) => arg.includes("dg-phone"))).toBe(false);
	});
});

describe("dg-daemon autostart install with a blocked daemon entry", () => {
	it("exits with the block error and writes no unit file", async () => {
		const from = join(paths.legacyHome, "daemon");
		mkdirSync(from, { recursive: true });
		writeFileSync(join(from, "key"), "k");
		const expected = await failure(
			Promise.resolve().then(() => assertNotBlocked(paths, "daemon")),
		);
		const deps = makeDeps();

		const error = await failure(cmdAutostartInstall(deps));

		expect(error.message).toBe(expected.message);
		expect(error.exitCode).toBe(expected.exitCode);
		expect(written).toEqual([]);
		expect(ran).toEqual([]);
	});
});

describe("dg-daemon autostart install in WSL", () => {
	const DISTRO = "Ubuntu-22.04";
	const WIN_PATH = "C:\\state\\dg-daemon-wsl.task.xml";
	const wslEnv = (distro = DISTRO) => ({
		DG_HOME: paths.legacyHome,
		WSL_DISTRO_NAME: distro,
	});

	beforeEach(() => {
		replies = (argv) =>
			argv[0] === "wslpath"
				? { code: 0, stdout: `${WIN_PATH}\n` }
				: { code: 0 };
	});

	it("enables linger, then registers the Windows login task from the XML in daemonDir", async () => {
		const deps = makeDeps({ env: wslEnv() });

		await cmdAutostartInstall(deps);

		const xmlPath = join(paths.daemonDir, "dg-daemon-wsl.task.xml");
		const commands = ran.map((argv) => argv.join(" "));
		expect(commands).toEqual([
			"systemctl --user daemon-reload",
			"systemctl --user enable --now dg-daemon.service",
			"loginctl enable-linger",
			`wslpath -w ${xmlPath}`,
			`schtasks.exe /Create /TN dg-daemon-wsl-${DISTRO} /XML ${WIN_PATH} /F`,
		]);
		const xml = written.find((entry) => entry.path === xmlPath);
		const text = Buffer.from(xml?.data as Uint8Array)
			.toString("utf16le")
			.replace(/^\uFEFF/, "");
		expect(text).toContain("<Command>wsl.exe</Command>");
		expect(text).toContain(`<Arguments>-d ${DISTRO} --exec true</Arguments>`);
		expect(text).not.toContain("--dg-home");
	});

	for (const value of ["", "-d", "a b", "a/b", "x;y", "é"]) {
		it(`refuses WSL_DISTRO_NAME ${JSON.stringify(value)}`, async () => {
			const deps = makeDeps({ env: wslEnv(value) });

			const error = await failure(cmdAutostartInstall(deps));

			expect(error.exitCode).toBe(1);
			expect(error.message).toBe(
				`autostart install: WSL_DISTRO_NAME "${value}" is not valid`,
			);
			expect(existsSync(unitPathFor(deps))).toBe(false);
		});
	}

	for (const failing of ["wslpath", "schtasks.exe"]) {
		it(`removes the unit and exits 1 when ${failing} fails`, async () => {
			replies = (argv) =>
				argv[0] === failing
					? { code: 1, stderr: `${failing} is absent\nmore` }
					: argv[0] === "wslpath"
						? { code: 0, stdout: `${WIN_PATH}\n` }
						: { code: 0 };
			const deps = makeDeps({ env: wslEnv() });

			const error = await failure(cmdAutostartInstall(deps));

			expect(error.exitCode).toBe(1);
			expect(error.message.startsWith(`autostart install: ${failing} `)).toBe(
				true,
			);
			expect(error.message.endsWith(` failed: ${failing} is absent`)).toBe(
				true,
			);
			expect(existsSync(unitPathFor(deps))).toBe(false);
			expect(ran).toContainEqual([
				"systemctl",
				"--user",
				"disable",
				"--now",
				"dg-daemon.service",
			]);
		});
	}

	it("remove deletes the task and its XML, leaves the linger setting, and exits 0 when the delete fails", async () => {
		const deps = makeDeps({ env: wslEnv() });
		await cmdAutostartInstall(deps);
		const xmlPath = join(paths.daemonDir, "dg-daemon-wsl.task.xml");
		expect(existsSync(xmlPath)).toBe(true);
		ran.length = 0;
		replies = (argv) =>
			argv[0] === "schtasks.exe"
				? { code: 1, stderr: "ERROR: not found" }
				: { code: 0 };
		const lines = captureLines();

		await cmdAutostartRemove(deps);

		expect(ran).toContainEqual([
			"schtasks.exe",
			"/Delete",
			"/TN",
			`dg-daemon-wsl-${DISTRO}`,
			"/F",
		]);
		expect(ran.some((argv) => argv[0] === "loginctl")).toBe(false);
		expect(existsSync(xmlPath)).toBe(false);
		expect(existsSync(unitPathFor(deps))).toBe(false);
		expect(lines()).toEqual(["autostart removed"]);
	});

	it("remove with no unit and an XML file still deletes the task and the XML", async () => {
		const deps = makeDeps({ env: wslEnv() });
		const xmlPath = join(paths.daemonDir, "dg-daemon-wsl.task.xml");
		mkdirSync(paths.daemonDir, { recursive: true });
		writeFileSync(xmlPath, "<xml/>");
		const lines = captureLines();

		await cmdAutostartRemove(deps);

		expect(ran).toContainEqual([
			"schtasks.exe",
			"/Delete",
			"/TN",
			`dg-daemon-wsl-${DISTRO}`,
			"/F",
		]);
		expect(existsSync(xmlPath)).toBe(false);
		expect(lines()).toEqual(["autostart: not installed"]);
	});

	it("status prints the wsl task line and holds wslTask in the JSON", async () => {
		const deps = makeDeps({ env: wslEnv() });
		const lines = captureLines();

		await cmdAutostartStatus({}, deps);
		await cmdAutostartInstall(deps);
		await cmdAutostartStatus({}, deps);
		await cmdAutostartStatus({ json: true }, deps);

		const out = lines();
		expect(out).toContain("wsl task: not installed");
		expect(out).toContain("wsl task: installed");
		expect(JSON.parse(out[out.length - 1] as string)).toMatchObject({
			installed: true,
			kind: "systemd",
			wslTask: true,
		});
	});

	it("status runs no command", async () => {
		const deps = makeDeps({ env: wslEnv() });
		captureLines();

		await cmdAutostartStatus({}, deps);

		expect(ran).toEqual([]);
	});
});

describe("dg-daemon autostart remove", () => {
	it("prints autostart: not installed when no unit file exists", async () => {
		const lines = captureLines();

		await cmdAutostartRemove(makeDeps());

		expect(lines()).toEqual(["autostart: not installed"]);
		expect(ran).toEqual([]);
	});

	it("disables the unit, removes the file and prints autostart removed", async () => {
		const deps = makeDeps();
		await cmdAutostartInstall(deps);
		ran.length = 0;
		const lines = captureLines();

		await cmdAutostartRemove(deps);

		expect(ran).toEqual([
			["systemctl", "--user", "disable", "--now", "dg-daemon.service"],
		]);
		expect(existsSync(unitPathFor(deps))).toBe(false);
		expect(lines()).toEqual(["autostart removed"]);
	});

	it("prints the stop first hint before it removes the unit when a daemon is live", async () => {
		const deps = makeDeps();
		await cmdAutostartInstall(deps);
		liveDaemon();
		events.length = 0;
		captureLines();

		await cmdAutostartRemove(deps);

		const hint = events.indexOf(`say ${STOP_FIRST}`);
		const disable = events.indexOf(
			"run systemctl --user disable --now dg-daemon.service",
		);
		expect(hint).toBeGreaterThanOrEqual(0);
		expect(hint).toBeLessThan(disable);
	});

	it("does not remove the dg-phone unit", async () => {
		const deps = makeDeps();
		const phoneUnit = systemdUnitPath(deps.homeDir, deps.env, "dg-phone");
		mkdirSync(dirname(phoneUnit), { recursive: true });
		writeFileSync(phoneUnit, "phone");
		captureLines();

		await cmdAutostartRemove(deps);

		expect(readFileSync(phoneUnit, "utf8")).toBe("phone");
		expect(ran).toEqual([]);
	});
});

describe("dg-daemon autostart status", () => {
	it("prints not installed and the JSON null kind when no unit exists", async () => {
		const lines = captureLines();

		await cmdAutostartStatus({}, makeDeps());
		await cmdAutostartStatus({ json: true }, makeDeps());

		expect(lines()).toEqual([
			"autostart: not installed",
			'{"installed":false,"kind":null}',
		]);
	});

	it("prints the installed kind and the JSON kind", async () => {
		const deps = makeDeps();
		await cmdAutostartInstall(deps);
		ran.length = 0;
		const lines = captureLines();

		await cmdAutostartStatus({}, deps);
		await cmdAutostartStatus({ json: true }, deps);

		expect(lines()).toEqual([
			"autostart: installed (systemd)",
			'{"installed":true,"kind":"systemd"}',
		]);
		expect(ran).toEqual([]);
	});

	it("prints not installed when only the dg-phone unit exists", async () => {
		const deps = makeDeps();
		const phoneUnit = systemdUnitPath(deps.homeDir, deps.env, "dg-phone");
		mkdirSync(dirname(phoneUnit), { recursive: true });
		writeFileSync(phoneUnit, "phone");
		const lines = captureLines();

		await cmdAutostartStatus({}, deps);

		expect(lines()).toEqual(["autostart: not installed"]);
	});
});

describe("dg-daemon main registration", () => {
	async function autostartCommand(name: string) {
		const { buildProgram } = await import("../../src/main");
		const program = await buildProgram();
		const group = program.commands.find(
			(command) => command.name() === "autostart",
		);
		const command = group?.commands.find(
			(candidate) => candidate.name() === name,
		);
		expect(command).toBeDefined();
		return command as Command;
	}

	it("registers install, remove and status under autostart", async () => {
		for (const name of ["install", "remove", "status"])
			await autostartCommand(name);
	});

	it("skips the layout move for status only", async () => {
		const { SKIP } = await import("../../src/main");

		expect(shouldSkip(await autostartCommand("status"), SKIP)).toBe(true);
		expect(shouldSkip(await autostartCommand("install"), SKIP)).toBe(false);
		expect(shouldSkip(await autostartCommand("remove"), SKIP)).toBe(false);
	});
});
