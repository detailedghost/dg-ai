import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	DgCliError,
	EXIT_LAYOUT_BLOCKED,
	EXIT_WSL_NAT_NETWORKING,
} from "../src";
import {
	type AutostartDeps,
	type AutostartSpec,
	autostartInstalled,
	autostartManages,
	defaultAutostartDeps,
	formatAutostartState,
	installAutostart,
	launchdPlistPath,
	launchdPlistText,
	managedRestartCommands,
	removeAutostart,
	resolveDgPaths,
	systemdUnitPath,
	systemdUnitText,
	windowsTaskXml,
	windowsTaskXmlBytes,
	windowsTaskXmlPath,
} from "../src/node";
import { launcherCommand } from "../src/node/program";

const paths = resolveDgPaths({
	platform: "linux",
	homeDir: "/home/u",
	env: {},
});

function fakeDeps(overrides: Partial<AutostartDeps> = {}): {
	deps: AutostartDeps;
	written: { path: string; text: string | Uint8Array; mode?: number }[];
	removed: string[];
	ran: string[][];
} {
	const written: { path: string; text: string | Uint8Array; mode?: number }[] =
		[];
	const removed: string[] = [];
	const ran: string[][] = [];
	const deps: AutostartDeps = {
		platform: "linux",
		homeDir: "/home/u",
		env: {},
		uid: 501,
		writeFile: (path, text, mode) => {
			written.push({ path, text, mode });
		},
		removeFile: (path) => {
			removed.push(path);
		},
		fileExists: () => true,
		run: async () => ({ code: 0, stdout: "", stderr: "" }),
		...overrides,
	};
	return { deps, written, removed, ran };
}

function recordingRun(
	ran: string[][],
	codeFor: (argv: string[]) => {
		code: number;
		stderr?: string;
		stdout?: string;
	},
) {
	return async (argv: string[]) => {
		ran.push(argv);
		const result = codeFor(argv);
		return {
			code: result.code,
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
		};
	};
}

function unquoteSystemdExecStart(execStart: string): string[] {
	const args: string[] = [];
	let i = 0;
	while (i < execStart.length) {
		if (execStart[i] === " ") {
			i += 1;
			continue;
		}
		if (execStart[i] !== '"')
			throw new Error(`expected a quote at ${i} in ${execStart}`);
		i += 1;
		let current = "";
		while (execStart[i] !== '"') {
			if (execStart[i] === "\\") {
				current += execStart[i + 1];
				i += 2;
			} else {
				current += execStart[i];
				i += 1;
			}
		}
		i += 1;
		args.push(current);
	}
	return args;
}

const spec: AutostartSpec = {
	name: "dg-phone",
	argv: ["/fake/execPath", "/fake/src/index.ts", "phone", "listen"],
	logPath: "/home/u/.dg/phone/listener.log",
};

describe("systemdUnitText", () => {
	it("matches the expected unit snapshot for a fake execPath", () => {
		expect(systemdUnitText(spec)).toBe(
			[
				"[Unit]",
				"Description=dg phone listener",
				"",
				"[Service]",
				'ExecStart="/fake/execPath" "/fake/src/index.ts" "phone" "listen"',
				"Restart=on-failure",
				"RestartSec=5",
				"",
				"[Install]",
				"WantedBy=default.target",
				"",
			].join("\n"),
		);
	});

	it("adds an Environment line for DG_HOME only when set", () => {
		expect(systemdUnitText({ ...spec, dgHome: "/custom/dg" })).toContain(
			'Environment="DG_HOME=/custom/dg"',
		);
		expect(systemdUnitText(spec)).not.toContain("Environment=");
	});

	it("round-trips an --on-message exe with a space and an embedded quote through ExecStart's quoting", () => {
		const argv = [
			"/fake/execPath",
			"phone",
			"listen",
			"--on-message",
			"/usr/bin/notify",
			"a b",
			'c"d',
		];
		const text = systemdUnitText({ name: "dg-phone", argv, logPath: "" });
		const execStart =
			text
				.split("\n")
				.find((line) => line.startsWith("ExecStart="))
				?.slice("ExecStart=".length) ?? "";

		expect(unquoteSystemdExecStart(execStart)).toEqual(argv);
	});

	it("doubles a literal percent or dollar so systemd does not expand it as a specifier or variable", () => {
		const text = systemdUnitText({
			name: "dg-phone",
			argv: ["/exe", "100%", "$HOME"],
			logPath: "",
		});

		expect(text).toContain('ExecStart="/exe" "100%%" "$$HOME"');
	});
});

describe("systemdUnitPath", () => {
	it("defaults to ~/.config/systemd/user and honors XDG_CONFIG_HOME", () => {
		expect(systemdUnitPath("/home/u", {}, "dg-phone")).toBe(
			"/home/u/.config/systemd/user/dg-phone.service",
		);
		expect(
			systemdUnitPath(
				"/home/u",
				{ XDG_CONFIG_HOME: "/custom/config" },
				"dg-phone",
			),
		).toBe("/custom/config/systemd/user/dg-phone.service");
	});
});

