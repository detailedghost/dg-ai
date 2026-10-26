import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { resolveDgPaths } from "@dg/common/node";
import { Command } from "commander";
import { phoneClose, phoneOpen, registerPhoneCommands, type OpenCloseDeps, type PhoneDeps } from "../../src/phone/commands";
import { PhoneDb } from "../../src/phone/db";
import type { KeyClient } from "../../src/phone/keys";
import { listenerPidPath } from "../../src/phone/listener";
import { DG_AGENT_PACKAGE_VERSION } from "../../src/version";
import { readListener } from "../../src/phone/store";
import { makeHomeTracker, parseNdjson } from "./fake-pool";

let tracker: ReturnType<typeof makeHomeTracker>;
let out: string[];
const NOW = Math.floor(Date.now() / 1000);

type Harness = {
	deps: OpenCloseDeps;
	written: { path: string; text: string | Uint8Array; mode?: number }[];
	removed: string[];
	ran: string[][];
	killed: { pid: number; signal: NodeJS.Signals }[];
	spawned: { argv: string[]; logPath: string; pid: number }[];
};

function lines(): unknown[] {
	return parseNdjson(out);
}

function freshHome(): string {
	return tracker.freshHome();
}

function harness(overrides: Partial<OpenCloseDeps> = {}): Harness {
	const paths = resolveDgPaths({ env: { DG_HOME: freshHome() } });
	const db = PhoneDb.open(paths, () => NOW);
	tracker.trackDb(db);
	const written: { path: string; text: string | Uint8Array; mode?: number }[] = [];
	const removed: string[] = [];
	const ran: string[][] = [];
	const killed: { pid: number; signal: NodeJS.Signals }[] = [];
	const spawned: { argv: string[]; logPath: string; pid: number }[] = [];
	const installed = new Set<string>();
	let nextPid = 5000;
	const deps: OpenCloseDeps = {
		paths,
		db,
		sessionClient: async () => undefined,
		grantClient: (): KeyClient => {
			throw new Error("no grant in file-mode tests");
		},
		createPool: () => {
			throw new Error("open/close never needs a relay pool");
		},
		write: (text) => out.push(text),
		readStdin: async () => undefined,
		now: () => NOW,
		platform: "linux",
		homeDir: "/home/u",
		env: {},
		uid: 501,
		writeFile: (path, text, mode) => {
			written.push({ path, text, mode });
			installed.add(path);
		},
		removeFile: (path) => {
			removed.push(path);
			installed.delete(path);
		},
		fileExists: (path) => installed.has(path),
		run: async (argv) => {
			ran.push(argv);
			if ((argv[0] === "systemctl" && argv.includes("disable")) || (argv[0] === "launchctl" && argv[1] === "bootout")) {
				rmSync(listenerPidPath(paths), { force: true });
			}
			return { code: 0, stdout: "", stderr: "" };
		},
		which: (name) => `/resolved${name.startsWith("/") ? name : `/${name}`}`,
		listenerArgv: (extra) => ["/fake/execPath", "phone", "__run", ...extra],
		spawnListener: (argv, logPath) => {
			const pid = nextPid;
			nextPid += 1;
			spawned.push({ argv, logPath, pid });
			return pid;
		},
		kill: (pid, signal) => {
			killed.push({ pid, signal });
			rmSync(listenerPidPath(paths), { force: true });
		},
		isOurListener: () => true,
		sleep: async () => {},
		...overrides,
	};
	return { deps, written, removed, ran, killed, spawned };
}

function unitText(value: string | Uint8Array | undefined): string {
	if (value === undefined) return "";
	if (typeof value === "string") return value;
	const bytes = Buffer.from(value);
	if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.toString("utf16le").replace(/^\uFEFF/, "");
	return bytes.toString("utf8");
}

function writeRunningPid(h: Harness, pid: number, hook: { argv: string[]; timeoutS: number } | null = null): void {
	writeFileSync(listenerPidPath(h.deps.paths), JSON.stringify({ pid, since: NOW, hook, version: DG_AGENT_PACKAGE_VERSION }));
}

