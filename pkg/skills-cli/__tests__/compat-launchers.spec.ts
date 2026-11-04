import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DgPaths, resolveDgPaths } from "@dg/common/node";
import {
	compatLauncherText,
	removalRelease,
	syncCompatLaunchers,
} from "../src/install/compat-launchers";

const posix = describe.skipIf(process.platform === "win32");
const NAMES = ["dg-skills", "dg-agent", "dg-daemon"] as const;

let dir: string;
let home: string;
let paths: DgPaths;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dg-compat-"));
	home = join(dir, "home");
	paths = resolveDgPaths({ platform: "linux", homeDir: home, env: {} });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("removalRelease", () => {
	test("is two minor releases after the current version", () => {
		expect(removalRelease("1.28.3")).toBe("1.30.0");
		expect(removalRelease("1.34.2")).toBe("1.36.0");
		expect(removalRelease("2.9.0")).toBe("2.11.0");
	});
});

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

posix("syncCompatLaunchers", () => {
	function seedOldBin(): string {
		const bin = join(paths.legacyHome, "bin");
		mkdirSync(bin, { recursive: true });
		for (const name of NAMES)
			writeFileSync(join(bin, name), "old shim", { mode: 0o755 });
		return bin;
	}

	test("replaces the old launchers with notice launchers that name the removal release", () => {
		const bin = seedOldBin();

		syncCompatLaunchers(paths, "1.28.1");

		for (const name of NAMES) {
			const path = join(bin, name);
			expect(readFileSync(path, "utf8")).toBe(
				compatLauncherText(name, join(paths.binDir, name), "1.30.0", "linux"),
			);
			expect(statSync(path).mode & 0o777).toBe(0o755);
		}
	});

	test("keeps the first removal release on a later install", () => {
		const bin = seedOldBin();
		syncCompatLaunchers(paths, "1.28.1");

		syncCompatLaunchers(paths, "1.29.0");

		expect(readFileSync(join(bin, "dg-skills"), "utf8")).toContain(
			"removed in 1.30.0",
		);
	});

	test("removes the launchers once the installed version reaches the removal release", () => {
		const bin = seedOldBin();
		syncCompatLaunchers(paths, "1.28.1");

		syncCompatLaunchers(paths, "1.30.0");

		for (const name of NAMES) expect(existsSync(join(bin, name))).toBe(false);
		expect(existsSync(paths.legacyHome)).toBe(false);
	});

	test("creates nothing when there was no old install", () => {
		syncCompatLaunchers(paths, "1.28.1");

		expect(existsSync(paths.legacyHome)).toBe(false);
	});

	test("writes nothing when the old bin folder is the new bin folder under DG_HOME", () => {
		const root = join(dir, "dg-home");
		const flat = resolveDgPaths({
			platform: "linux",
			homeDir: home,
			env: { DG_HOME: root },
		});
		mkdirSync(flat.binDir, { recursive: true });
		writeFileSync(join(flat.binDir, "dg-skills"), "new shim", { mode: 0o755 });

		syncCompatLaunchers(flat, "1.28.1");

		expect(readFileSync(join(flat.binDir, "dg-skills"), "utf8")).toBe(
			"new shim",
		);
	});
});