describe("launchdPlistText", () => {
	it("holds RunAtLoad, a restart-on-failure KeepAlive, and every argv element", () => {
		const text = launchdPlistText(spec);

		expect(text).toContain("<key>RunAtLoad</key>\n\t<true/>");
		expect(text).toContain(
			"<key>KeepAlive</key>\n\t<dict>\n\t\t<key>SuccessfulExit</key>\n\t\t<false/>\n\t</dict>",
		);
		for (const arg of spec.argv)
			expect(text).toContain(`<string>${arg}</string>`);
		expect(text).toContain(`<string>${spec.logPath}</string>`);
	});

	it("escapes XML metacharacters in an argv element", () => {
		const text = launchdPlistText({
			name: "dg-phone",
			argv: ["a&b<c>"],
			logPath: "",
		});

		expect(text).toContain("<string>a&amp;b&lt;c&gt;</string>");
	});
});

describe("windowsTaskXml", () => {
	it("holds a LogonTrigger and RestartOnFailure, and quotes the arguments CommandLineToArgvW-style", () => {
		const text = windowsTaskXml({
			name: "dg-phone",
			argv: [
				"C:\\dg\\dg-agent.exe",
				"phone",
				"listen",
				"--on-message",
				"C:\\Program Files\\notify.exe",
				"a b",
				'c"d',
			],
			logPath: "",
		});

		expect(text).toContain("<LogonTrigger>");
		expect(text).toContain(
			"<RestartOnFailure>\n\t\t\t<Interval>PT1M</Interval>\n\t\t\t<Count>10</Count>\n\t\t</RestartOnFailure>",
		);
		expect(text).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
		expect(text).toContain("<Command>C:\\dg\\dg-agent.exe</Command>");
		expect(text).toContain(
			'<Arguments>phone listen --on-message "C:\\Program Files\\notify.exe" "a b" "c\\"d"</Arguments>',
		);
		expect(text).not.toContain("--dg-home");
	});

	it("passes DG_HOME as --dg-home after listen, because a task has no environment block", () => {
		const text = windowsTaskXml({
			name: "dg-phone",
			argv: [
				"C:\\dg\\dg-agent.exe",
				"phone",
				"listen",
				"--on-message",
				"C:\\Program Files\\notify.exe",
			],
			dgHome: "D:\\custom dg&home",
			logPath: "",
		});

		expect(text).toContain(
			'<Arguments>phone listen --dg-home "D:\\custom dg&amp;home" --on-message "C:\\Program Files\\notify.exe"</Arguments>',
		);
	});

	it("encodes the task XML as UTF-16 LE with a BOM, matching the declared encoding", () => {
		const bytes = Buffer.from(windowsTaskXmlBytes(spec));

		expect([bytes[0], bytes[1]]).toEqual([0xff, 0xfe]);
		const decoded = bytes.toString("utf16le").replace(/^\uFEFF/, "");
		expect(decoded).toBe(windowsTaskXml(spec));
		expect(decoded).toContain('encoding="UTF-16"');
		expect(bytes.toString("utf8").includes('encoding="UTF-16"')).toBe(false);
	});
});

describe("windowsTaskXmlPath", () => {
	it("sits inside phoneRoot", () => {
		expect(windowsTaskXmlPath(paths, "dg-phone")).toBe(
			`${paths.phoneRoot}/dg-phone.task.xml`,
		);
	});
});

