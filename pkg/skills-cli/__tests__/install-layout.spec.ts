import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type DgPaths, resolveDgPaths } from "@dg/common/node";
import { PROGRAM_NAMES, compiledProgramPath } from "@dg/common/node/program";
import { compatLauncherText } from "../src/install/compat-launchers";
import { versionProgramPath } from "../src/install/compiled";
import { finishLauncherLayout, installPasswdHome, migrateBeforeInstall, pathHint } from "../src/install/layout";
import { oldShimText } from "./dg-launcher-fixtures";

const posix = describe.skipIf(process.platform === "win32");

describe("pathHint", () => {
	test("prints the PATH line when the bin dir is missing from PATH on Linux and macOS", () => {
		for (const platform of ["linux", "darwin"] as const) {
			expect(pathHint("/h/.local/bin", "/usr/bin:/bin", platform)).toBe(
				'Add to PATH:  export PATH="/h/.local/bin:$PATH"',
			);
		}
	});

	test("prints nothing when the bin dir is already on PATH", () => {
		expect(
			pathHint("/h/.local/bin", "/usr/bin:/h/.local/bin", "linux"),
		).toBeUndefined();
	});

	test("prints nothing on Windows, where bootstrap.ps1 edits the user PATH", () => {
		expect(pathHint("C:\\L\\dg\\bin", "C:\\Windows", "win32")).toBeUndefined();
	});
});

posix("finishLauncherLayout", () => {
	let dir: string;
	let paths: DgPaths;
	const lines: string[] = [];

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "dg-layout-"));
		paths = resolveDgPaths({
			platform: "linux",
			homeDir: join(dir, "home"),
			env: {},
		});
		lines.length = 0;
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const seams = () => ({ paths, home: join(dir, "home"), env: {} as Record<string, string> });

	test("links dg, removes the old shims, stamps and notice launchers, and prints the PATH line", async () => {
		mkdirSync(join(paths.legacyHome, "bin"), { recursive: true });
		const notice = compatLauncherText("dg-skills", join(paths.binDir, "dg-skills"), "1.36.0", "linux");
		writeFileSync(join(paths.legacyHome, "bin", "dg-skills"), notice);
		mkdirSync(paths.binDir, { recursive: true });
		for (const name of ["dg", "dg-skills", "dg-agent", "dg-daemon"]) {
			writeFileSync(join(paths.binDir, name), oldShimText(paths.dataDir, name));
			writeFileSync(join(paths.binDir, `.${name}.version`), "6.3.1");
		}

		await finishLauncherLayout("7.0.0", { ...seams(), envPath: "/usr/bin", log: (line) => lines.push(line) });

		expect(readlinkSync(join(paths.binDir, "dg"))).toBe(compiledProgramPath(paths.dataDir, "linux"));
		for (const name of PROGRAM_NAMES) {
			expect(existsSync(join(paths.binDir, name))).toBe(false);
			expect(existsSync(join(paths.binDir, `.${name}.version`))).toBe(false);
		}
		expect(existsSync(paths.legacyHome)).toBe(false);
		expect(lines).toEqual([`Add to PATH:  export PATH="${paths.binDir}:$PATH"`]);
	});

	test("creates no legacy home on a fresh machine", async () => {
		await finishLauncherLayout("7.0.0", { ...seams(), envPath: paths.binDir, log: (line) => lines.push(line) });

		expect(existsSync(paths.legacyHome)).toBe(false);
		expect(lines).toEqual([]);
	});

	test("a second run changes nothing", async () => {
		const opts = { ...seams(), envPath: paths.binDir, log: (line: string) => lines.push(line) };
		await finishLauncherLayout("7.0.0", opts);

		await finishLauncherLayout("7.0.0", opts);

		expect(readdirSync(paths.binDir)).toEqual(["dg"]);
		expect(lines).toEqual([]);
	});

	test("rewrites a hook command that runs dg-skills to <bin>/dg", async () => {
		const settings = join(dir, "home", ".claude", "settings.json");
		mkdirSync(dirname(settings), { recursive: true });
		writeFileSync(
			settings,
			JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `${paths.binDir}/dg-skills hooks run pr-prose` }] }] } }),
		);

		await finishLauncherLayout("7.0.0", { ...seams(), envPath: paths.binDir, log: () => {} });

		expect(readFileSync(settings, "utf8")).toContain(`${paths.binDir}/dg hooks run pr-prose`);
		expect(readFileSync(settings, "utf8")).not.toContain("dg-skills");
	});

	test("the bridge keeps the old .cmd files on win32 and writes dg.exe", async () => {
		mkdirSync(join(paths.dataDir, "bin", "7.0.0"), { recursive: true });
		writeFileSync(versionProgramPath(paths.dataDir, "7.0.0", "win32"), "MZ");
		mkdirSync(paths.binDir, { recursive: true });
		const cmd = `@echo off\r\n"${paths.dataDir}\\runtime\\current\\bun.exe" "${paths.dataDir}\\lib\\current\\dg.js" dg-skills %*\r\n`;
		writeFileSync(join(paths.binDir, "dg-skills.cmd"), cmd);

		await finishLauncherLayout("7.0.0", { ...seams(), platform: "win32", bridge: true, log: () => {} });

		expect(existsSync(join(paths.binDir, "dg-skills.cmd"))).toBe(true);
		expect(existsSync(join(paths.binDir, "dg.exe"))).toBe(true);

		await finishLauncherLayout("7.0.0", { ...seams(), platform: "win32", log: () => {} });

		expect(existsSync(join(paths.binDir, "dg-skills.cmd"))).toBe(false);
	});
});

