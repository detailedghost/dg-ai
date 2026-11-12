import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
import { type DgPaths, resolveDgPaths } from "@dg/common/node";
import { finishLauncherLayout, installPasswdHome, migrateBeforeInstall, pathHint } from "../src/install/layout";

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

	test("writes the launchers to the bin dir pointing at the data dir, the notice launchers, and the PATH line", () => {
		mkdirSync(join(paths.legacyHome, "bin"), { recursive: true });
		writeFileSync(join(paths.legacyHome, "bin", "dg-skills"), "old");

		finishLauncherLayout("1.34.2", {
			paths,
			envPath: "/usr/bin",
			log: (line) => lines.push(line),
		});

		expect(readFileSync(join(paths.binDir, "dg-skills"), "utf8")).toContain(`root='${paths.dataDir}'`);
		expect(
			readFileSync(join(paths.legacyHome, "bin", "dg-skills"), "utf8"),
		).toContain("removed in 1.36.0");
		expect(lines).toContain(
			`Add to PATH:  export PATH="${paths.binDir}:$PATH"`,
		);
	});

	test("creates no legacy home on a fresh machine", () => {
		finishLauncherLayout("1.34.2", {
			paths,
			envPath: paths.binDir,
			log: (line) => lines.push(line),
		});

		expect(existsSync(paths.legacyHome)).toBe(false);
		expect(lines).toEqual([]);
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