describe("installAutostart", () => {
	it("linux happy path: writes the unit then runs daemon-reload and enable --now in order", async () => {
		const ran: string[][] = [];
		const { deps, written } = fakeDeps({
			run: recordingRun(ran, () => ({ code: 0 })),
		});

		const outcome = await installAutostart(deps, paths, spec);

		expect(outcome).toEqual({ ok: true, kind: "systemd" });
		expect(written[0]?.path).toBe(
			"/home/u/.config/systemd/user/dg-phone.service",
		);
		expect(ran).toEqual([
			["systemctl", "--user", "daemon-reload"],
			["systemctl", "--user", "enable", "--now", "dg-phone.service"],
		]);
	});

	it("linux: a failing daemon-reload means systemd user is unavailable, removes the unit, and reports the first stderr line", async () => {
		const ran: string[][] = [];
		const { deps, removed, written } = fakeDeps({
			run: recordingRun(ran, (argv) =>
				argv[2] === "daemon-reload"
					? {
							code: 1,
							stderr:
								"Failed to connect to bus: no such file or directory\nmore detail",
						}
					: { code: 0 },
			),
		});

		const outcome = await installAutostart(deps, paths, spec);

		expect(outcome).toEqual({
			ok: false,
			reason: "Failed to connect to bus: no such file or directory",
		});
		expect(removed).toEqual([written[0]?.path]);
		expect(ran).toEqual([["systemctl", "--user", "daemon-reload"]]);
	});

	it("linux: a failing enable --now after a working daemon-reload is a real error, not unavailability, and removes the unit", async () => {
		const ran: string[][] = [];
		const { deps, removed, written } = fakeDeps({
			run: recordingRun(ran, (argv) =>
				argv[2] === "enable"
					? { code: 1, stderr: "Unit dg-phone.service has a bad unit file" }
					: { code: 0 },
			),
		});

		await expect(installAutostart(deps, paths, spec)).rejects.toBeInstanceOf(
			DgCliError,
		);
		expect(removed).toEqual([written[0]?.path]);
	});

	it("linux: a failing enable --now with an empty stderr reports only the first stdout line", async () => {
		const ran: string[][] = [];
		const { deps } = fakeDeps({
			run: recordingRun(ran, (argv) => (argv[2] === "enable" ? { code: 1, stdout: "a\nb" } : { code: 0 })),
		});

		const error = await installAutostart(deps, paths, spec).catch((err: unknown) => err);

		expect((error as Error).message.endsWith("failed: a")).toBe(true);
	});

	it("darwin happy path: writes the plist, boots it out best-effort, then bootstraps it", async () => {
		const ran: string[][] = [];
		const { deps, written } = fakeDeps({
			platform: "darwin",
			homeDir: "/Users/u",
			run: recordingRun(ran, () => ({ code: 0 })),
		});

		const outcome = await installAutostart(deps, paths, spec);

		expect(outcome).toEqual({ ok: true, kind: "launchd" });
		expect(written[0]?.path).toBe(
			"/Users/u/Library/LaunchAgents/com.detailedghost.dg-phone.plist",
		);
		expect(ran).toEqual([
			["launchctl", "bootout", "gui/501/com.detailedghost.dg-phone"],
			["launchctl", "bootstrap", "gui/501", written[0]?.path ?? ""],
		]);
	});

	it("darwin: a failing bootstrap removes the plist and reports unavailable", async () => {
		const ran: string[][] = [];
		const { deps, removed } = fakeDeps({
			platform: "darwin",
			run: recordingRun(ran, (argv) =>
				argv[1] === "bootstrap"
					? { code: 1, stderr: "not permitted" }
					: { code: 0 },
			),
		});

		const outcome = await installAutostart(deps, paths, spec);

		expect(outcome).toEqual({ ok: false, reason: "not permitted" });
		expect(removed).toHaveLength(1);
	});

	it("win32 happy path: ends any running task first, then writes the task xml, creates it, then runs it", async () => {
		const ran: string[][] = [];
		const { deps, written } = fakeDeps({
			platform: "win32",
			run: recordingRun(ran, () => ({ code: 0 })),
		});

		const outcome = await installAutostart(deps, paths, spec);

		expect(outcome).toEqual({ ok: true, kind: "task" });
		expect(ran).toEqual([
			["schtasks", "/End", "/TN", "dg-phone"],
			[
				"schtasks",
				"/Create",
				"/TN",
				"dg-phone",
				"/XML",
				written[0]?.path ?? "",
				"/F",
			],
			["schtasks", "/Run", "/TN", "dg-phone"],
		]);
	});

	it("win32: a failing Create removes the task xml and reports unavailable, ignoring a failed End", async () => {
		const ran: string[][] = [];
		const { deps, removed } = fakeDeps({
			platform: "win32",
			run: recordingRun(ran, (argv) =>
				argv[1] === "/Create"
					? { code: 1, stderr: "Access is denied." }
					: { code: 1 },
			),
		});

		const outcome = await installAutostart(deps, paths, spec);

		expect(outcome).toEqual({ ok: false, reason: "Access is denied." });
		expect(removed).toHaveLength(1);
	});

	it("win32: a failing Run after a working Create deletes the registered task and removes the task xml", async () => {
		const ran: string[][] = [];
		const { deps, removed, written } = fakeDeps({
			platform: "win32",
			run: recordingRun(ran, (argv) =>
				argv[1] === "/Run"
					? { code: 1, stderr: "task not found" }
					: { code: 0 },
			),
		});

		await expect(installAutostart(deps, paths, spec)).rejects.toBeInstanceOf(
			DgCliError,
		);
		expect(ran.map((argv) => argv[1])).toEqual([
			"/End",
			"/Create",
			"/Run",
			"/Delete",
		]);
		expect(removed).toEqual([written[0]?.path]);
	});

	it("win32: keeps the task xml when deleting the registered task after a failed Run also fails", async () => {
		const ran: string[][] = [];
		const { deps, removed } = fakeDeps({
			platform: "win32",
			run: recordingRun(ran, (argv) =>
				argv[1] === "/Run" || argv[1] === "/Delete"
					? { code: 1, stderr: "access denied" }
					: { code: 0 },
			),
		});

		await expect(installAutostart(deps, paths, spec)).rejects.toBeInstanceOf(
			DgCliError,
		);
		expect(ran.map((argv) => argv[1])).toEqual([
			"/End",
			"/Create",
			"/Run",
			"/Delete",
		]);
		expect(removed).toEqual([]);
	});

	it("reports an unsupported platform as unavailable without writing anything", async () => {
		const { deps, written } = fakeDeps({
			platform: "freebsd" as NodeJS.Platform,
		});

		const outcome = await installAutostart(deps, paths, spec);

		expect(outcome).toEqual({
			ok: false,
			reason: 'unsupported platform "freebsd"',
		});
		expect(written).toEqual([]);
	});
});

describe("removeAutostart", () => {
	it("reports absent and touches nothing when no unit file exists", async () => {
		const ran: string[][] = [];
		const { deps, removed } = fakeDeps({
			fileExists: () => false,
			run: recordingRun(ran, () => ({ code: 0 })),
		});

		const outcome = await removeAutostart(deps, paths, "dg-phone");

		expect(outcome).toBe("absent");
		expect(ran).toEqual([]);
		expect(removed).toEqual([]);
	});

	it("disables the unit and removes the file when one exists", async () => {
		const ran: string[][] = [];
		const { deps, removed } = fakeDeps({
			run: recordingRun(ran, () => ({ code: 0 })),
		});

		const outcome = await removeAutostart(deps, paths, "dg-phone");

		expect(outcome).toBe("removed");
		expect(ran).toEqual([
			["systemctl", "--user", "disable", "--now", "dg-phone.service"],
		]);
		expect(removed).toEqual(["/home/u/.config/systemd/user/dg-phone.service"]);
	});
});

