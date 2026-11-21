import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DgPaths, resolveDgPaths } from "@dg/common/node";
import { PROGRAM_NAMES } from "@dg/common/node/program";
import {
	compatLauncherText,
	isCompatLauncher,
	removeCompatLaunchers,
} from "../src/install/compat-launchers";

const posix = describe.skipIf(process.platform === "win32");

let dir: string;
let home: string;
let paths: DgPaths;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dg-compat-"));
	home = join(dir, "home");
	paths = resolveDgPaths({ platform: "linux", homeDir: home, env: {} });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("compatLauncherText", () => {
	test("prints one notice line naming the new path and the removal release, then runs the new launcher", () => {
		const text = compatLauncherText(
			"dg-skills",
			"/home/u/.local/bin/dg-skills",
			"1.30.0",
			"linux",
		);

		expect(text).toBe(
			[
				"#!/bin/sh",
				"printf '%s\\n' 'dg: ~/.dg/bin/dg-skills is now /home/u/.local/bin/dg-skills; this path is removed in 1.30.0' >&2",
				"exec '/home/u/.local/bin/dg-skills' \"$@\"",
				"",
			].join("\n"),
		);
	});

	test("quotes a target with a single quote in it", () => {
		const text = compatLauncherText(
			"dg-agent",
			"/home/o'neil/.local/bin/dg-agent",
			"1.30.0",
			"darwin",
		);

		expect(text).toContain(
			"exec '/home/o'\\''neil/.local/bin/dg-agent' \"$@\"",
		);
	});

	test("writes a cmd file on Windows", () => {
		const text = compatLauncherText(
			"dg-skills",
			"C:\\L\\dg\\bin\\dg-skills.cmd",
			"1.30.0",
			"win32",
		);

		expect(text).toBe(
			[
				"@echo off",
				"echo dg: ~/.dg/bin/dg-skills is now C:\\L\\dg\\bin\\dg-skills.cmd; this path is removed in 1.30.0 1>&2",
				'"C:\\L\\dg\\bin\\dg-skills.cmd" %*',
				"",
			].join("\r\n"),
		);
	});

	test("escapes cmd metacharacters and percent signs in a Windows path", () => {
		const text = compatLauncherText("dg-skills", "C:\\A&B %X%\\dg-skills.cmd", "1.30.0", "win32");

		expect(text.split("\r\n").slice(1, 3)).toEqual([
			"echo dg: ~/.dg/bin/dg-skills is now C:\\A^&B %%X%%\\dg-skills.cmd; this path is removed in 1.30.0 1>&2",
			'"C:\\A&B %%X%%\\dg-skills.cmd" %*',
		]);
	});
});

const seedOldBin = (): string => {
	const bin = join(paths.legacyHome, "bin");
	mkdirSync(bin, { recursive: true });
	for (const name of PROGRAM_NAMES)
		writeFileSync(join(bin, name), compatLauncherText(name, join(paths.binDir, name), "1.30.0", "linux"), { mode: 0o755 });
	return bin;
};

describe("isCompatLauncher", () => {
	test("is true for a notice launcher whose replacement does not exist", () => {
		const bin = seedOldBin();

		expect(existsSync(paths.binDir)).toBe(false);
		for (const name of PROGRAM_NAMES) expect(isCompatLauncher(paths, name, "linux")).toBe(true);
		expect(readdirSync(bin).sort()).toEqual([...PROGRAM_NAMES].sort());
	});

	test("is false for a file that is not the notice text and for a missing file", () => {
		const bin = seedOldBin();
		writeFileSync(join(bin, "dg-skills"), "#!/bin/sh\necho mine\n");

		expect(isCompatLauncher(paths, "dg-skills", "linux")).toBe(false);
		expect(isCompatLauncher(paths, "dg-daemon.missing", "linux")).toBe(false);
	});
});

posix("removeCompatLaunchers", () => {
	test("removes the notice launchers and the legacy bin folder", () => {
		seedOldBin();

		removeCompatLaunchers(paths, "linux");

		expect(existsSync(paths.legacyHome)).toBe(false);
	});

	test("writes no launcher and no dg file", () => {
		const bin = seedOldBin();

		removeCompatLaunchers(paths, "linux");

		expect(existsSync(join(bin, "dg"))).toBe(false);
		for (const name of PROGRAM_NAMES) expect(existsSync(join(bin, name))).toBe(false);
	});

	test("leaves a legacy dg file and an old shim that are not notice launchers byte-identical", () => {
		const bin = seedOldBin();
		writeFileSync(join(bin, "dg"), "#!/bin/sh\necho other tool\n", { mode: 0o755 });
		writeFileSync(join(bin, "dg-agent"), "old shim", { mode: 0o755 });

		removeCompatLaunchers(paths, "linux");

		expect(readFileSync(join(bin, "dg"), "utf8")).toBe("#!/bin/sh\necho other tool\n");
		expect(statSync(join(bin, "dg")).mode & 0o777).toBe(0o755);
		expect(readFileSync(join(bin, "dg-agent"), "utf8")).toBe("old shim");
		expect(existsSync(join(bin, "dg-skills"))).toBe(false);
	});

	test("removes the version files left beside removed launchers and then the legacy home", () => {
		const bin = seedOldBin();
		for (const name of PROGRAM_NAMES) writeFileSync(join(bin, `${name}.version`), "1.28.1\n");

		removeCompatLaunchers(paths, "linux");

		expect(existsSync(paths.legacyHome)).toBe(false);
	});

	test("removes a legacy bin folder that holds only version files", () => {
		const bin = join(paths.legacyHome, "bin");
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "dg-skills.version"), "1.28.1\n");

		removeCompatLaunchers(paths, "linux");

		expect(existsSync(paths.legacyHome)).toBe(false);
	});

	test("leaves a file that is not from dg in the legacy bin folder", () => {
		const bin = join(paths.legacyHome, "bin");
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "dg-skills.version"), "1.28.1\n");
		writeFileSync(join(bin, "other"), "x");

		removeCompatLaunchers(paths, "linux");

		expect(readdirSync(bin)).toEqual(["other"]);
	});

	test("a second run changes nothing", () => {
		seedOldBin();
		removeCompatLaunchers(paths, "linux");

		expect(() => removeCompatLaunchers(paths, "linux")).not.toThrow();
		expect(existsSync(paths.legacyHome)).toBe(false);
	});

	test("creates nothing when there was no old install", () => {
		removeCompatLaunchers(paths, "linux");

		expect(existsSync(paths.legacyHome)).toBe(false);
	});

	test("removes the .cmd notice launchers on Windows", () => {
		const bin = join(paths.legacyHome, "bin");
		mkdirSync(bin, { recursive: true });
		for (const name of PROGRAM_NAMES)
			writeFileSync(join(bin, `${name}.cmd`), compatLauncherText(name, join(paths.binDir, `${name}.cmd`), "1.30.0", "win32"));

		removeCompatLaunchers(paths, "win32");

		expect(existsSync(paths.legacyHome)).toBe(false);
	});

	test("touches nothing when the old bin folder is the new bin folder under DG_HOME", () => {
		const root = join(dir, "dg-home");
		const flat = resolveDgPaths({
			platform: "linux",
			homeDir: home,
			env: { DG_HOME: root },
		});
		mkdirSync(flat.binDir, { recursive: true });
		writeFileSync(join(flat.binDir, "dg-skills"), "new shim", { mode: 0o755 });

		removeCompatLaunchers(flat, "linux");

		expect(readFileSync(join(flat.binDir, "dg-skills"), "utf8")).toBe("new shim");
	});
});