posix("ssms allow config move", () => {
	let base: string;
	let passwd: string;
	let allowFile: string;
	let trusted: string;
	beforeEach(() => {
		base = mkdtempSync(join(tmpdir(), "dg-ssms-move-"));
		passwd = join(base, "passwd-home");
		allowFile = join(passwd, ".dg", "ssms", "config.yaml");
		trusted = join(passwd, ".config", "dg", "ssms", "config.yaml");
	});
	afterEach(() => rmSync(base, { recursive: true, force: true }));

	const putFile = (path: string, text: string) => {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, text);
	};
	const redirected = () =>
		resolveDgPaths({
			platform: "linux",
			homeDir: join(base, "sandbox"),
			env: { DG_HOME: join(base, "dg-home"), XDG_CONFIG_HOME: join(base, "xdg") },
		});

	test("moves the passwd home allow file to the passwd config folder when HOME, DG_HOME and XDG_CONFIG_HOME point elsewhere", async () => {
		putFile(allowFile, "allow_send: true\n");

		await migrateBeforeInstall(redirected(), () => {}, passwd);

		expect(readFileSync(trusted, "utf8")).toBe("allow_send: true\n");
		expect(existsSync(allowFile)).toBe(false);
		expect(existsSync(join(base, "xdg", "dg", "ssms", "config.yaml"))).toBe(false);
		expect(existsSync(join(base, "dg-home", "config", "ssms", "config.yaml"))).toBe(false);
	});

	test("moves the passwd home allow file when HOME is the passwd home and XDG_CONFIG_HOME points elsewhere", async () => {
		putFile(allowFile, "allow_send: true\n");
		const paths = resolveDgPaths({ platform: "linux", homeDir: passwd, env: { XDG_CONFIG_HOME: join(base, "xdg") } });

		await migrateBeforeInstall(paths, () => {}, passwd);

		expect(readFileSync(trusted, "utf8")).toBe("allow_send: true\n");
		expect(existsSync(join(base, "xdg", "dg", "ssms", "config.yaml"))).toBe(false);
	});

	test("never writes over an allow file that already exists in the passwd config folder", async () => {
		putFile(allowFile, "allow_send: true\n");
		putFile(trusted, "allow_send: false\n");
		const lines: string[] = [];

		await migrateBeforeInstall(redirected(), (line) => lines.push(line), passwd);

		expect(readFileSync(trusted, "utf8")).toBe("allow_send: false\n");
		expect(readFileSync(allowFile, "utf8")).toBe("allow_send: true\n");
		expect(lines).toContain(`dg: kept ${allowFile}; ${trusted} already exists`);
	});

	test("keeps the passwd home allow file while a process that writes the ssms folder runs", async () => {
		putFile(allowFile, "allow_send: true\n");
		putFile(join(passwd, ".dg", "ssms", "ssms.pid"), String(process.pid));

		await migrateBeforeInstall(redirected(), () => {}, passwd);

		expect(existsSync(trusted)).toBe(false);
		expect(readFileSync(allowFile, "utf8")).toBe("allow_send: true\n");
	});

	test("finds no passwd home under the test runner so spawned installs never reach the real account", () => {
		expect(installPasswdHome({ NODE_ENV: "test" }, () => "/home/ada")).toBeUndefined();
		expect(installPasswdHome({}, () => "/home/ada")).toBe("/home/ada");
	});
});