describe("managedRestartCommands", () => {
	it("restarts each manager in place", () => {
		expect(managedRestartCommands("systemd", 501, "dg-phone")).toEqual([
			["systemctl", "--user", "restart", "dg-phone.service"],
		]);
		expect(managedRestartCommands("launchd", 501, "dg-phone")).toEqual([
			["launchctl", "kickstart", "-k", "gui/501/com.detailedghost.dg-phone"],
		]);
		expect(managedRestartCommands("task", 0, "dg-phone")).toEqual([
			["schtasks", "/End", "/TN", "dg-phone"],
			["schtasks", "/Run", "/TN", "dg-phone"],
		]);
	});
});

describe("formatAutostartState", () => {
	it("is null when nothing was ever installed, the kind when it was, and prefixes an unavailable reason", () => {
		expect(formatAutostartState(undefined)).toBeNull();
		expect(formatAutostartState({ kind: "systemd" })).toBe("systemd");
		expect(
			formatAutostartState({
				kind: "unavailable",
				reason: "no systemd user bus",
			}),
		).toBe("unavailable: no systemd user bus");
	});
});

describe("listener unit text", () => {
	const spec = {
		name: "dg-phone" as const,
		argv: launcherCommand(paths.dataDir, "dg-agent", ["phone", "listen"]),
		logPath: join(paths.phoneRoot, "listener.log"),
	};

	it("names the absolute launcher path and never ~ or $HOME", () => {
		for (const text of [
			systemdUnitText(spec),
			launchdPlistText(spec),
			windowsTaskXml(spec),
		]) {
			expect(text).toContain("/home/u/.local/share/dg/runtime/current/bun");
			expect(text).not.toContain("~");
			expect(text).not.toContain("$HOME");
		}
	});
});

const POSIX_ARGV = [
	"/fake/execPath",
	"/fake/src/index.ts",
	"phone",
	"listen",
	"--on-message",
	"/usr/bin/notify",
	"a b",
];
const POSIX_DG_HOME = '/custom dg/"h"&%$x';
const POSIX_LOG = "/home/u/.dg/phone/listener.log";
const WIN_ARGV = [
	"C:\\dg\\dg-agent.exe",
	"phone",
	"listen",
	"--on-message",
	"C:\\Program Files\\notify.exe",
];
const WIN_DG_HOME = "D:\\custom dg&home";
const WIN_LOG = "C:\\dg\\listener.log";
const GOLDEN_SYSTEMD: string = [
	"[Unit]",
	"Description=dg phone listener",
	"",
	"[Service]",
	'ExecStart="/fake/execPath" "/fake/src/index.ts" "phone" "listen" "--on-message" "/usr/bin/notify" "a b"',
	"Restart=on-failure",
	"RestartSec=5",
	'Environment="DG_HOME=/custom dg/\\"h\\"&%%$$x"',
	"",
	"[Install]",
	"WantedBy=default.target",
	"",
].join("\n");
const GOLDEN_SYSTEMD_NO_HOME: string = [
	"[Unit]",
	"Description=dg phone listener",
	"",
	"[Service]",
	'ExecStart="/fake/execPath" "/fake/src/index.ts" "phone" "listen" "--on-message" "/usr/bin/notify" "a b"',
	"Restart=on-failure",
	"RestartSec=5",
	"",
	"[Install]",
	"WantedBy=default.target",
	"",
].join("\n");
const GOLDEN_PLIST: string = [
	'<?xml version="1.0" encoding="UTF-8"?>',
	'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
	'<plist version="1.0">',
	"<dict>",
	"\t<key>Label</key>",
	"\t<string>com.detailedghost.dg-phone</string>",
	"\t<key>ProgramArguments</key>",
	"\t<array>",
	"\t\t<string>/fake/execPath</string>",
	"\t\t<string>/fake/src/index.ts</string>",
	"\t\t<string>phone</string>",
	"\t\t<string>listen</string>",
	"\t\t<string>--on-message</string>",
	"\t\t<string>/usr/bin/notify</string>",
	"\t\t<string>a b</string>",
	"\t</array>",
	"\t<key>RunAtLoad</key>",
	"\t<true/>",
	"\t<key>KeepAlive</key>",
	"\t<dict>",
	"\t\t<key>SuccessfulExit</key>",
	"\t\t<false/>",
	"\t</dict>",
	"\t<key>StandardOutPath</key>",
	"\t<string>/home/u/.dg/phone/listener.log</string>",
	"\t<key>StandardErrorPath</key>",
	"\t<string>/home/u/.dg/phone/listener.log</string>",
	"\t<key>EnvironmentVariables</key>",
	"\t<dict>",
	"\t\t<key>DG_HOME</key>",
	'\t\t<string>/custom dg/"h"&amp;%$x</string>',
	"\t</dict>",
	"</dict>",
	"</plist>",
	"",
].join("\n");
const GOLDEN_PLIST_NO_HOME: string = [
	'<?xml version="1.0" encoding="UTF-8"?>',
	'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
	'<plist version="1.0">',
	"<dict>",
	"\t<key>Label</key>",
	"\t<string>com.detailedghost.dg-phone</string>",
	"\t<key>ProgramArguments</key>",
	"\t<array>",
	"\t\t<string>/fake/execPath</string>",
	"\t\t<string>/fake/src/index.ts</string>",
	"\t\t<string>phone</string>",
	"\t\t<string>listen</string>",
	"\t\t<string>--on-message</string>",
	"\t\t<string>/usr/bin/notify</string>",
	"\t\t<string>a b</string>",
	"\t</array>",
	"\t<key>RunAtLoad</key>",
	"\t<true/>",
	"\t<key>KeepAlive</key>",
	"\t<dict>",
	"\t\t<key>SuccessfulExit</key>",
	"\t\t<false/>",
	"\t</dict>",
	"\t<key>StandardOutPath</key>",
	"\t<string>/home/u/.dg/phone/listener.log</string>",
	"\t<key>StandardErrorPath</key>",
	"\t<string>/home/u/.dg/phone/listener.log</string>",
	"</dict>",
	"</plist>",
	"",
].join("\n");
const GOLDEN_TASK: string = [
	'<?xml version="1.0" encoding="UTF-16"?>',
	'<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
	"\t<Triggers>",
	"\t\t<LogonTrigger>",
	"\t\t\t<Enabled>true</Enabled>",
	"\t\t</LogonTrigger>",
	"\t</Triggers>",
	"\t<Settings>",
	"\t\t<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
	"\t\t<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
	"\t\t<RestartOnFailure>",
	"\t\t\t<Interval>PT1M</Interval>",
	"\t\t\t<Count>10</Count>",
	"\t\t</RestartOnFailure>",
	"\t</Settings>",
	'\t<Actions Context="Author">',
	"\t\t<Exec>",
	"\t\t\t<Command>C:\\dg\\dg-agent.exe</Command>",
	'\t\t\t<Arguments>phone listen --dg-home "D:\\custom dg&amp;home" --on-message "C:\\Program Files\\notify.exe"</Arguments>',
	"\t\t</Exec>",
	"\t</Actions>",
	"</Task>",
	"",
].join("\n");
const GOLDEN_TASK_NO_HOME: string = [
	'<?xml version="1.0" encoding="UTF-16"?>',
	'<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
	"\t<Triggers>",
	"\t\t<LogonTrigger>",
	"\t\t\t<Enabled>true</Enabled>",
	"\t\t</LogonTrigger>",
	"\t</Triggers>",
	"\t<Settings>",
	"\t\t<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
	"\t\t<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
	"\t\t<RestartOnFailure>",
	"\t\t\t<Interval>PT1M</Interval>",
	"\t\t\t<Count>10</Count>",
	"\t\t</RestartOnFailure>",
	"\t</Settings>",
	'\t<Actions Context="Author">',
	"\t\t<Exec>",
	"\t\t\t<Command>C:\\dg\\dg-agent.exe</Command>",
	'\t\t\t<Arguments>phone listen --on-message "C:\\Program Files\\notify.exe"</Arguments>',
	"\t\t</Exec>",
	"\t</Actions>",
	"</Task>",
	"",
].join("\n");

