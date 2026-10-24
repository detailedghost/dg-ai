import { describe, expect, it } from "bun:test";
import { DgCliError } from "@dg/common";
import { resolveDgPaths } from "@dg/common/node";
import {
	type AutostartDeps,
	type AutostartSpec,
	formatAutostartState,
	installAutostart,
	launchdPlistText,
	managedRestartCommands,
	removeAutostart,
	systemdUnitPath,
	systemdUnitText,
	windowsTaskXml,
	windowsTaskXmlBytes,
	windowsTaskXmlPath,
} from "../../src/phone/autostart";

const paths = resolveDgPaths({ platform: "linux", homeDir: "/home/u", env: {} });

function fakeDeps(overrides: Partial<AutostartDeps> = {}): {
	deps: AutostartDeps;
	written: { path: string; text: string | Uint8Array; mode?: number }[];
	removed: string[];
	ran: string[][];
} {
	const written: { path: string; text: string | Uint8Array; mode?: number }[] = [];
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

function recordingRun(ran: string[][], codeFor: (argv: string[]) => { code: number; stderr?: string; stdout?: string }) {
	return async (argv: string[]) => {
		ran.push(argv);
		const result = codeFor(argv);
		return { code: result.code, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
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
		if (execStart[i] !== '"') throw new Error(`expected a quote at ${i} in ${execStart}`);
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

const spec: AutostartSpec = { argv: ["/fake/execPath", "/fake/src/index.ts", "phone", "__run"], logPath: "/home/u/.dg/phone/listener.log" };

describe("systemdUnitText", () => {
	it("matches the expected unit snapshot for a fake execPath", () => {
		expect(systemdUnitText(spec)).toBe(
			[
				"[Unit]",
				"Description=dg phone listener",
				"",
				"[Service]",
				'ExecStart="/fake/execPath" "/fake/src/index.ts" "phone" "__run"',
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
		expect(systemdUnitText({ ...spec, dgHome: "/custom/dg" })).toContain('Environment="DG_HOME=/custom/dg"');
		expect(systemdUnitText(spec)).not.toContain("Environment=");
	});

	it("round-trips an --on-message exe with a space and an embedded quote through ExecStart's quoting", () => {
		const argv = ["/fake/execPath", "phone", "__run", "--on-message", "/usr/bin/notify", "a b", 'c"d'];
		const text = systemdUnitText({ argv, logPath: "" });
		const execStart = text.split("\n").find((line) => line.startsWith("ExecStart="))?.slice("ExecStart=".length) ?? "";

		expect(unquoteSystemdExecStart(execStart)).toEqual(argv);
	});

	it("doubles a literal percent or dollar so systemd does not expand it as a specifier or variable", () => {
		const text = systemdUnitText({ argv: ["/exe", "100%", "$HOME"], logPath: "" });

		expect(text).toContain('ExecStart="/exe" "100%%" "$$HOME"');
	});
});

describe("systemdUnitPath", () => {
	it("defaults to ~/.config/systemd/user and honors XDG_CONFIG_HOME", () => {
		expect(systemdUnitPath("/home/u", {})).toBe("/home/u/.config/systemd/user/dg-phone.service");
		expect(systemdUnitPath("/home/u", { XDG_CONFIG_HOME: "/custom/config" })).toBe("/custom/config/systemd/user/dg-phone.service");
	});
});

describe("launchdPlistText", () => {
	it("holds RunAtLoad, a restart-on-failure KeepAlive, and every argv element", () => {
		const text = launchdPlistText(spec);

		expect(text).toContain("<key>RunAtLoad</key>\n\t<true/>");
		expect(text).toContain("<key>KeepAlive</key>\n\t<dict>\n\t\t<key>SuccessfulExit</key>\n\t\t<false/>\n\t</dict>");
		for (const arg of spec.argv) expect(text).toContain(`<string>${arg}</string>`);
		expect(text).toContain(`<string>${spec.logPath}</string>`);
	});

	it("escapes XML metacharacters in an argv element", () => {
		const text = launchdPlistText({ argv: ["a&b<c>"], logPath: "" });

		expect(text).toContain("<string>a&amp;b&lt;c&gt;</string>");
	});
});

describe("windowsTaskXml", () => {
	it("holds a LogonTrigger and RestartOnFailure, and quotes the arguments CommandLineToArgvW-style", () => {
		const text = windowsTaskXml({
			argv: ["C:\\dg\\dg-agent.exe", "phone", "__run", "--on-message", "C:\\Program Files\\notify.exe", "a b", 'c"d'],
			logPath: "",
		});

		expect(text).toContain("<LogonTrigger>");
		expect(text).toContain("<RestartOnFailure>\n\t\t\t<Interval>PT1M</Interval>\n\t\t\t<Count>10</Count>\n\t\t</RestartOnFailure>");
		expect(text).toContain("<Command>C:\\dg\\dg-agent.exe</Command>");
		expect(text).toContain('<Arguments>phone __run --on-message "C:\\Program Files\\notify.exe" "a b" "c\\"d"</Arguments>');
		expect(text).not.toContain("--dg-home");
	});

	it("passes DG_HOME as --dg-home after __run, because a task has no environment block", () => {
		const text = windowsTaskXml({
			argv: ["C:\\dg\\dg-agent.exe", "phone", "__run", "--on-message", "C:\\Program Files\\notify.exe"],
			dgHome: "D:\\custom dg&home",
			logPath: "",
		});

		expect(text).toContain('<Arguments>phone __run --dg-home "D:\\custom dg&amp;home" --on-message "C:\\Program Files\\notify.exe"</Arguments>');
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
		expect(windowsTaskXmlPath(paths)).toBe(`${paths.phoneRoot}/dg-phone.task.xml`);
	});
});

describe("installAutostart", () => {
	it("linux happy path: writes the unit then runs daemon-reload and enable --now in order", async () => {
		const ran: string[][] = [];
		const { deps, written } = fakeDeps({ run: recordingRun(ran, () => ({ code: 0 })) });

		const outcome = await installAutostart(deps, paths, spec);

		expect(outcome).toEqual({ ok: true, kind: "systemd" });
		expect(written[0]?.path).toBe("/home/u/.config/systemd/user/dg-phone.service");
		expect(ran).toEqual([
			["systemctl", "--user", "daemon-reload"],
			["systemctl", "--user", "enable", "--now", "dg-phone.service"],
		]);
	});

	it("linux: a failing daemon-reload means systemd user is unavailable, removes the unit, and reports the first stderr line", async () => {
		const ran: string[][] = [];
		const { deps, removed, written } = fakeDeps({
			run: recordingRun(ran, (argv) =>
				argv[2] === "daemon-reload" ? { code: 1, stderr: "Failed to connect to bus: no such file or directory\nmore detail" } : { code: 0 },
			),
		});

		const outcome = await installAutostart(deps, paths, spec);

		expect(outcome).toEqual({ ok: false, reason: "Failed to connect to bus: no such file or directory" });
		expect(removed).toEqual([written[0]?.path]);
		expect(ran).toEqual([["systemctl", "--user", "daemon-reload"]]);
	});

	it("linux: a failing enable --now after a working daemon-reload is a real error, not unavailability, and removes the unit", async () => {
		const ran: string[][] = [];
		const { deps, removed, written } = fakeDeps({
			run: recordingRun(ran, (argv) => (argv[2] === "enable" ? { code: 1, stderr: "Unit dg-phone.service has a bad unit file" } : { code: 0 })),
		});

		await expect(installAutostart(deps, paths, spec)).rejects.toBeInstanceOf(DgCliError);
		expect(removed).toEqual([written[0]?.path]);
	});

	it("darwin happy path: writes the plist, boots it out best-effort, then bootstraps it", async () => {
		const ran: string[][] = [];
		const { deps, written } = fakeDeps({ platform: "darwin", homeDir: "/Users/u", run: recordingRun(ran, () => ({ code: 0 })) });

		const outcome = await installAutostart(deps, paths, spec);

		expect(outcome).toEqual({ ok: true, kind: "launchd" });
		expect(written[0]?.path).toBe("/Users/u/Library/LaunchAgents/com.detailedghost.dg-phone.plist");
		expect(ran).toEqual([
			["launchctl", "bootout", "gui/501/com.detailedghost.dg-phone"],
			["launchctl", "bootstrap", "gui/501", written[0]?.path ?? ""],
		]);
	});

	it("darwin: a failing bootstrap removes the plist and reports unavailable", async () => {
		const ran: string[][] = [];
		const { deps, removed } = fakeDeps({
			platform: "darwin",
			run: recordingRun(ran, (argv) => (argv[1] === "bootstrap" ? { code: 1, stderr: "not permitted" } : { code: 0 })),
		});

		const outcome = await installAutostart(deps, paths, spec);

		expect(outcome).toEqual({ ok: false, reason: "not permitted" });
		expect(removed).toHaveLength(1);
	});

	it("win32 happy path: ends any running task first, then writes the task xml, creates it, then runs it", async () => {
		const ran: string[][] = [];
		const { deps, written } = fakeDeps({ platform: "win32", run: recordingRun(ran, () => ({ code: 0 })) });

		const outcome = await installAutostart(deps, paths, spec);

		expect(outcome).toEqual({ ok: true, kind: "task" });
		expect(ran).toEqual([
			["schtasks", "/End", "/TN", "dg-phone"],
			["schtasks", "/Create", "/TN", "dg-phone", "/XML", written[0]?.path ?? "", "/F"],
			["schtasks", "/Run", "/TN", "dg-phone"],
		]);
	});

	it("win32: a failing Create removes the task xml and reports unavailable, ignoring a failed End", async () => {
		const ran: string[][] = [];
		const { deps, removed } = fakeDeps({
			platform: "win32",
			run: recordingRun(ran, (argv) => (argv[1] === "/Create" ? { code: 1, stderr: "Access is denied." } : { code: 1 })),
		});

		const outcome = await installAutostart(deps, paths, spec);

		expect(outcome).toEqual({ ok: false, reason: "Access is denied." });
		expect(removed).toHaveLength(1);
	});

	it("win32: a failing Run after a working Create deletes the registered task and removes the task xml", async () => {
		const ran: string[][] = [];
		const { deps, removed, written } = fakeDeps({
			platform: "win32",
			run: recordingRun(ran, (argv) => (argv[1] === "/Run" ? { code: 1, stderr: "task not found" } : { code: 0 })),
		});

		await expect(installAutostart(deps, paths, spec)).rejects.toBeInstanceOf(DgCliError);
		expect(ran.map((argv) => argv[1])).toEqual(["/End", "/Create", "/Run", "/Delete"]);
		expect(removed).toEqual([written[0]?.path]);
	});

	it("win32: keeps the task xml when deleting the registered task after a failed Run also fails", async () => {
		const ran: string[][] = [];
		const { deps, removed } = fakeDeps({
			platform: "win32",
			run: recordingRun(ran, (argv) => (argv[1] === "/Run" || argv[1] === "/Delete" ? { code: 1, stderr: "access denied" } : { code: 0 })),
		});

		await expect(installAutostart(deps, paths, spec)).rejects.toBeInstanceOf(DgCliError);
		expect(ran.map((argv) => argv[1])).toEqual(["/End", "/Create", "/Run", "/Delete"]);
		expect(removed).toEqual([]);
	});

	it("reports an unsupported platform as unavailable without writing anything", async () => {
		const { deps, written } = fakeDeps({ platform: "freebsd" as NodeJS.Platform });

		const outcome = await installAutostart(deps, paths, spec);

		expect(outcome).toEqual({ ok: false, reason: 'unsupported platform "freebsd"' });
		expect(written).toEqual([]);
	});
});

describe("removeAutostart", () => {
	it("reports absent and touches nothing when no unit file exists", async () => {
		const ran: string[][] = [];
		const { deps, removed } = fakeDeps({ fileExists: () => false, run: recordingRun(ran, () => ({ code: 0 })) });

		const outcome = await removeAutostart(deps, paths);

		expect(outcome).toBe("absent");
		expect(ran).toEqual([]);
		expect(removed).toEqual([]);
	});

	it("disables the unit and removes the file when one exists", async () => {
		const ran: string[][] = [];
		const { deps, removed } = fakeDeps({ run: recordingRun(ran, () => ({ code: 0 })) });

		const outcome = await removeAutostart(deps, paths);

		expect(outcome).toBe("removed");
		expect(ran).toEqual([["systemctl", "--user", "disable", "--now", "dg-phone.service"]]);
		expect(removed).toEqual(["/home/u/.config/systemd/user/dg-phone.service"]);
	});
});

describe("managedRestartCommands", () => {
	it("restarts each manager in place", () => {
		expect(managedRestartCommands("systemd", 501)).toEqual([["systemctl", "--user", "restart", "dg-phone.service"]]);
		expect(managedRestartCommands("launchd", 501)).toEqual([["launchctl", "kickstart", "-k", "gui/501/com.detailedghost.dg-phone"]]);
		expect(managedRestartCommands("task", 0)).toEqual([
			["schtasks", "/End", "/TN", "dg-phone"],
			["schtasks", "/Run", "/TN", "dg-phone"],
		]);
	});
});

describe("formatAutostartState", () => {
	it("is null when nothing was ever installed, the kind when it was, and prefixes an unavailable reason", () => {
		expect(formatAutostartState(undefined)).toBeNull();
		expect(formatAutostartState({ kind: "systemd" })).toBe("systemd");
		expect(formatAutostartState({ kind: "unavailable", reason: "no systemd user bus" })).toBe("unavailable: no systemd user bus");
	});
});
