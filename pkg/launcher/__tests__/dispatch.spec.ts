import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildBundle, run } from "./bundle-fixtures";

function headRevision(): string {
	return Bun.spawnSync(["git", "rev-parse", "HEAD"], { stdout: "pipe" }).stdout.toString().trim();
}

const PROGRAMS = ["dg-skills", "dg-agent", "dg-daemon"];

describe("dg.js dispatcher", () => {
	const { bun, entry, lib } = buildBundle();

	test("dg-skills --version prints one stamped version line and exits 0", () => {
		const result = run(bun, entry, ["dg-skills", "--version"]);
		expect(result.exitCode).toBe(0);
		const lines = result.stdout.trim().split("\n");
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/^\S+$/);
		expect(lines[0]).not.toBe("dev");
	});

	test("every program answers --version with the same stamp", () => {
		const stamps = PROGRAMS.map((name) => run(bun, entry, [name, "--version"]).stdout.trim());
		expect(new Set(stamps).size).toBe(1);
		expect(stamps[0]).not.toBe("dev");
	});

	test("an unknown program exits 64 and names the three programs", () => {
		const result = run(bun, entry, ["nope"]);
		expect(result.exitCode).toBe(64);
		const output = result.stdout + result.stderr;
		for (const name of PROGRAMS) expect(output).toContain(name);
	});

	test("no program name exits 64 and names the three programs", () => {
		const result = run(bun, entry, []);
		expect(result.exitCode).toBe(64);
		const output = result.stdout + result.stderr;
		for (const name of PROGRAMS) expect(output).toContain(name);
	});

	test("arguments after the program name reach that program", () => {
		const result = run(bun, entry, ["dg-skills", "stash", "--help"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("stash");
	});

	test("the stamped version equals the skills-cli package version, not the commit", () => {
		const { version } = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "skills-cli", "package.json"), "utf8")) as {
			version: string;
		};
		for (const name of PROGRAMS) {
			expect(run(bun, entry, [name, "--version"]).stdout.trim()).toBe(version);
		}
	});

	test("build.json keeps the commit as separate metadata", () => {
		const meta = JSON.parse(readFileSync(join(lib, "build.json"), "utf8")) as { sha: string };
		expect(meta.sha).toBe(process.env.DG_BUILD_SHA ?? headRevision());
	});

	test("a name inherited from Object.prototype is not a program", () => {
		for (const name of ["toString", "constructor", "__proto__"]) {
			const result = run(bun, entry, [name]);
			expect(result.exitCode).toBe(64);
		}
	});
});