const GOLDEN_SPEC: AutostartSpec = {
	name: "dg-phone",
	argv: POSIX_ARGV,
	dgHome: POSIX_DG_HOME,
	logPath: POSIX_LOG,
};
const GOLDEN_WIN_SPEC: AutostartSpec = {
	name: "dg-phone",
	argv: WIN_ARGV,
	dgHome: WIN_DG_HOME,
	logPath: WIN_LOG,
};

describe("dg-phone autostart output is byte-identical to master", () => {
	it("systemdUnitText matches the master text with and without DG_HOME", () => {
		expect(systemdUnitText(GOLDEN_SPEC)).toBe(GOLDEN_SYSTEMD);
		expect(systemdUnitText({ ...GOLDEN_SPEC, dgHome: undefined })).toBe(
			GOLDEN_SYSTEMD_NO_HOME,
		);
	});

	it("launchdPlistText matches the master text with and without DG_HOME", () => {
		expect(launchdPlistText(GOLDEN_SPEC)).toBe(GOLDEN_PLIST);
		expect(launchdPlistText({ ...GOLDEN_SPEC, dgHome: undefined })).toBe(
			GOLDEN_PLIST_NO_HOME,
		);
	});

	it("windowsTaskXml matches the master text with and without DG_HOME", () => {
		expect(windowsTaskXml(GOLDEN_WIN_SPEC)).toBe(GOLDEN_TASK);
		expect(windowsTaskXml({ ...GOLDEN_WIN_SPEC, dgHome: undefined })).toBe(
			GOLDEN_TASK_NO_HOME,
		);
	});

	it("each path matches the master path", () => {
		expect(systemdUnitPath("/home/u", {}, "dg-phone")).toBe(
			"/home/u/.config/systemd/user/dg-phone.service",
		);
		expect(launchdPlistPath("/Users/u", "dg-phone")).toBe(
			"/Users/u/Library/LaunchAgents/com.detailedghost.dg-phone.plist",
		);
		expect(windowsTaskXmlPath(paths, "dg-phone")).toBe(
			`${paths.phoneRoot}/dg-phone.task.xml`,
		);
	});

	it("managedRestartCommands matches the master commands", () => {
		expect(managedRestartCommands("systemd", 501, "dg-phone")).toEqual([
			["systemctl", "--user", "restart", "dg-phone.service"],
		]);
		expect(managedRestartCommands("launchd", 501, "dg-phone")).toEqual([
			["launchctl", "kickstart", "-k", "gui/501/com.detailedghost.dg-phone"],
		]);
		expect(managedRestartCommands("task", 0, "dg-phone")).toEqual([
			["schtasks", "/End", "/TN", "dg-phone"],
			["schtasks", "/Run", "/TN", "dg-phone"],
		]);
	});

	it("an install of dg-phone writes the master unit even when the caller sets XDG_*_HOME", async () => {
		const { deps, written } = fakeDeps({
			env: { XDG_DATA_HOME: "/x", XDG_STATE_HOME: "/y" },
			homeDir: "/home/u",
		});

		await installAutostart(deps, paths, GOLDEN_SPEC);

		expect(written[0]?.text).toBe(GOLDEN_SYSTEMD);
	});

	it("RestartPreventExitStatus stays out of the dg-phone unit", () => {
		expect(systemdUnitText(GOLDEN_SPEC)).not.toContain(
			"RestartPreventExitStatus",
		);
	});
});