/** Simulates the installed unit (or the fallback spawn) having actually started: writes `process.pid`
 * (never really signaled, since `kill` is faked) with the hook `open` just saved, so a following
 * `readListenerPid` sees a live listener the way it would once systemd or launchd gets around to it. */
function simulateListenerStarted(h: Harness, pid: number = process.pid): void {
	const onMessage = readListener(h.deps.db)?.onMessage;
	writeRunningPid(h, pid, onMessage ? { argv: onMessage.argv, timeoutS: Math.round(onMessage.timeoutMs / 1000) } : null);
}

beforeEach(() => {
	tracker = makeHomeTracker("dg-phone-opencl-");
	out = [];
});

afterEach(() => {
	tracker.cleanup();
});

describe("phoneOpen", () => {
	it("linux happy path: writes the systemd unit with the fake execPath, reloads then enables, and reports started", async () => {
		const h = harness();

		await phoneOpen({}, h.deps);

		expect(h.ran).toEqual([
			["systemctl", "--user", "daemon-reload"],
			["systemctl", "--user", "enable", "--now", "dg-phone.service"],
		]);
		expect(unitText(h.written[0]?.text)).toContain('ExecStart="/fake/execPath" "phone" "__run"');
		expect(lines()[0]).toEqual({ pid: null, status: "started", autostart: "systemd", hook: null });
	});

	it("darwin happy path: writes a plist with RunAtLoad and KeepAlive.SuccessfulExit false, bootstraps it", async () => {
		const h = harness({ platform: "darwin", homeDir: "/Users/u" });

		await phoneOpen({}, h.deps);

		expect(unitText(h.written[0]?.text)).toContain("<key>RunAtLoad</key>\n\t<true/>");
		expect(unitText(h.written[0]?.text)).toContain("<key>SuccessfulExit</key>\n\t\t<false/>");
		expect(h.ran.at(-1)).toEqual(["launchctl", "bootstrap", "gui/501", h.written[0]?.path]);
		expect(lines()[0]).toMatchObject({ status: "started", autostart: "launchd" });
	});

	it("win32 happy path: writes a task XML with a LogonTrigger and RestartOnFailure, creates then runs it", async () => {
		const h = harness({ platform: "win32" });

		await phoneOpen({}, h.deps);

		const taskBytes = h.written[0]?.text;
		expect(taskBytes).toBeInstanceOf(Uint8Array);
		const bytes = Buffer.from(taskBytes as Uint8Array);
		expect([bytes[0], bytes[1]]).toEqual([0xff, 0xfe]);
		expect(unitText(taskBytes)).toContain('encoding="UTF-16"');
		expect(Buffer.from(taskBytes as Uint8Array).toString("utf8").includes('encoding="UTF-16"')).toBe(false);
		expect(unitText(taskBytes)).toContain("<LogonTrigger>");
		expect(unitText(taskBytes)).toContain("<RestartOnFailure>");
		expect(h.ran).toEqual([
			["schtasks", "/End", "/TN", "dg-phone"],
			["schtasks", "/Create", "/TN", "dg-phone", "/XML", h.written[0]?.path, "/F"],
			["schtasks", "/Run", "/TN", "dg-phone"],
		]);
		expect(lines()[0]).toMatchObject({ status: "started", autostart: "task" });
	});

	it("resolves --on-message to an absolute path and round-trips a spaced, quoted argument through the unit", async () => {
		const h = harness();

		await phoneOpen({ onMessage: ["/usr/bin/notify", "a b", 'c"d'] }, h.deps);

		expect(unitText(h.written[0]?.text)).toContain('"--on-message" "/resolved/usr/bin/notify" "a b" "c\\"d" "--on-message-timeout" "30"');
		expect(lines()[0]).toMatchObject({ hook: "command" });
		expect(readListener(h.deps.db)?.onMessage).toEqual({ argv: ["/resolved/usr/bin/notify", "a b", 'c"d'], timeoutMs: 30_000 });
	});

	it("rejects an --on-message exe that which cannot find", async () => {
		const h = harness({ which: () => undefined });

		await expect(phoneOpen({ onMessage: ["ghost-notify"] }, h.deps)).rejects.toThrow("--on-message: ghost-notify not found on PATH");
	});

	it("installs autostart when a listener is already running but none was recorded", async () => {
		const h = harness();
		writeRunningPid(h, process.pid);

		await phoneOpen({}, h.deps);

		expect(h.killed).toEqual([{ pid: process.pid, signal: "SIGTERM" }]);
		expect(h.ran).toEqual([
			["systemctl", "--user", "daemon-reload"],
			["systemctl", "--user", "enable", "--now", "dg-phone.service"],
		]);
		expect(h.spawned).toEqual([]);
		expect(lines()[0]).toEqual({ pid: null, status: "restarted", autostart: "systemd", hook: null });
	});

	it("is idempotent: a second call with the same hook reports running and installs nothing new", async () => {
		const h = harness();

		await phoneOpen({ onMessage: ["/usr/bin/notify"] }, h.deps);
		simulateListenerStarted(h);
		out = [];
		h.ran.length = 0;
		const writesBefore = h.written.length;

		await phoneOpen({ onMessage: ["/usr/bin/notify"] }, h.deps);

		expect(h.ran).toEqual([]);
		expect(h.written).toHaveLength(writesBefore);
		expect(lines()[0]).toEqual({ pid: process.pid, status: "running", autostart: "systemd", hook: "command" });
	});

	it("reuses the saved hook when open is called again with no --on-message", async () => {
		const h = harness();
		await phoneOpen({ onMessage: ["/usr/bin/notify"] }, h.deps);
		simulateListenerStarted(h);
		out = [];
		h.ran.length = 0;

		await phoneOpen({}, h.deps);

		expect(lines()[0]).toMatchObject({ status: "running", hook: "command" });
	});

	it("stops the old listener and reinstalls when a live listener's hook does not match the requested one", async () => {
		const h = harness();
		await phoneOpen({ onMessage: ["/usr/bin/notify"] }, h.deps);
		simulateListenerStarted(h);
		out = [];
		h.ran.length = 0;

		await phoneOpen({ onMessage: ["/usr/bin/other-notify"] }, h.deps);

		expect(h.killed).toEqual([{ pid: process.pid, signal: "SIGTERM" }]);
		expect(h.ran).toEqual([
			["systemctl", "--user", "daemon-reload"],
			["systemctl", "--user", "enable", "--now", "dg-phone.service"],
		]);
		expect(lines()[0]).toEqual({ pid: null, status: "restarted", autostart: "systemd", hook: "command" });
		expect(readListener(h.deps.db)?.onMessage?.argv).toEqual(["/resolved/usr/bin/other-notify"]);
	});

	it("gives up and reports an error when the old listener never stops", async () => {
		const h = harness({ kill: () => {} });
		await phoneOpen({}, h.deps);
		simulateListenerStarted(h);

		await expect(phoneOpen({ onMessage: ["/usr/bin/notify"] }, h.deps)).rejects.toThrow(
			`the phone listener (pid ${process.pid}) did not stop`,
		);
	});

	it("treats a pid file whose process is not ours as stale: clears it and installs fresh instead of reporting running", async () => {
		const h = harness({ isOurListener: () => false });
		writeRunningPid(h, process.pid);

		await phoneOpen({}, h.deps);

		expect(h.killed).toEqual([]);
		expect(lines()[0]).toMatchObject({ status: "started", autostart: "systemd" });
	});

	it("restarts the previous listener when enable fails after the old listener was stopped", async () => {
		let failEnable = false;
		const h = harness({
			run: async (argv) => {
				h.ran.push(argv);
				if (failEnable && argv.includes("enable")) return { code: 1, stdout: "", stderr: "enable failed" };
				return { code: 0, stdout: "", stderr: "" };
			},
		});
		await phoneOpen({ onMessage: ["/usr/bin/notify"] }, h.deps);
		simulateListenerStarted(h);
		failEnable = true;
		h.spawned.length = 0;
		h.killed.length = 0;

		await expect(phoneOpen({ onMessage: ["/usr/bin/other"] }, h.deps)).rejects.toThrow(
			"systemctl --user enable --now dg-phone.service failed: enable failed",
		);

		expect(h.killed).toEqual([{ pid: process.pid, signal: "SIGTERM" }]);
		expect(h.spawned).toHaveLength(1);
		expect(h.spawned[0]?.argv).toEqual([
			"/fake/execPath",
			"phone",
			"__run",
			"--on-message",
			"/resolved/usr/bin/notify",
			"--on-message-timeout",
			"30",
		]);
		expect(readListener(h.deps.db)?.onMessage?.argv).toEqual(["/resolved/usr/bin/notify"]);
	});

	it("replaces an adopted legacy listener instead of treating it as the new one", async () => {
		const h = harness();
		writeFileSync(
			listenerPidPath(h.deps.paths),
			JSON.stringify({ pid: process.pid, since: NOW, hook: null, adopted: "legacy" }),
		);

		await phoneOpen({}, h.deps);

		expect(h.killed).toEqual([{ pid: process.pid, signal: "SIGTERM" }]);
		expect(lines()[0]).toMatchObject({ status: "restarted", autostart: "systemd" });
		expect(h.spawned).toEqual([]);
	});

	it("falls back to a detached spawn and reports unavailable when systemctl is not usable", async () => {
		const h = harness({
			run: async (argv) => {
				h.ran.push(argv);
				return argv[2] === "daemon-reload" ? { code: 1, stdout: "", stderr: "System has not been booted with systemd" } : { code: 0, stdout: "", stderr: "" };
			},
		});

		await phoneOpen({}, h.deps);

		expect(h.spawned).toHaveLength(1);
		expect(h.removed).toEqual([h.written[0]?.path]);
		expect(lines()[0]).toEqual({
			pid: h.spawned[0]?.pid,
			status: "started",
			autostart: "unavailable: System has not been booted with systemd",
			hook: null,
		});
	});
});

