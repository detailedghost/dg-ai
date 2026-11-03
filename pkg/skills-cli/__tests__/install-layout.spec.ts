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
import { join } from "node:path";
import { type DgPaths, resolveDgPaths } from "@dg/common/node";
import { finishLauncherLayout, pathHint } from "../src/install/layout";

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

		expect(readFileSync(join(paths.binDir, "dg-skills"), "utf8")).toContain(
			join(paths.dataDir, "lib", "current", "dg.js"),
		);
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