const unquoteExecStart = (text: string): string[] => {
	const line =
		text.split("\n").find((candidate) => candidate.startsWith("ExecStart=")) ??
		"";
	return unquoteSystemdExecStart(line.slice("ExecStart=".length));
};

describe("dg-daemon autostart contracts", () => {
	let root: string;
	let daemonPaths: ReturnType<typeof resolveDgPaths>;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "dg-autostart-"));
		daemonPaths = resolveDgPaths({
			platform: "linux",
			homeDir: join(root, "home"),
			env: { DG_HOME: join(root, "dg") },
		});
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	const daemonSpec = (
		overrides: Partial<AutostartSpec> = {},
	): AutostartSpec => ({
		name: "dg-daemon",
		argv: launcherCommand(daemonPaths.dataDir, "dg-daemon", ["serve"]),
		logPath: join(daemonPaths.logDir, "dg-daemon-autostart.log"),
		restartPreventExitStatus: [EXIT_WSL_NAT_NETWORKING, EXIT_LAYOUT_BLOCKED],
		...overrides,
	});

	type Run = (
		argv: string[],
	) => Promise<{ code: number; stdout: string; stderr: string }>;

	function diskDeps(overrides: Partial<AutostartDeps> = {}): {
		deps: AutostartDeps;
		ran: string[][];
	} {
		const ran: string[][] = [];
		const run: Run = async (argv) => {
			ran.push(argv);
			return { code: 0, stdout: "", stderr: "" };
		};
		const deps: AutostartDeps = {
			platform: "linux",
			homeDir: join(root, "home"),
			env: { DG_HOME: join(root, "dg") },
			uid: 501,
			writeFile: (path, data) => {
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path, data);
			},
			removeFile: (path) => rmSync(path, { force: true }),
			fileExists: existsSync,
			run,
			...overrides,
		};
		return { deps, ran };
	}

	it("puts the unit at systemd/user/dg-daemon.service with the quoted launcher argv in ExecStart", () => {
		const unitPath = systemdUnitPath(join(root, "home"), {}, "dg-daemon");
		const text = systemdUnitText(daemonSpec());

		expect(unitPath.endsWith("systemd/user/dg-daemon.service")).toBe(true);
		expect(unquoteExecStart(text)).toEqual([
			join(daemonPaths.dataDir, "runtime", "current", "bun"),
			join(daemonPaths.dataDir, "lib", "current", "dg.js"),
			"dg-daemon",
			"serve",
		]);
		expect(text).toContain("Description=dg daemon\n");
	});

	it("holds RestartPreventExitStatus=3 78 right after RestartSec=5", () => {
		const lines = systemdUnitText(daemonSpec()).split("\n");

		expect(lines[lines.indexOf("RestartSec=5") + 1]).toBe(
			"RestartPreventExitStatus=3 78",
		);
	});

	it("names the launchd label, the plist path and the log twice", () => {
		const spec = daemonSpec();
		const text = launchdPlistText(spec);

		expect(launchdPlistPath("/Users/u", "dg-daemon")).toBe(
			"/Users/u/Library/LaunchAgents/com.detailedghost.dg-daemon.plist",
		);
		expect(text).toContain("<string>com.detailedghost.dg-daemon</string>");
		expect(
			text.split(
				`<string>${join(daemonPaths.logDir, "dg-daemon-autostart.log")}</string>`,
			),
		).toHaveLength(3);
	});

	it("places the task XML in daemonDir and starts the task with the serve argument", () => {
		expect(windowsTaskXmlPath(daemonPaths, "dg-daemon")).toBe(
			join(daemonPaths.daemonDir, "dg-daemon.task.xml"),
		);
		expect(windowsTaskXml(daemonSpec())).toMatch(
			/<Arguments>.*dg\.js dg-daemon serve<\/Arguments>/,
		);
	});

	it("derives the manager commands of dg-daemon from its name", () => {
		expect(managedRestartCommands("systemd", 501, "dg-daemon")).toEqual([
			["systemctl", "--user", "restart", "dg-daemon.service"],
		]);
		expect(managedRestartCommands("task", 0, "dg-daemon")).toEqual([
			["schtasks", "/End", "/TN", "dg-daemon"],
			["schtasks", "/Run", "/TN", "dg-daemon"],
		]);
	});

	it("bootstraps the plist path before the kickstart on launchd for dg-daemon only", () => {
		const plist = launchdPlistPath("/Users/u", "dg-daemon");

		expect(managedRestartCommands("launchd", 501, "dg-daemon", plist)).toEqual([
			["launchctl", "bootstrap", "gui/501", plist],
			["launchctl", "kickstart", "-k", "gui/501/com.detailedghost.dg-daemon"],
		]);
		expect(
			managedRestartCommands(
				"launchd",
				501,
				"dg-phone",
				launchdPlistPath("/Users/u", "dg-phone"),
			),
		).toEqual([
			["launchctl", "kickstart", "-k", "gui/501/com.detailedghost.dg-phone"],
		]);
	});

	it("passes a set DG_HOME in the dg-daemon plist EnvironmentVariables and none when unset", () => {
		const dgHome = join(root, "dg");

		const withHome = launchdPlistText(daemonSpec({ dgHome }));
		const withoutHome = launchdPlistText(daemonSpec());

		expect(withHome).toContain("<key>EnvironmentVariables</key>");
		expect(withHome).toContain(
			`<key>DG_HOME</key>\n\t\t<string>${dgHome}</string>`,
		);
		expect(withoutHome).not.toContain("DG_HOME");
	});

	it("writes no Environment line to the dg-daemon unit when the caller sets none", () => {
		expect(systemdUnitText(daemonSpec())).not.toMatch(/^Environment=/m);
	});

	it("records DG_HOME and each set XDG_*_HOME of the caller as Environment lines, and no PATH", async () => {
		const { deps } = diskDeps({
			env: {
				DG_HOME: join(root, "dg"),
				XDG_DATA_HOME: "/x",
				XDG_CONFIG_HOME: join(root, "cfg"),
				PATH: "/usr/bin",
			},
		});

		await installAutostart(
			deps,
			daemonPaths,
			daemonSpec({ dgHome: join(root, "dg") }),
		);

		const text = readFileSync(
			systemdUnitPath(deps.homeDir, deps.env, "dg-daemon"),
			"utf8",
		);
		expect(text).toMatch(/^Environment="XDG_DATA_HOME=\/x"$/m);
		expect(text).toMatch(/^Environment="XDG_CONFIG_HOME=/m);
		expect(text).toMatch(/^Environment="DG_HOME=/m);
		expect(text).not.toContain("XDG_STATE_HOME");
		expect(text).not.toContain("PATH");
	});

	it("installs and removes dg-daemon without reading, stopping or removing the dg-phone unit, and the reverse", async () => {
		const { deps, ran } = diskDeps();
		await installAutostart(deps, daemonPaths, GOLDEN_SPEC);
		await installAutostart(deps, daemonPaths, daemonSpec());
		const phoneUnit = systemdUnitPath(deps.homeDir, deps.env, "dg-phone");
		const daemonUnit = systemdUnitPath(deps.homeDir, deps.env, "dg-daemon");
		const phoneBefore = readFileSync(phoneUnit, "utf8");
		ran.length = 0;

		expect(await removeAutostart(deps, daemonPaths, "dg-daemon")).toBe(
			"removed",
		);

		expect(ran).toEqual([
			["systemctl", "--user", "disable", "--now", "dg-daemon.service"],
		]);
		expect(existsSync(daemonUnit)).toBe(false);
		expect(readFileSync(phoneUnit, "utf8")).toBe(phoneBefore);
		await installAutostart(deps, daemonPaths, daemonSpec());
		ran.length = 0;

		expect(await removeAutostart(deps, daemonPaths, "dg-phone")).toBe(
			"removed",
		);

		expect(ran).toEqual([
			["systemctl", "--user", "disable", "--now", "dg-phone.service"],
		]);
		expect(existsSync(phoneUnit)).toBe(false);
		expect(existsSync(daemonUnit)).toBe(true);
	});

	it("reports absent for the name that has no unit while the other name has one", async () => {
		const { deps, ran } = diskDeps();
		await installAutostart(deps, daemonPaths, GOLDEN_SPEC);
		ran.length = 0;

		expect(await removeAutostart(deps, daemonPaths, "dg-daemon")).toBe(
			"absent",
		);
		expect(autostartInstalled(deps, daemonPaths, "dg-daemon")).toBeUndefined();
		expect(autostartInstalled(deps, daemonPaths, "dg-phone")).toBe("systemd");
		expect(ran).toEqual([]);
	});

	it("autostartInstalled reports the kind of each platform from the unit file and runs no command", async () => {
		for (const [platform, kind] of [
			["linux", "systemd"],
			["darwin", "launchd"],
			["win32", "task"],
		] as const) {
			const { deps, ran } = diskDeps({ platform });
			expect(
				autostartInstalled(deps, daemonPaths, "dg-daemon"),
			).toBeUndefined();
			await installAutostart(deps, daemonPaths, daemonSpec());
			ran.length = 0;

			expect(autostartInstalled(deps, daemonPaths, "dg-daemon")).toBe(kind);
			expect(ran).toEqual([]);
			await removeAutostart(deps, daemonPaths, "dg-daemon");
		}
		expect(
			autostartInstalled(
				diskDeps({ platform: "freebsd" as NodeJS.Platform }).deps,
				daemonPaths,
				"dg-daemon",
			),
		).toBeUndefined();
	});

	describe("autostartManages", () => {
		const dgHome = () => join(root, "dg");

		async function installWith(
			callerEnv: Record<string, string | undefined>,
			platform: NodeJS.Platform = "linux",
		) {
			const { deps } = diskDeps({ env: callerEnv, platform });
			await installAutostart(
				deps,
				daemonPaths,
				daemonSpec({ dgHome: callerEnv.DG_HOME }),
			);
			return deps;
		}

		it("gives the kind when the unit records the DG_HOME of the caller", async () => {
			const deps = await installWith({ DG_HOME: dgHome() });

			expect(autostartManages(deps, daemonPaths, "dg-daemon")).toBe("systemd");
		});

		it("gives nothing when the unit file is absent", () => {
			expect(
				autostartManages(diskDeps().deps, daemonPaths, "dg-daemon"),
			).toBeUndefined();
		});

		it("gives nothing when the unit records a different DG_HOME", async () => {
			const deps = await installWith({ DG_HOME: "/a" });

			expect(
				autostartManages(
					{ ...deps, env: { DG_HOME: "/b" } },
					daemonPaths,
					"dg-daemon",
				),
			).toBeUndefined();
			expect(
				autostartManages({ ...deps, env: {} }, daemonPaths, "dg-daemon"),
			).toBeUndefined();
		});

		it("treats two unset DG_HOME values as equal", async () => {
			const deps = await installWith({});

			expect(autostartManages(deps, daemonPaths, "dg-daemon")).toBe("systemd");
			expect(
				autostartManages(
					{ ...deps, env: { DG_HOME: "/b" } },
					daemonPaths,
					"dg-daemon",
				),
			).toBeUndefined();
		});

		it("compares DG_HOME after it is made absolute, not as raw strings", async () => {
			const deps = await installWith({ DG_HOME: resolve("relative-dg-home") });

			expect(
				autostartManages(
					{ ...deps, env: { DG_HOME: "relative-dg-home" } },
					daemonPaths,
					"dg-daemon",
				),
			).toBe("systemd");
		});

		for (const platform of ["linux", "darwin"] as const) {
			it(`reads back a DG_HOME that holds %, ", &, $ and a backslash (${platform})`, async () => {
				const awkward = join(root, 'we%ird "dg" &<home> $x \\y');
				const deps = await installWith({ DG_HOME: awkward }, platform);

				expect(autostartManages(deps, daemonPaths, "dg-daemon")).toBe(
					platform === "linux" ? "systemd" : "launchd",
				);
			});
		}

		it("compares the four XDG_*_HOME values with the caller", async () => {
			const deps = await installWith({
				DG_HOME: dgHome(),
				XDG_DATA_HOME: "/x",
			});

			expect(autostartManages(deps, daemonPaths, "dg-daemon")).toBe("systemd");
			expect(
				autostartManages(
					{ ...deps, env: { ...deps.env, XDG_DATA_HOME: "/other" } },
					daemonPaths,
					"dg-daemon",
				),
			).toBeUndefined();
			expect(
				autostartManages(
					{ ...deps, env: { DG_HOME: dgHome() } },
					daemonPaths,
					"dg-daemon",
				),
			).toBeUndefined();
		});

		it("gives the task kind only for a caller with no DG_HOME, because a task unit records none", async () => {
			const deps = await installWith({}, "win32");

			expect(autostartManages(deps, daemonPaths, "dg-daemon")).toBe("task");
			expect(
				autostartManages(
					{ ...deps, env: { DG_HOME: dgHome() } },
					daemonPaths,
					"dg-daemon",
				),
			).toBeUndefined();
		});

		it("does not report the dg-phone unit as the dg-daemon unit", async () => {
			const { deps } = diskDeps();
			await installAutostart(deps, daemonPaths, {
				...GOLDEN_SPEC,
				dgHome: join(root, "dg"),
			});

			expect(autostartManages(deps, daemonPaths, "dg-daemon")).toBeUndefined();
			expect(autostartManages(deps, daemonPaths, "dg-phone")).toBe("systemd");
		});
	});
});