describe("phoneClose", () => {
	it("stops the listener, disables the unit, removes the file, and reports removed", async () => {
		const h = harness();
		await phoneOpen({}, h.deps);
		simulateListenerStarted(h);
		out = [];
		h.ran.length = 0;

		await phoneClose(h.deps);

		expect(h.killed).toEqual([{ pid: process.pid, signal: "SIGTERM" }]);
		expect(h.ran).toEqual([["systemctl", "--user", "disable", "--now", "dg-phone.service"]]);
		expect(lines()[0]).toEqual({ pid: process.pid, status: "closed", autostart: "removed" });
	});

	it("prints pid null and autostart absent when nothing is running or installed", async () => {
		const h = harness();

		await phoneClose(h.deps);

		expect(lines()[0]).toEqual({ pid: null, status: "closed", autostart: "absent" });
	});

	it("reports pid null and never tries to kill a pid file that is not ours", async () => {
		const h = harness({ isOurListener: () => false });
		writeRunningPid(h, process.pid);

		await phoneClose(h.deps);

		expect(h.killed).toEqual([]);
		expect(lines()[0]).toEqual({ pid: null, status: "closed", autostart: "absent" });
	});

	it("after a fallback spawn, kills that pid and reports autostart absent", async () => {
		const h = harness({
			run: async (argv) => {
				h.ran.push(argv);
				return argv[2] === "daemon-reload" ? { code: 1, stdout: "", stderr: "no systemd user bus" } : { code: 0, stdout: "", stderr: "" };
			},
		});
		await phoneOpen({}, h.deps);
		expect(h.spawned).toHaveLength(1);
		simulateListenerStarted(h);
		out = [];

		await phoneClose(h.deps);

		expect(lines()[0]).toEqual({ pid: process.pid, status: "closed", autostart: "absent" });
	});
});

describe("registerPhoneCommands", () => {
	it("dispatches `phone open` and `phone close` through commander, variadic --on-message included", async () => {
		const h = harness();
		const program = new Command();
		registerPhoneCommands(
			program,
			() => h.deps as PhoneDeps,
			() => h.deps,
		);
		program.exitOverride();

		await program.parseAsync(["phone", "open", "--on-message", "/usr/bin/notify", "a b"], { from: "user" });

		expect(lines()[0]).toMatchObject({ status: "started", hook: "command" });
		expect(readListener(h.deps.db)?.onMessage?.argv).toEqual(["/resolved/usr/bin/notify", "a b"]);

		out = [];
		await program.parseAsync(["phone", "close"], { from: "user" });

		expect(lines()[0]).toMatchObject({ status: "closed" });
	});
});