describe("autostartManages reader seam", () => {
	it("reads the unit text through deps.readFile, not the disk", () => {
		const { deps } = fakeDeps({
			platform: "linux",
			env: { DG_HOME: "/a" },
			readFile: () => 'Environment="DG_HOME=/a"\n',
		});

		expect(autostartManages(deps, paths, "dg-daemon")).toBe("systemd");
		expect(autostartManages({ ...deps, env: { DG_HOME: "/b" } }, paths, "dg-daemon")).toBeUndefined();
	});
});

describe("defaultAutostartDeps", () => {
	it("holds the real platform, home, env, uid and a runner that gives code 1 for a command that cannot spawn", async () => {
		const deps = defaultAutostartDeps();

		expect(deps.platform).toBe(process.platform);
		expect(deps.env).toBe(process.env);
		expect(deps.uid).toBe(process.getuid?.() ?? 0);
		const failed = await deps.run(["/dg-test/no/such/command"]);
		expect(failed.code).toBe(1);
		expect(failed.stdout).toBe("");
		expect(failed.stderr).not.toBe("");
		const ok = await deps.run([process.execPath, "-e", "console.log('hi')"]);
		expect(ok).toEqual({ code: 0, stdout: "hi\n", stderr: "" });
	});

	it("writes, tests for and removes a real file", () => {
		const dir = mkdtempSync(join(tmpdir(), "dg-default-deps-"));
		try {
			const deps = defaultAutostartDeps();
			const file = join(dir, "nested", "unit");

			deps.writeFile(file, "text", 0o600);
			expect(deps.fileExists(file)).toBe(true);
			expect(readFileSync(file, "utf8")).toBe("text");
			deps.removeFile(file);
			expect(deps.fileExists(file)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
